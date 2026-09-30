/**
 * E2E-Test — Streaming-Modus / Single-Shot-Steuerung
 * (docs/concept-streaming-edit-delivery-gap.md §Design, 2026-09-30).
 *
 * Hintergrund: Nextcloud Talk feuert bei Edits keinen Bot-Webhook (verifiziert
 * 2026-09-30, Doku + BotService.php) — Webhook-Bots in einem Raum (z. B. Pepe)
 * erhalten von einer gestreamten Antwort nur den Platzhalter, nie den
 * Endtext. Single-Shot-Kanäle senden den fertigen Text daher als eine neue
 * sendMessage (neue Message-ID → zustellbar).
 *
 * Ziel:
 * - `singleShotRooms`-Kanal (Label `gateway:<platform>:<channelId>`):
 *   KEIN Platzhalter, KEINE Edits, Final-Text als genau eine neue sendMessage.
 * - Default-Kanal (nicht gelistet): Streaming wie bisher (Platzhalter +
 *   Final-Edit) — Regressionsschutz.
 * - `platforms.<p>.streaming = false`: Single-Shot plattformweit (Raum nicht in
 *   singleShotRooms).
 * - `isStreamingEnabled`: Priorität (Raum-Override > Plattform-Flag > Default).
 *
 * Methodik (wie `anti-bot-loop-group.test.ts`, bewusst maximal echt):
 * - ECHT: NextcloudTalkAdapter inkl. TalkPoller (Long-Poll) + message-pipeline
 *   (`adapterCallbacks.onMessage`).
 * - MOCKED: ausschließlich die Agent-RPC-Schicht (`src/core/rpc.js`) und
 *   Nextcloud selbst (lokaler `node:http`-Mock).
 * - NON-VACUITY: jeder Test verifiziert, dass die relevante Message tatsächlich
 *   in einem Poll-Batch geliefert wurde — sonst wäre ein grüner Test wertlos.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { adapterCallbacks, isStreamingEnabled } from "../../src/core/message-pipeline.js";
import { runtime, initRuntime } from "../../src/state.js";
import { GATEWAY_CONFIG_FILE } from "../../src/paths.js";
import {
	NextcloudTalkAdapter,
	type NextcloudTalkConfig,
} from "../../src/adapters/nextcloud-talk.js";
import type { TalkChatMessage } from "../../src/adapters/nextcloud/talk-types.js";
import { freshSecurityStore, freshSessionStore } from "../helpers.js";

// ── Mock der Agent-RPC-Schicht (einziger gemockter Layer) ───────────────────

const rpcMock = vi.hoisted(() => ({
	agentRunning: true,
	responseText: "Antwort vom Agenten.",
	promptCalls: [] as Array<{ message: string; sessionId: string }>,
}));

vi.mock("../../src/core/rpc.js", () => ({
	isAgentRunning: () => rpcMock.agentRunning,
	sendPromptRpc: async (
		message: string,
		sessionId: string,
		_imagesOrCb?: unknown,
		onStreamArg?: (t: string) => void,
): Promise<string> => {
		const onStream =
			typeof _imagesOrCb === "function" ? (_imagesOrCb as (t: string) => void) : onStreamArg;
		rpcMock.promptCalls.push({ message, sessionId });
		await new Promise((r) => setTimeout(r, 5));
		onStream?.("Teilantwort…");
		return rpcMock.responseText;
	},
	sendRpc: async () => ({ success: true }),
	startRpc: () => {
		throw new Error("startRpc ist in Tests nicht verfügbar");
	},
	stopRpc: () => {},
	restartRpc: () => {},
	peekActiveCompletion: () => null,
	resetActiveStream: () => {},
}));

// ── Mock-Nextcloud (lokaler HTTP-Server, OCS-Chat-API) ──────────────────────

interface MockRoom {
	token: string;
	messages: TalkChatMessage[];
	waiters: Set<() => void>;
}

class MockNextcloud {
	readonly botUserId = "pi-bot";
	readonly appToken = "test-token-42";

	sentMessages: Array<{ room: string; id: number; text: string; at: number }> = [];
	edits: Array<{ room: string; id: number; text: string; at: number }> = [];
	deliveredBatches: Array<{ room: string; ids: number[]; at: number }> = [];
	pollQueries: Array<{ room: string; lastKnownMessageId: number }> = [];

	private server: Server | null = null;
	private port = 0;
	private rooms = new Map<string, MockRoom>();
	private nextMsgId = 100;
	private closing = false;

	get baseUrl(): string {
		return `http://127.0.0.1:${this.port}`;
	}

	async start(): Promise<void> {
		this.server = createServer((req, res) => {
			this.#handle(req, res).catch((err: unknown) => {
				if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: String(err) }));
			});
		});
		await new Promise<void>((resolve, reject) => {
			this.server?.once("error", reject);
			this.server?.listen(0, "127.0.0.1", () => resolve());
		});
		this.port = (this.server?.address() as AddressInfo | undefined)?.port ?? 0;
	}

	async stop(): Promise<void> {
		this.closing = true;
		for (const room of this.rooms.values()) this.#wake(room);
		const server = this.server;
		this.server = null;
		if (!server) return;
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	addRoom(token: string): void {
		this.rooms.set(token, { token, messages: [], waiters: new Set() });
	}

	postMessage(
		roomToken: string,
		input: Partial<Omit<TalkChatMessage, "id" | "token">> & { actorId?: string },
	): TalkChatMessage {
		const room = this.rooms.get(roomToken);
		if (!room) throw new Error(`Unbekannter Raum: ${roomToken}`);
		const msg: TalkChatMessage = {
			id: ++this.nextMsgId,
			token: roomToken,
			actorType: input.actorType ?? "users",
			actorId: input.actorId ?? "unknown",
			actorDisplayName: input.actorDisplayName ?? input.actorId ?? "unknown",
			timestamp: input.timestamp ?? Math.floor(Date.now() / 1000),
			systemMessage: input.systemMessage ?? "",
			messageType: input.messageType ?? "comment",
			message: input.message ?? "",
			messageParameters: input.messageParameters ?? {},
		};
		room.messages.push(msg);
		this.#wake(room);
		return msg;
	}

	#wake(room: MockRoom): void {
		const waiters = [...room.waiters];
		room.waiters.clear();
		for (const wake of waiters) wake();
	}

	async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const expectedAuth = `Basic ${Buffer.from(`${this.botUserId}:${this.appToken}`).toString("base64")}`;
		if (req.headers.authorization !== expectedAuth) {
			res.writeHead(401, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ocs: { meta: { statuscode: 997 } } }));
			return;
		}
		const p = decodeURIComponent(url.pathname);

		if (req.method === "GET" && p === "/ocs/v2.php/apps/spreed/api/v4/room") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					ocs: {
						meta: { statuscode: 100, status: "OK" },
						data: [...this.rooms.values()].map((r) => ({
							token: r.token,
							type: 3,
							displayName: r.token,
						})),
					},
				}),
			);
			return;
		}

		const chatMatch = p.match(/^\/ocs\/v2\.php\/apps\/spreed\/api\/v1\/chat\/([^/]+)$/);
		if (chatMatch) {
			const room = this.rooms.get(chatMatch[1]);
			if (!room) return this.#notFound(res);
			if (req.method === "GET") {
				const lastKnown = Number(url.searchParams.get("lastKnownMessageId") ?? "0");
				this.pollQueries.push({ room: room.token, lastKnownMessageId: lastKnown });
				await this.#poll(room, res, lastKnown);
				return;
			}
			if (req.method === "POST") {
				const body = JSON.parse(await readBody(req)) as { message?: string };
				const msg: TalkChatMessage = {
					id: ++this.nextMsgId,
					token: room.token,
					actorType: "users",
					actorId: this.botUserId,
					actorDisplayName: "Pi Bot",
					timestamp: Math.floor(Date.now() / 1000),
					systemMessage: "",
					messageType: "comment",
					message: body.message ?? "",
					messageParameters: {},
				};
				room.messages.push(msg);
				this.sentMessages.push({
					room: room.token,
					id: msg.id,
					text: msg.message,
					at: Date.now(),
				});
				this.#ocs(res, msg);
				return;
			}
		}

		const editMatch = p.match(/^\/ocs\/v2\.php\/apps\/spreed\/api\/v1\/chat\/([^/]+)\/(\d+)$/);
		if (editMatch && req.method === "PUT") {
			const room = this.rooms.get(editMatch[1]);
			const msg = room?.messages.find((m) => m.id === Number(editMatch[2]));
			if (!room || !msg) return this.#notFound(res);
			const body = JSON.parse(await readBody(req)) as { message?: string };
			msg.message = body.message ?? msg.message;
			msg.lastEditTimestamp = Math.floor(Date.now() / 1000);
			this.edits.push({ room: room.token, id: msg.id, text: msg.message, at: Date.now() });
			this.#ocs(res, msg);
			return;
		}

		this.#notFound(res);
	}

	async #poll(room: MockRoom, res: ServerResponse, lastKnown: number): Promise<void> {
		const fresh = () => room.messages.filter((m) => m.id > lastKnown);
		const deadline = Date.now() + 1500;
		for (;;) {
			if (this.closing) {
				res.writeHead(304);
				res.end();
				return;
			}
			const f = fresh();
			if (f.length > 0) {
				this.deliveredBatches.push({
					room: room.token,
					ids: f.map((m) => m.id),
					at: Date.now(),
				});
				res.writeHead(200, {
					"Content-Type": "application/json",
					"X-Chat-Last-Given": String(Math.max(...f.map((m) => m.id))),
				});
				res.end(JSON.stringify({ ocs: { meta: { statuscode: 100 }, data: f } }));
				return;
			}
			if (Date.now() >= deadline) {
				res.writeHead(304);
				res.end();
				return;
			}
			await new Promise<void>((resolve) => {
				const finish = () => {
					room.waiters.delete(finish);
					resolve();
				};
				room.waiters.add(finish);
				const timer = setTimeout(finish, Math.max(1, deadline - Date.now()));
				timer.unref();
			});
		}
	}

	#ocs(res: ServerResponse, data: unknown): void {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ocs: { meta: { statuscode: 100, status: "OK" }, data } }));
	}

	#notFound(res: ServerResponse): void {
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "unmockte Route" }));
	}
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		req.setEncoding("utf8");
		req.on("data", (c: string) => (data += c));
		req.on("end", () => resolve(data));
		req.on("error", reject);
	});
}

// ── Fixturen & Helfer ───────────────────────────────────────────────────────

const BOT_USER = "pi-bot";
const APP_TOKEN = "test-token-42";
const ALLOWED_USER = "alice";
const PLACEHOLDER = "⏳ Thinking…";

async function waitFor(condition: () => boolean, desc: string, timeoutMs = 6000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (condition()) return;
		if (Date.now() >= deadline) throw new Error(`waitFor-Timeout: ${desc}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}

/** Beweist, dass eine Nachricht tatsächlich in einem Poll-Batch geliefert wurde. */
async function expectDelivered(nc: MockNextcloud, id: number): Promise<void> {
	await waitFor(
		() => nc.deliveredBatches.some((b) => b.ids.includes(id)),
		`Message ${id} im Poll-Batch geliefert (Non-Vacuity)`,
	);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = join(HERE, "..", "..", "config", "config.default.json");
const BASE_CONFIG = JSON.parse(readFileSync(DEFAULT_CONFIG_PATH, "utf8")) as Record<
	string,
	unknown
>;

function writeGatewayConfig(): void {
	const config: Record<string, unknown> = {
		...BASE_CONFIG,
		security: {
			allowAll: false,
			requirePairing: false,
			allowedUids: { "*": [ALLOWED_USER] },
			adminUids: {},
			rateLimit: { maxRequests: 60, windowMs: 60_000 },
		},
	};
	mkdirSync(dirname(GATEWAY_CONFIG_FILE), { recursive: true });
	writeFileSync(GATEWAY_CONFIG_FILE, JSON.stringify(config, null, 2));
}

let nc: MockNextcloud;
let activeAdapter: NextcloudTalkAdapter | null = null;
let roomCounter = 0;

async function nextRoomToken(): Promise<string> {
	roomCounter += 1;
	const token = `stream-shot-${roomCounter}`;
	nc.addRoom(token);
	return token;
}

function makeAdapter(roomToken: string): NextcloudTalkAdapter {
	const config: NextcloudTalkConfig = {
		enabled: true,
		platform: "nextcloudTalk",
		baseUrl: nc.baseUrl,
		userId: BOT_USER,
		appToken: APP_TOKEN,
		rooms: [roomToken],
		pollMode: "long-poll",
		longPollTimeoutSeconds: 1,
		minPollIntervalMs: 50,
		allowInsecureHttp: true,
	};
	const adapter = new NextcloudTalkAdapter(config);
	runtime.state.adapters.set("nextcloudTalk", adapter);
	return adapter;
}

async function startAdapter(roomToken: string): Promise<NextcloudTalkAdapter> {
	const adapter = makeAdapter(roomToken);
	await adapter.initialize();
	await adapter.start(adapterCallbacks);
	activeAdapter = adapter;
	return adapter;
}

beforeAll(() => {
	writeGatewayConfig();
	initRuntime();
});

beforeEach(async () => {
	freshSecurityStore();
	freshSessionStore();
	runtime.state.sessions.clear();
	rpcMock.promptCalls.length = 0;
	rpcMock.responseText = "Antwort vom Agenten.";
	// Defaults zurücksetzen (Tests setzen gezielt Overrides).
	runtime.config.singleShotRooms = [];
	if (runtime.config.platforms.nextcloudTalk) {
		runtime.config.platforms.nextcloudTalk.streaming = true;
	}

	nc = new MockNextcloud();
	await nc.start();
});

afterEach(async () => {
	if (activeAdapter) {
		await activeAdapter.stop().catch((err: unknown) => {
			console.error("[test] adapter.stop() fehlgeschlagen:", err);
		});
		activeAdapter = null;
	}
	runtime.state.adapters.delete("nextcloudTalk");
	runtime.state.sessions.clear();
	await nc.stop();
});

// ── Unit: isStreamingEnabled (Prioritäten-Logik) ────────────────────────────

describe("isStreamingEnabled: Priorität (Raum-Override > Plattform-Flag > Default)", () => {
	const base = {
		singleShotRooms: [] as string[],
		platforms: { nextcloudTalk: { streaming: true } },
	};

	it("Default (nichts gesetzt) → Streaming", () => {
		expect(isStreamingEnabled({}, "nextcloudTalk", "abc")).toBe(true);
	});

	it("Plattform-Flag false → Single-Shot (Streaming aus)", () => {
		expect(
			isStreamingEnabled(
				{ singleShotRooms: [], platforms: { nextcloudTalk: { streaming: false } } },
				"nextcloudTalk",
				"abc",
			),
		).toBe(false);
	});

	it("singleShotRooms-Label → Single-Shot, auch wenn Plattform-Flag true", () => {
		// Raum gelistet + Flag true → Override gewinnt (Single-Shot).
		expect(
			isStreamingEnabled(
				{ ...base, singleShotRooms: ["gateway:nextcloudTalk:u4cmmzxu"] },
				"nextcloudTalk",
				"u4cmmzxu",
			),
		).toBe(false);
	});

	it("Raum NICHT gelistet + Flag true → Streaming (anderer Raum bleibt intakt)", () => {
		expect(
			isStreamingEnabled(
				{ ...base, singleShotRooms: ["gateway:nextcloudTalk:u4cmmzxu"] },
				"nextcloudTalk",
				"mmp26ta6",
			),
		).toBe(true);
	});

	it("singleShotRooms-Label anderer Plattform trifft diesen Kanal nicht", () => {
		expect(
			isStreamingEnabled(
				{ ...base, singleShotRooms: ["gateway:telegram:u4cmmzxu"] },
				"nextcloudTalk",
				"u4cmmzxu",
			),
		).toBe(true);
	});
});

// ── E2E: Pipeline + Adapter gegen Mock-Nextcloud ────────────────────────────

describe("Streaming-Modus E2E: Single-Shot vs. Streaming (NC-Talk)", () => {
	it(
		"singleShotRooms-Kanal: kein Platzhalter, keine Edits, Final-Text als neue sendMessage",
		{ timeout: 20_000 },
		async () => {
			const room = await nextRoomToken();
			runtime.config.singleShotRooms = [`gateway:nextcloudTalk:${room}`];
			await startAdapter(room);
			await waitFor(() => nc.pollQueries.length >= 1, "erster Poll");

			const msg = nc.postMessage(room, {
				actorId: ALLOWED_USER,
				message: "@Igor Was ist 2+2?",
			});

			await expectDelivered(nc, msg.id);
			await waitFor(() => rpcMock.promptCalls.length >= 1, "Modell-Call");
			await waitFor(
				() => nc.sentMessages.some((s) => s.text === rpcMock.responseText),
				"Final-Text als neue sendMessage",
			);

			// DAS KERN-ERGEBNIS: genau eine Outbound-Message (der Final-Text),
			// kein Platzhalter, und ZERO Edits → neue Message-ID → der
			// Webhook-Bot im Raum bekommt den Volltext zugestellt.
			expect(rpcMock.promptCalls).toHaveLength(1);
			expect(nc.sentMessages).toHaveLength(1);
			expect(nc.sentMessages[0].text).toBe(rpcMock.responseText);
			expect(nc.sentMessages.some((s) => s.text === PLACEHOLDER)).toBe(false);
			expect(nc.edits).toHaveLength(0);
		},
	);

	it(
		"Default-Kanal (nicht gelistet): Streaming wie bisher (Platzhalter + Final-Edit)",
		{ timeout: 20_000 },
		async () => {
			const room = await nextRoomToken();
			// KEIN singleShotRooms-Eintrag, Flag default true → Streaming.
			await startAdapter(room);
			await waitFor(() => nc.pollQueries.length >= 1, "erster Poll");

			const msg = nc.postMessage(room, {
				actorId: ALLOWED_USER,
				message: "@Igor Was ist 2+2?",
			});

			await expectDelivered(nc, msg.id);
			await waitFor(() => rpcMock.promptCalls.length >= 1, "Modell-Call");
			await waitFor(
				() => nc.edits.some((e) => e.text === rpcMock.responseText),
				"Final-Edit",
			);

			// Regressionsschutz: Platzhalter wurde gesendet, Final-Text kam als
			// Edit (gleiche ID) — nicht als zweite sendMessage.
			expect(nc.sentMessages).toHaveLength(1);
			expect(nc.sentMessages[0].text).toBe(PLACEHOLDER);
			expect(nc.edits.some((e) => e.text === rpcMock.responseText)).toBe(true);
			expect(nc.sentMessages.some((s) => s.text === rpcMock.responseText)).toBe(false);
		},
	);

	it(
		"platforms.nextcloudTalk.streaming=false: Single-Shot plattformweit (Raum nicht gelistet)",
		{ timeout: 20_000 },
		async () => {
			const room = await nextRoomToken();
			runtime.config.platforms.nextcloudTalk!.streaming = false;
			await startAdapter(room);
			await waitFor(() => nc.pollQueries.length >= 1, "erster Poll");

			const msg = nc.postMessage(room, {
				actorId: ALLOWED_USER,
				message: "@Igor Was ist 2+2?",
			});

			await expectDelivered(nc, msg.id);
			await waitFor(() => rpcMock.promptCalls.length >= 1, "Modell-Call");
			await waitFor(
				() => nc.sentMessages.some((s) => s.text === rpcMock.responseText),
				"Final-Text als neue sendMessage",
			);

			expect(nc.sentMessages).toHaveLength(1);
			expect(nc.sentMessages[0].text).toBe(rpcMock.responseText);
			expect(nc.sentMessages.some((s) => s.text === PLACEHOLDER)).toBe(false);
			expect(nc.edits).toHaveLength(0);
		},
	);
});
