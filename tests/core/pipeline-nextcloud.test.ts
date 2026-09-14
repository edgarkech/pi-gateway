/**
 * Pipeline-Smoke / E2E-Test für die Nextcloud-Talk-Pipeline (Konzept Phase 4, §12):
 *
 *   Inbound (Mock-Nextcloud) → WebDAV-Media → MediaManager → Adapter → Agent-Antwort
 *
 * Methodik (bewusst maximal echt, minimal gemockt):
 * - ECHTE Komponenten: OcsClient (echtes HTTP gegen lokale Mock-Nextcloud),
 *   NextcloudTalkAdapter inkl. TalkPoller (long-poll), MediaManager (echte
 *   Ingest-Pipeline mit Magic-Byte-Validierung + Registry in frischem Temp-Dir)
 *   und die echte message-pipeline (`adapterCallbacks.onMessage`: Sessions,
 *   Allowlist, Rate-Limit, Agent-Aufruf, Placeholder + Streaming-Edits).
 * - MOCKED: ausschließlich die Agent-RPC-Schicht (`src/core/rpc.js`) —
 *   `sendPromptRpc` simuliert Streaming (ein Delta + Final-Text), alle übrigen
 *   RPCs sind No-Ops. Kein echter Agent-Prozess wird gestartet.
 * - Mock-Nextcloud: lokaler `node:http`-Server mit OCS-Endpunkten
 *   (room, chat long-poll mit X-Chat-Last-Given, chat POST/PUT) und WebDAV-
 *   Dateiauslieferung unter `/remote.php/dav/files/<botUser>/...`.
 *   Basic-Auth (`userId:appToken`) wird auf jedem Request geprüft.
 *
 * Abgedeckte Akzeptanzkriterien (Konzept §12, Zeile "pipeline-nextcloud.test.ts"):
 * - emitMessage → Allowlist, Sessions, Media-Discard bei Ablehnung
 * - E2E: Inbound → WebDAV-Media → MediaManager → Adapter → Agent-Antwort
 * - Restart ohne Duplikat (Watermark warm geladen, alte Messages nicht erneut verarbeitet)
 * - N5: Attachments-Fehler isoliert (Text wird trotzdem verarbeitet)
 *
 * BEKANNTES AKTUELLES VERHALTEN (dokumentiert, kein Test-Fail):
 * Die `Platform`-Union in `src/security/auth.ts` enthält noch keinen Wert
 * "nextcloudTalk"; die Pipeline coerced unbekannte Platforms bei Security-Checks
 * auf "web". Allowlist/Rate-Limit greifen daher über `"*"` oder `"web"`, nicht
 * über einen `"nextcloudTalk"`-Key. Sessions verwenden dagegen den echten
 * Platform-Namen (siehe Test 1). Sobald "nextcloudTalk" in die Union aufgenommen
 * wird, kann dieser Test 1:1 auf `allowedUids["nextcloudTalk"]` umgestellt werden.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Dirent } from "node:fs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { adapterCallbacks } from "../../src/core/message-pipeline.js";
import { runtime, initRuntime } from "../../src/state.js";
import { GATEWAY_CONFIG_FILE } from "../../src/paths.js";
import {
	NextcloudTalkAdapter,
	type NextcloudTalkConfig,
} from "../../src/adapters/nextcloud-talk.js";
import { initMediaManager, resetMediaManager } from "../../src/media/manager.js";
import type { TalkChatMessage, TalkRichObject } from "../../src/adapters/nextcloud/talk-types.js";
import { freshSecurityStore, freshSessionStore } from "../helpers.js";

// ── Mock der Agent-RPC-Schicht (einziger gemockter Layer) ───────────────────
//
// `vi.hoisted`, weil `vi.mock`-Factories hoisted werden und keine Imports
// referenzieren dürfen. Der mutable Zustand wird hier gehalten und in den
// Tests direkt inspected.

interface MockPromptCall {
	message: string;
	sessionId: string;
	images: Array<{ type: "image"; data: string; mimeType: string }> | undefined;
}

const rpcMock = vi.hoisted(() => ({
	agentRunning: true,
	responseText: "Standardantwort vom Agenten.",
	streamDelta: "Erste Wörter…",
	promptCalls: [] as MockPromptCall[],
}));

vi.mock("../../src/core/rpc.js", () => ({
	isAgentRunning: () => rpcMock.agentRunning,
	// Signatur-Kompatibilität mit der echten sendPromptRpc-Überladung:
	// (message, sessionId, images?, onStream?) bzw. (message, sessionId, onStream).
	sendPromptRpc: async (
		message: string,
		sessionId: string,
		imagesOrCb?: unknown,
		onStreamArg?: (text: string) => void,
	): Promise<string> => {
		const images =
			typeof imagesOrCb === "function" || imagesOrCb === undefined
				? undefined
				: (imagesOrCb as MockPromptCall["images"]);
		const onStream =
			typeof imagesOrCb === "function" ? (imagesOrCb as (t: string) => void) : onStreamArg;
		rpcMock.promptCalls.push({ message, sessionId, images });
		// Simuliertes Streaming: ein Delta, dann der Final-Text.
		await new Promise((r) => setTimeout(r, 5));
		onStream?.(rpcMock.streamDelta);
		await new Promise((r) => setTimeout(r, 5));
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

// ── Mock-Nextcloud (lokaler HTTP-Server) ─────────────────────────────────────

interface MockRoom {
	token: string;
	messages: TalkChatMessage[];
	waiters: Set<() => void>;
}

/**
 * Minimale, aber protokollgetreue Nextcloud-Mock für OCS (Talk-API v1) und
 * WebDAV-Fileauslieferung. Langpolls werden deterministisch beendet: neue
 * Messages wecken wartende Poller sofort, sonst 304 nach `timeout`.
 */
class MockNextcloud {
	readonly botUserId = "pi-bot";
	readonly appToken = "test-token-42";

	/** Beobachtbare Request-Historie für Assertions. */
	pollQueries: Array<{
		room: string;
		lastKnownMessageId: number;
		lookIntoFuture: 0 | 1;
		timeoutSeconds?: number;
	}> = [];
	sentMessages: Array<{ room: string; id: number; text: string }> = [];
	edits: Array<{ room: string; id: number; text: string }> = [];
	davRequests: string[] = [];
	authFailures = 0;

	private server: Server | null = null;
	private port = 0;
	private rooms = new Map<string, MockRoom>();
	private files = new Map<string, { buffer: Buffer; contentType: string }>();
	private nextMsgId = 100;
	private closing = false;

	get baseUrl(): string {
		return `http://127.0.0.1:${this.port}`;
	}

	async start(): Promise<void> {
		this.server = createServer((req, res) => {
			this.#handle(req, res).catch((err: unknown) => {
				if (!res.headersSent) {
					res.writeHead(500, { "Content-Type": "application/json" });
				}
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

	setFile(userPath: string, buffer: Buffer, contentType: string): void {
		this.files.set(userPath, { buffer, contentType });
	}

	/** Postet eine User-Message in die Raum-Queue und weckt laufende Langpolls. */
	postUserMessage(
		roomToken: string,
		input: {
			actorId: string;
			actorDisplayName?: string;
			message: string;
			messageParameters?: Record<string, TalkRichObject>;
		},
	): TalkChatMessage {
		const room = this.rooms.get(roomToken);
		if (!room) throw new Error(`Unbekannter Raum: ${roomToken}`);
		const msg: TalkChatMessage = {
			id: ++this.nextMsgId,
			token: roomToken,
			actorType: "users",
			actorId: input.actorId,
			actorDisplayName: input.actorDisplayName ?? input.actorId,
			timestamp: Math.floor(Date.now() / 1000),
			systemMessage: "",
			messageType: "comment",
			message: input.message,
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
			this.authFailures += 1;
			res.writeHead(401, { "Content-Type": "application/json" });
			res.end(JSON.stringify(this.#ocsError(997, "UNAUTHORIZED")));
			return;
		}
		const p = decodeURIComponent(url.pathname);

		// OCS: Raumliste (Auth-Probe in adapter.initialize())
		if (req.method === "GET" && p === "/ocs/v2.php/apps/spreed/api/v4/room") {
			this.#respondOcs(
				res,
				[...this.rooms.values()].map((r) => ({
					token: r.token,
					type: 3,
					displayName: r.token,
				})),
			);
			return;
		}

		// OCS: Chat long-poll (GET) und Bot-Auslieferung (POST)
		const chatMatch = p.match(/^\/ocs\/v2\.php\/apps\/spreed\/api\/v1\/chat\/([^/]+)$/);
		if (chatMatch) {
			const room = this.rooms.get(chatMatch[1]);
			if (!room) {
				this.#respondOcsError(res, 404, 999, "ROOM_NOT_FOUND");
				return;
			}
			if (req.method === "GET") {
				const lastKnown = Number(url.searchParams.get("lastKnownMessageId") ?? "0");
				const lookIntoFuture = url.searchParams.get("lookIntoFuture") === "1" ? 1 : 0;
				const timeoutSeconds = Number(url.searchParams.get("timeout") ?? "0");
				this.pollQueries.push({
					room: room.token,
					lastKnownMessageId: lastKnown,
					lookIntoFuture,
					timeoutSeconds: timeoutSeconds || undefined,
				});
				await this.#handleChatPoll(room, res, lastKnown, lookIntoFuture, timeoutSeconds);
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
				this.sentMessages.push({ room: room.token, id: msg.id, text: msg.message });
				this.#respondOcs(res, msg);
				return;
			}
		}

		// OCS: Chat-Edit (Message-Update via PUT)
		const editMatch = p.match(/^\/ocs\/v2\.php\/apps\/spreed\/api\/v1\/chat\/([^/]+)\/(\d+)$/);
		if (editMatch && req.method === "PUT") {
			const room = this.rooms.get(editMatch[1]);
			const msg = room?.messages.find((m) => m.id === Number(editMatch[2]));
			if (!room || !msg) {
				this.#respondOcsError(res, 404, 999, "MESSAGE_NOT_FOUND");
				return;
			}
			const body = JSON.parse(await readBody(req)) as { message?: string };
			msg.message = body.message ?? msg.message;
			this.edits.push({ room: room.token, id: msg.id, text: msg.message });
			this.#respondOcs(res, msg);
			return;
		}

		// WebDAV: Dateiauslieferung aus der Bot-Dateiablage
		const davMatch = p.match(/^\/remote\.php\/dav\/files\/([^/]+)\/(.+)$/);
		if (davMatch && req.method === "GET") {
			if (davMatch[1] !== this.botUserId) {
				res.writeHead(403, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "forbidden" }));
				return;
			}
			const userPath = davMatch[2];
			this.davRequests.push(p);
			const file = this.files.get(userPath);
			if (!file) {
				res.writeHead(404, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "not found" }));
				return;
			}
			res.writeHead(200, {
				"Content-Type": file.contentType,
				"Content-Length": file.buffer.length,
			});
			res.end(file.buffer);
			return;
		}

		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: `unmockte Route: ${req.method} ${p}` }));
	}

	async #handleChatPoll(
		room: MockRoom,
		res: ServerResponse,
		lastKnown: number,
		lookIntoFuture: 0 | 1,
		timeoutSeconds: number,
	): Promise<void> {
		const fresh = () => room.messages.filter((m) => m.id > lastKnown);
		if (fresh().length > 0) {
			this.#respondChat(res, fresh());
			return;
		}
		if (!lookIntoFuture || timeoutSeconds <= 0) {
			res.writeHead(304);
			res.end();
			return;
		}
		// Langpoll: auf neue Messages warten (auf 2 s gedeckelt für Test-Tempo).
		await new Promise<void>((resolve) => {
			const finish = () => {
				room.waiters.delete(finish);
				resolve();
			};
			room.waiters.add(finish);
			const timer = setTimeout(finish, Math.min(timeoutSeconds * 1000, 2000));
			timer.unref();
		});
		if (this.closing) {
			res.writeHead(304);
			res.end();
			return;
		}
		const f = fresh();
		if (f.length > 0) {
			this.#respondChat(res, f);
		} else {
			res.writeHead(304);
			res.end();
		}
	}

	#respondChat(res: ServerResponse, messages: TalkChatMessage[]): void {
		const lastGiven = Math.max(...messages.map((m) => m.id));
		res.writeHead(200, {
			"Content-Type": "application/json",
			"X-Chat-Last-Given": String(lastGiven),
		});
		res.end(JSON.stringify(this.#ocsOk(messages)));
	}

	#respondOcs(res: ServerResponse, data: unknown): void {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(this.#ocsOk(data)));
	}

	#respondOcsError(
		res: ServerResponse,
		httpStatus: number,
		ocsCode: number,
		message: string,
	): void {
		res.writeHead(httpStatus, { "Content-Type": "application/json" });
		res.end(JSON.stringify(this.#ocsError(ocsCode, message)));
	}

	#ocsOk(data: unknown): unknown {
		return { ocs: { meta: { statuscode: 100, status: "OK", message: "OK" }, data } };
	}

	#ocsError(statuscode: number, message: string): unknown {
		return {
			ocs: { meta: { statuscode, status: "FAIL", message, Exception: "" }, data: null },
		};
	}
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		req.setEncoding("utf8");
		req.on("data", (chunk: string) => {
			data += chunk;
		});
		req.on("end", () => resolve(data));
		req.on("error", reject);
	});
}

// ── Test-Fixturen & Helfer ───────────────────────────────────────────────────

const BOT_USER = "pi-bot";
const APP_TOKEN = "test-token-42";
const ALLOWED_USER = "alice";
const REJECT_TEXT =
	"You are not allowed to use this agent. Contact the administrator to request access.";
const PLACEHOLDER_TEXT = "⏳ Thinking…";

/** Minimales, magic-byte-gültiges PNG (Sniffing prüft nur den Header). */
const PNG_BYTES = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG-Signatur
	Buffer.alloc(64, 0x42), // Dummy-Pixel (für Sniffing irrelevant)
	Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]), // IEND
]);

/** Wartet bis `condition` wahr ist (Pollen-basiert, deterministisch genug für E2E). */
async function waitFor(
	condition: () => boolean,
	description: string,
	timeoutMs = 5000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (condition()) return;
		if (Date.now() >= deadline) throw new Error(`waitFor-Timeout: ${description}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}

/** Sucht rekursiv eine Datei mit exakt `content` unter `root` (ignoriert .part). */
async function findFileWithContent(root: string, content: Buffer): Promise<string | null> {
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop()!;
		let entries: Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
			} else if (entry.isFile() && !entry.name.endsWith(".part")) {
				const buf = await readFile(full).catch(() => null);
				if (buf !== null && buf.equals(content)) return full;
			}
		}
	}
	return null;
}

// ── Config-Handling ──────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = join(HERE, "..", "..", "config", "config.default.json");
const BASE_CONFIG = JSON.parse(readFileSync(DEFAULT_CONFIG_PATH, "utf8")) as Record<
	string,
	unknown
>;

/**
 * Schreibt die Gateway-Config in die (setup.ts-isolierte) HOME und übernimmt
 * dabei nur den Security-Block. `getSecurityConfig()` liest die Datei bei jedem
 * Check neu → Änderungen wirken ohne Neustart (wie im Produkt via SIGHUP).
 */
function writeGatewayConfig(security: Record<string, unknown>): void {
	const config: Record<string, unknown> = {
		...BASE_CONFIG,
		security: {
			allowAll: false,
			requirePairing: false,
			allowedUids: {},
			adminUids: {},
			rateLimit: { maxRequests: 60, windowMs: 60_000 },
			...security,
		},
	};
	mkdirSync(dirname(GATEWAY_CONFIG_FILE), { recursive: true });
	writeFileSync(GATEWAY_CONFIG_FILE, JSON.stringify(config, null, 2));
}

// ── Adapter-Setup (spiegelt src/adapters/registry.ts exakt) ─────────────────

let nc: MockNextcloud;
let mediaDir: string;
let activeAdapter: NextcloudTalkAdapter | null = null;
let roomCounter = 0;

async function nextRoomToken(): Promise<string> {
	roomCounter += 1;
	const token = `room-${roomCounter}`;
	nc.addRoom(token);
	return token;
}

function makeAdapter(
	roomToken: string,
	overrides: Partial<NextcloudTalkConfig> = {},
): NextcloudTalkAdapter {
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
		allowInsecureHttp: true, // Mock spricht http:// auf Loopback
		...overrides,
	};
	const adapter = new NextcloudTalkAdapter(config);
	runtime.state.adapters.set("nextcloudTalk", adapter);
	return adapter;
}

async function startAdapter(
	roomToken: string,
	overrides?: Partial<NextcloudTalkConfig>,
): Promise<NextcloudTalkAdapter> {
	const adapter = makeAdapter(roomToken, overrides);
	await adapter.initialize(); // inkl. Auth-Probe (GET /room)
	await adapter.start(adapterCallbacks); // echte Pipeline-Callbacks
	activeAdapter = adapter;
	return adapter;
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

beforeAll(() => {
	// Standard-Config mit erlaubter Test-User (Wildcard-Platform-Key, siehe
	// Header: "nextcloudTalk" ist noch kein Platform-Union-Wert).
	writeGatewayConfig({ allowedUids: { "*": [ALLOWED_USER] } });
	initRuntime();
});

beforeEach(async () => {
	// Security-Config zurücksetzen: Tests dürfen die Config-Datei (z. B.
	// Allowlist-Test) ändern — der nächste Test startet wieder mit Default.
	writeGatewayConfig({ allowedUids: { "*": [ALLOWED_USER] } });

	freshSecurityStore();
	freshSessionStore();
	runtime.state.sessions.clear();
	rpcMock.promptCalls.length = 0;
	rpcMock.responseText = "Standardantwort vom Agenten.";
	rpcMock.streamDelta = "Erste Wörter…";

	nc = new MockNextcloud();
	await nc.start();

	// Frische Media-Storage je Test (Singleton neu initialisieren).
	resetMediaManager();
	mediaDir = await mkdtemp(join(tmpdir(), "pi-gw-nc-media-"));
	runtime.media = initMediaManager({ rootDir: mediaDir, sweepIntervalMinutes: 0 });
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
	resetMediaManager();
	runtime.media = null;
	await nc.stop();
});

afterAll(async () => {
	await rm(mediaDir, { recursive: true, force: true }).catch(() => undefined);
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Nextcloud-Talk Pipeline E2E (Inbound → WebDAV → MediaManager → Adapter → Agent)", () => {
	it(
		"Text-E2E: Inbound → Allowlist/Session → Agent → Placeholder + Streaming-Edit + Final-Antwort",
		{ timeout: 20_000 },
		async () => {
			const room = await nextRoomToken();
			await startAdapter(room);

			// Poller lebt: erste Poll-Query ist beim Mock angekommen.
			await waitFor(() => nc.pollQueries.length >= 1, "erster Poll");

			nc.postUserMessage(room, {
				actorId: ALLOWED_USER,
				actorDisplayName: "Alice",
				message: "Was ist 2+2?",
			});

			// Bot-Auslieferung: Placeholder + mindestens zwei Edits (Delta + Final).
			await waitFor(
				() => nc.sentMessages.length >= 1 && nc.edits.length >= 2,
				"Placeholder + Streaming/Final-Edits",
			);

			const placeholder = nc.sentMessages[0];
			expect(placeholder.room).toBe(room);
			expect(placeholder.text).toBe(PLACEHOLDER_TEXT);

			// Agent wurde genau einmal aufgerufen — mit Policy-Guard (externer,
			// nicht-admin User) und dem Originaltext.
			expect(rpcMock.promptCalls).toHaveLength(1);
			const call = rpcMock.promptCalls[0];
			expect(call.message.startsWith("!!! SYSTEM DIRECTIVE")).toBe(true);
			expect(call.message.endsWith("\n\nWas ist 2+2?")).toBe(true);

			// Session wurde unter dem echten Platform-Namen angelegt.
			const session = runtime.state.sessions.get(`nextcloudTalk:${room}`);
			expect(session).toBeDefined();
			expect(session!.platform).toBe("nextcloudTalk");
			expect(session!.channelId).toBe(room);
			expect(session!.userId).toBe(ALLOWED_USER);
			expect(call.sessionId).toBe(session!.id);

			// Streaming: Delta-Edit vor dem Final-Edit; Final = Agent-Antwort.
			const editsForPlaceholder = nc.edits.filter((e) => e.id === placeholder.id);
			expect(editsForPlaceholder.some((e) => e.text === rpcMock.streamDelta)).toBe(true);
			expect(editsForPlaceholder[editsForPlaceholder.length - 1].text).toBe(
				rpcMock.responseText,
			);

			// Anti-Loop: die eigene Bot-Antwort wird gepollt (Watermark zieht
			// darüber hinweg), löst aber keinen zweiten Agent-Call aus.
			await waitFor(
				() => nc.pollQueries.some((q) => q.lastKnownMessageId >= placeholder.id),
				"Poll über Bot-eigene Message hinweg",
			);
			expect(rpcMock.promptCalls).toHaveLength(1);

			// Basic-Auth war auf jedem Request korrekt.
			expect(nc.authFailures).toBe(0);
		},
	);

	it(
		"Media-E2E: WebDAV-Download → MediaManager-Ingest → Manifest + base64-Inline → Antwort",
		{ timeout: 20_000 },
		async () => {
			const room = await nextRoomToken();
			nc.setFile("Inbox/foto.png", PNG_BYTES, "image/png");
			await startAdapter(room);
			await waitFor(() => nc.pollQueries.length >= 1, "erster Poll");

			nc.postUserMessage(room, {
				actorId: ALLOWED_USER,
				message: "{file}",
				messageParameters: {
					file: {
						type: "file",
						id: "4711",
						name: "foto.png",
						path: "Inbox/foto.png",
						mimetype: "image/png",
						size: PNG_BYTES.length,
					},
				},
			});

			await waitFor(() => rpcMock.promptCalls.length >= 1, "Agent-Call mit Anhang");
			const call = rpcMock.promptCalls[0];

			// WebDAV wurde mit dem Bot-User-Pfad angefragt.
			expect(nc.davRequests).toContain(`/remote.php/dav/files/${BOT_USER}/Inbox/foto.png`);

			// Echte Ingest-Pipeline: Datei liegt byte-identisch im Store, Registry-Zeile vorhanden.
			const onDisk = await findFileWithContent(mediaDir, PNG_BYTES);
			expect(onDisk).not.toBeNull();
			const stats = await runtime.media!.stats();
			expect(stats.fileCount).toBe(1);
			expect(stats.totalBytes).toBe(PNG_BYTES.length);

			// Prompt: Content mit aufgelöstem Rich-Text + Manifest (ein Anhang).
			expect(call.message).toContain("[Anhang: foto.png]");
			expect(call.message).toContain(
				"Der Nutzer hat 1 Anhang zu dieser Nachricht hinzugefügt:",
			);
			expect(call.message).toContain(
				`[Anhang 1] foto.png (image, image/png, ${PNG_BYTES.length} B)`,
			);
			expect(call.message).toContain(
				"Das Bild ist dieser Nachricht zusätzlich als Bild beigelegt.",
			);

			// Bild wurde für den Agenten base64-inlined.
			expect(call.images).toHaveLength(1);
			expect(call.images![0]).toEqual({
				type: "image",
				data: PNG_BYTES.toString("base64"),
				mimeType: "image/png",
			});

			// Vollständiger Loop: die Final-Antwort kommt an (Delta-Edit ist
			// fire-and-forget → gezielt auf den Final-Text warten).
			await waitFor(
				() => nc.edits.some((e) => e.text === rpcMock.responseText),
				"Final-Edit",
			);
		},
	);

	it(
		"Allowlist-Ablehnung: kein Agent-Call, Ablehnungs-Message via Adapter, Media wird verworfen",
		{ timeout: 20_000 },
		async () => {
			const room = await nextRoomToken();
			nc.setFile("Inbox/secret.png", PNG_BYTES, "image/png");

			// Security-Config ohne erlaubte Uids (neu gelesen bei jedem Check).
			writeGatewayConfig({ allowedUids: {} });

			await startAdapter(room);
			await waitFor(() => nc.pollQueries.length >= 1, "erster Poll");

			nc.postUserMessage(room, {
				actorId: "mallory",
				message: "{file}",
				messageParameters: {
					file: {
						type: "file",
						id: "9001",
						name: "secret.png",
						path: "Inbox/secret.png",
						mimetype: "image/png",
						size: PNG_BYTES.length,
					},
				},
			});

			// Ablehnungs-Message wurde über den echten Adapter ausgeliefert.
			await waitFor(() => nc.sentMessages.length >= 1, "Ablehnungs-Message");
			expect(nc.sentMessages[0].room).toBe(room);
			expect(nc.sentMessages[0].text).toBe(REJECT_TEXT);

			// Agent wurde nie aufgerufen.
			expect(rpcMock.promptCalls).toHaveLength(0);

			// Anhang wurde von der Pipeline verworfen (keine Datei, keine Registry-Zeile).
			const stats = await runtime.media!.stats();
			expect(stats.fileCount).toBe(0);
			expect(await findFileWithContent(mediaDir, PNG_BYTES)).toBeNull();
		},
	);

	it(
		"WebDAV-404: Attachments-Fehler ist isoliert, Text wird trotzdem verarbeitet (N5)",
		{ timeout: 20_000 },
		async () => {
			const room = await nextRoomToken();
			// Datei wird NICHT im Mock hinterlegt → WebDAV antwortet 404.
			await startAdapter(room);
			await waitFor(() => nc.pollQueries.length >= 1, "erster Poll");

			nc.postUserMessage(room, {
				actorId: ALLOWED_USER,
				message: "{file}",
				messageParameters: {
					file: {
						type: "file",
						id: "4044",
						name: "missing.png",
						path: "Inbox/missing.png",
						mimetype: "image/png",
						size: 1234,
					},
				},
			});

			// Der Agent-Call erfolgt trotzdem — ohne Anhang.
			await waitFor(() => rpcMock.promptCalls.length >= 1, "Agent-Call trotz 404");
			const call = rpcMock.promptCalls[0];
			expect(nc.davRequests).toContain(`/remote.php/dav/files/${BOT_USER}/Inbox/missing.png`);
			expect(call.message).toContain("[Anhang: missing.png]");
			expect(call.message).not.toContain(
				"Der Nutzer hat 1 Anhang zu dieser Nachricht hinzugefügt:",
			);
			expect(call.images).toBeUndefined();

			// Die Antwort kommt trotzdem an.
			await waitFor(
				() => nc.edits.some((e) => e.text === rpcMock.responseText),
				"Final-Edit",
			);
		},
	);

	it(
		"Restart ohne Duplikat: Watermark warm geladen, alte Messages werden nicht erneut verarbeitet",
		{ timeout: 30_000 },
		async () => {
			const room = await nextRoomToken();

			// Phase 1: Adapter A verarbeitet die erste Message.
			const adapterA = await startAdapter(room);
			await waitFor(() => nc.pollQueries.length >= 1, "erster Poll");
			nc.postUserMessage(room, { actorId: ALLOWED_USER, message: "Erste Nachricht" });
			await waitFor(
				() => nc.edits.some((e) => e.text === rpcMock.responseText),
				"Antwort auf erste Message",
			);
			const botMsgId = nc.sentMessages[0].id;

			// Anti-Loop + Persistenz: die eigene Bot-Antwort wird gepollt und
			// ignoriert; die Watermark liegt danach mindestens bei der Bot-ID.
			await waitFor(
				() => nc.pollQueries.some((q) => q.lastKnownMessageId >= botMsgId),
				"Watermark zieht über Bot-Antwort",
			);
			expect(rpcMock.promptCalls).toHaveLength(1);

			// Phase 2: Adapter stoppen (Watermark bleibt in der Talk-State-DB).
			await adapterA.stop();
			activeAdapter = null;
			const pollsBeforeRestart = nc.pollQueries.length;

			// Phase 3: Neuer Adapter, gleicher Raum → warm start.
			await startAdapter(room);
			await waitFor(
				() => nc.pollQueries.length > pollsBeforeRestart,
				"Poll des neuen Adapters",
			);
			const restartPolls = nc.pollQueries.slice(pollsBeforeRestart);
			// Jede Poll-Query nach dem Restart muss die persistierte Watermark nutzen.
			expect(restartPolls.length).toBeGreaterThanOrEqual(1);
			for (const q of restartPolls) {
				expect(q.lastKnownMessageId).toBeGreaterThanOrEqual(botMsgId);
			}

			// Phase 4: Neue Message wird verarbeitet, alte nicht erneut.
			nc.postUserMessage(room, { actorId: ALLOWED_USER, message: "Zweite Nachricht" });
			await waitFor(() => rpcMock.promptCalls.length >= 2, "Agent-Call für zweite Message");
			expect(rpcMock.promptCalls[1].message.endsWith("\n\nZweite Nachricht")).toBe(true);
			const promptsAfterRestart = rpcMock.promptCalls.slice(1);
			for (const c of promptsAfterRestart) {
				expect(c.message).not.toContain("Erste Nachricht");
			}

			// Antwort auf die zweite Message kommt an (zwei Final-Edits insgesamt).
			await waitFor(
				() => nc.edits.filter((e) => e.text === rpcMock.responseText).length >= 2,
				"Antwort-Edit für zweite Message",
			);
		},
	);
});
