/**
 * core/server.ts — HTTP + WebSocket-Server, Lifecycle, Cron, Broadcast
 *
 * Übernommen aus `src/index.ts` (Refactoring Phase 1.2 / W1, Step 5).
 * Wörtliche Migration — nur Importe + State-Zugriffe (`config` → `runtime.config` etc.).
 * Logik, Typen und `as any`-Casts bleiben unverändert (R1/R4).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { randomBytes } from "node:crypto";

import { runtime } from "../state.js";
import { logger } from "../logger.js";
import { startRpc, stopRpc, isAgentRunning, sendRpc } from "./rpc.js";
import { updateStatus } from "./status-footer.js";
import { isDaemonMode } from "./daemon.js";
import { initializeAdapters } from "../adapters/registry.js";
import type { BaseAdapter } from "../adapters/base.js";
import type { TelegramAdapter } from "../adapters/telegram.js";
import { listActiveChannels, listSessions, touchSession } from "../sessions/store.js";
import {
	startBackgroundTask,
	listTasks,
	getPendingResultsForSession,
	markTaskDelivered,
} from "../background/manager.js";
import { listAllowlistedUsers, listPendingPairingCodes } from "../security/auth.js";

/** Narrow a BaseAdapter reference to a TelegramAdapter (has a webhook handler).
 *  Lets the HTTP webhook router call telegram.handleWebhookUpdate without a
 *  blind `as any` cast on the untyped adapter map. */
function isTelegramAdapter(adapter: BaseAdapter | undefined): adapter is TelegramAdapter {
	return !!adapter && "handleWebhookUpdate" in adapter;
}

// Token auth
function verifyToken(token: string): boolean {
	if (runtime.config.tokens.length === 0) return true;
	return runtime.config.tokens.includes(token);
}

function authenticate(req: IncomingMessage): boolean {
	const auth = req.headers.authorization;
	if (!auth) return verifyToken("");
	if (auth.startsWith("Bearer ")) return verifyToken(auth.slice(7));
	return false;
}

// WebSocket helpers
function sendWs(ws: WebSocket, msg: object): void {
	if (ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify(msg));
	}
}

export function broadcastClients(event: string, data: unknown): void {
	for (const ws of runtime.state.clients.values()) {
		sendWs(ws, { type: event, data });
	}
}

// Cron job for background tasks and session cleanup
function startCron(): void {
	runtime.cronInterval = setInterval(async () => {
		// Check for pending background results
		for (const session of runtime.state.sessions.values()) {
			const pending = getPendingResultsForSession(session.id);
			for (const task of pending) {
				// Deliver result to user via their platform
				const adapter = runtime.state.adapters.get(session.platform);
				if (adapter) {
					const resultText =
						task.status === "completed"
							? `✅ Background task completed:\n\`\`\`\n${JSON.stringify(task.result, null, 2)}\n\`\`\``
							: `❌ Background task failed:\n\`\`\`\n${task.error}\n\`\`\``;

					await adapter.sendMessage(session.channelId, resultText);
					markTaskDelivered(task.id);
				}
			}
		}

		// Touch active sessions
		for (const session of runtime.state.sessions.values()) {
			touchSession(session.id);
		}
	}, 60000); // Every 60 seconds (Hermes-style)
}

function stopCron(): void {
	if (runtime.cronInterval) {
		clearInterval(runtime.cronInterval);
		runtime.cronInterval = null;
	}
}

// HTTP handlers
export async function handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
	res.setHeader("Access-Control-Allow-Origin", runtime.config.corsOrigins.join(",") || "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

	if (req.method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return;
	}

	// ── Telegram webhook (unauthenticated — called by Telegram) ──
	const url = new URL(req.url || "/", `http://${req.headers.host}`);
	if (url.pathname === "/webhook/telegram" && req.method === "POST") {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", async () => {
			try {
				const body = JSON.parse(Buffer.concat(chunks).toString());
				const adapter = runtime.state.adapters.get("telegram");
				const telegram = isTelegramAdapter(adapter) ? adapter : null;
				if (telegram) {
					await telegram.handleWebhookUpdate(body);
					res.writeHead(200);
					res.end("ok");
				} else {
					res.writeHead(503);
					res.end("Telegram adapter not running");
				}
			} catch {
				res.writeHead(400);
				res.end("Invalid request");
			}
		});
		return;
	}

	if (!authenticate(req)) {
		res.writeHead(401);
		res.end(JSON.stringify({ error: "Unauthorized" }));
		return;
	}

	// API endpoints
	if (url.pathname === "/api/status" && req.method === "GET") {
		const mediaStats = runtime.media ? await runtime.media.stats() : null;
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({
				running: runtime.state.running,
				mode: isDaemonMode ? "daemon" : "inline",
				pid: process.pid,
				adapters: Array.from(runtime.state.adapters.keys()),
				clients: runtime.state.clients.size,
				sessions: runtime.state.sessions.size,
				agent: isAgentRunning(),
				// Phase 3 (S6, §14): media store stats.
				media: mediaStats
					? {
							enabled: runtime.config.media?.enabled ?? true,
							fileCount: mediaStats.fileCount,
							totalBytes: mediaStats.totalBytes,
							oldestAt: mediaStats.oldestAt,
						}
					: null,
			}),
		);
		return;
	}

	if (url.pathname === "/api/sessions" && req.method === "GET") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(listSessions()));
		return;
	}

	if (url.pathname === "/api/background" && req.method === "GET") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(listTasks()));
		return;
	}

	if (url.pathname === "/api/allowlist" && req.method === "GET") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(listAllowlistedUsers()));
		return;
	}

	if (url.pathname === "/api/pairing" && req.method === "GET") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(listPendingPairingCodes()));
		return;
	}

	res.writeHead(404);
	res.end(JSON.stringify({ error: "Not found" }));
}

// WebSocket handler
export function handleWebSocket(ws: WebSocket, req: IncomingMessage): void {
	if (!authenticate(req)) {
		ws.close(1008, "Unauthorized");
		return;
	}

	const clientId = randomBytes(8).toString("hex");
	runtime.state.clients.set(clientId, ws);

	logger.info(`[gateway] WebSocket client connected: ${clientId}`);

	sendWs(ws, { type: "connected", data: { clientId } });

	ws.on("message", async (data) => {
		try {
			const msg = JSON.parse(data.toString());

			switch (msg.type) {
				case "prompt": {
					const result = await sendRpc("prompt", {
						message: msg.data?.message || "",
					});
					sendWs(ws, { type: "response", id: msg.id, data: result });
					break;
				}
				case "background": {
					const task = startBackgroundTask(
						msg.data?.sessionId || "default",
						msg.data?.command || "",
					);
					sendWs(ws, { type: "background_started", data: task });
					break;
				}
				case "ping": {
					sendWs(ws, { type: "pong", data: { time: Date.now() } });
					break;
				}
			}
		} catch (err) {
			sendWs(ws, { type: "error", data: { error: String(err) } });
		}
	});

	ws.on("close", () => {
		runtime.state.clients.delete(clientId);
		logger.info(`[gateway] WebSocket client disconnected: ${clientId}`);
	});
}

export async function startGatewayServer(port: number): Promise<void> {
	if (runtime.state.running) {
		logger.info("[gateway] Server already running");
		return;
	}

	runtime.server = createServer(handleHttpRequest);

	await new Promise<void>((resolve, reject) => {
		runtime.server!.listen(port, runtime.config.host, () => {
			logger.info(`[gateway] HTTP server started on ${runtime.config.host}:${port}`);
			resolve();
		});
		runtime.server!.on("error", reject);
	});

	if (runtime.config.enableWebSocket) {
		runtime.wss = new WebSocketServer({ server: runtime.server });
		runtime.wss.on("connection", handleWebSocket);
	}

	// Register broadcast hook so core/rpc.ts can broadcast to WS clients
	runtime.hooks.broadcast = broadcastClients;
	runtime.rpcProcess = startRpc();
	await initializeAdapters();
	startCron();
	runtime.state.running = true;
	await updateStatus();
}

export async function stopGatewayServer(): Promise<void> {
	if (!runtime.state?.running && !runtime.server && !isAgentRunning()) return;
	runtime.state.running = false;

	// Send shutdown message to all active chat channels before stopping
	for (const row of listActiveChannels()) {
		const adapter = runtime.state.adapters.get(row.platform);
		if (adapter) {
			adapter
				.sendMessage(row.channelId, "🔌 Gateway daemon is shutting down…")
				.catch(() => {});
		}
	}

	await Promise.allSettled(
		Array.from(runtime.state.adapters.values(), (adapter) => adapter.stop()),
	);
	runtime.state.adapters.clear();

	stopCron();

	for (const ws of runtime.state.clients.values()) {
		ws.close(1000, "Server shutting down");
	}
	runtime.state.clients.clear();

	const serverToClose = runtime.server;
	const webSocketServerToClose = runtime.wss;
	runtime.server = null;
	runtime.wss = null;
	try {
		webSocketServerToClose?.close();
	} catch {
		/* server was never listening */
	}
	if (serverToClose) {
		await new Promise<void>((resolve) => {
			serverToClose.close(() => resolve());
		});
	}

	stopRpc();

	void updateStatus();
}
