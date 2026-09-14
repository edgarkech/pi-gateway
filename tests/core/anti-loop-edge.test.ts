/**
 * Anti-Loop-Edge-Test für die Nextcloud-Talk-Pipeline (Konzept Phase 4, S6):
 *
 *   "Bot-Antwort auslösende Polls durften keinen 2ten Agent-Call."
 *
 * Der Gateway pollt als derselbe OCS-User, der auch antwortet (Option B,
 * Konzept §1/D4). Jede Bot-Auslieferung (Placeholder, Streaming-Edits,
 * Chunked-Langantworten, Ablehnungs-Messages) taucht daher im eigenen
 * Poll-Stream wieder auf. Ohne lückenlose Filter-Kette wäre jede Antwort
 * neue Eingabe → Endlosschleife.
 *
 * Abgedeckte Edge-Cases (Konzept §12 "Fokus auf den Anti-Loop-Test",
 * §14 Risiko 1, offene Frage 3):
 * 1. Basic Round-Trip: Bot-Antwort wird gepollt → kein 2ter Agent-Call.
 * 2. Streaming-Edit-Sturm: viele PUTs auf dieselbe Bot-Message (gleiche ID)
 *    → keine Re-Triggerung.
 * 3. Chunked-Langantwort (>32k, N6): mehrere NEUE eigene Bot-Message-IDs im
 *    Poll-Stream → kein 2ter Agent-Call.
 * 4. Gemischte Batch: eigene Bot-Antwort + User-Message in EINEM Poll-Batch
 *    → genau ein Agent-Call pro User-Message.
 * 5. Nicht-publishable Typen (System-Events, `command`, `comment_deleted`)
 *    im Poll-Stream → kein Agent-Call (prüft BEIDE Filter-Ebenen: der Poller
 *    wirft System-Nachrichten weg; der zentrale `isPublishable`-Filter im
 *    Adapter fängt `command`/`comment_deleted`, die der Poller durchlässt).
 * 6. Ablehnungs-Loop: Bot-Ablehnungs-Message wird gepollt → kein Agent-Call.
 * 7. Restart: Warm-Watermark verhindert Re-Emission eigener Bot-Antworten
 *    (offene Frage 3 des Konzepts).
 *
 * Methodik (wie `pipeline-nextcloud.test.ts`, bewusst maximal echt):
 * - ECHT: NextcloudTalkAdapter inkl. TalkPoller (Long-Poll), message-pipeline
 *   (`adapterCallbacks.onMessage`: Sessions, Allowlist, Rate-Limit,
 *   Agent-Aufruf, Placeholder + Streaming-Edits).
 * - MOCKED: ausschließlich die Agent-RPC-Schicht (`src/core/rpc.js`) und die
 *   Nextcloud selbst (lokaler `node:http`-Mock mit OCS-Chat-Endpoints).
 * - NICHT-VACUITY-GARANTIE: Der Mock protokolliert jeden ausgelieferten
 *   Poll-Batch (`deliveredBatches`). Jeder Test verifiziert explizit, dass
 *   die eigene Bot-Message tatsächlich in einem Batch geliefert wurde —
 *   sonst wäre ein grüner Test wertlos (Filter nie ausgeführt).
 *
 * Verhältnis zu bestehenden Suites:
 * - `tests/adapters/nextcloud-talk.test.ts`: Unit-Tests für `isPublishable`
 *   (den Anti-Loop-Core) im Einzelnen.
 * - `tests/adapters/nextcloud/poller.test.ts`: Poller-Verhalten (Filter,
 *   Offset-Persistenz, Backoff) mit Fake-Client.
 * - `tests/core/pipeline-nextcloud.test.ts`: Pipeline-E2E inkl. Basis-Anti-
 *   Loop-Assertion. Diese Datei fokussiert auf die EDGE-Cases darüber hinaus.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { adapterCallbacks } from "../../src/core/message-pipeline.js";
import { runtime, initRuntime } from "../../src/state.js";
import { GATEWAY_CONFIG_FILE } from "../../src/paths.js";
import {
	NextcloudTalkAdapter,
	type NextcloudTalkConfig,
} from "../../src/adapters/nextcloud-talk.js";
import type { TalkChatMessage } from "../../src/adapters/nextcloud/talk-types.js";
import { freshSecurityStore, freshSessionStore } from "../helpers.js";

// ── Mock der Agent-RPC-Schicht (einziger gemockter Layer) ───────────────────
//
// `vi.hoisted`, weil `vi.mock`-Factories hoisted werden und keine Imports
// referenzieren dürfen. Der mutable Zustand wird hier gehalten und in den
// Tests direkt inspected. `streamDeltas` ist ein Array, damit Edge-Cases
// mehrere (gedrosselte) Streaming-Edits simulieren können.

interface MockPromptCall {
	message: string;
	sessionId: string;
	images: Array<{ type: "image"; data: string; mimeType: string }> | undefined;
}

const rpcMock = vi.hoisted(() => ({
	agentRunning: true,
	responseText: "Standardantwort vom Agenten.",
	streamDeltas: ["Erste Wörter…"] as string[],
	/** Abstand zwischen zwei simulierten Stream-Deltas (ms). */
	deltaDelayMs: 5,
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
		for (const delta of rpcMock.streamDeltas) {
			await new Promise((r) => setTimeout(r, rpcMock.deltaDelayMs));
			onStream?.(delta);
		}
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

/** Ausgelieferter Poll-Batch (200, nicht 304) — Basis der Non-Vacuity-Checks. */
interface DeliveredBatch {
	room: string;
	ids: number[];
	at: number;
}

/**
 * Minimale, aber protokollgetreue Nextcloud-Mock für die OCS-Talk-API v1
 * (Raumliste, Chat long-poll mit X-Chat-Last-Given, Chat POST/PUT).
 *
 * Anti-Loop-relevante Beobachtungsgrößen:
 * - `pollQueries`: jede Poll-Query inkl. `lastKnownMessageId` (Watermark-Verlauf).
 * - `sentMessages` / `edits`: Bot-Auslieferungen (POST/PUT) mit Zeitstempel.
 * - `deliveredBatches`: welche Message-IDs tatsächlich in Poll-Batches an den
 *   Adapter geliefert wurden — Beweis, dass der Filter wirklich lief.
 *
 * `minPendingForDelivery` (Default 1) hält Long-Polls so lange, bis mindestens
 * N neue Messages pendend sind — damit Edge-Cases deterministische gemischte
 * Batches erzwingen können (Test 4). Bei Timeout wird trotzdem ausgeliefert,
 * was da ist (kein Deadlock, kein Verlust: Watermark bleibt stehen).
 */
class MockNextcloud {
	readonly botUserId = "pi-bot";
	readonly appToken = "test-token-42";

	pollQueries: Array<{
		room: string;
		lastKnownMessageId: number;
		lookIntoFuture: 0 | 1;
		timeoutSeconds?: number;
	}> = [];
	sentMessages: Array<{ room: string; id: number; text: string; at: number }> = [];
	edits: Array<{ room: string; id: number; text: string; at: number }> = [];
	deliveredBatches: DeliveredBatch[] = [];
	authFailures = 0;

	/** Long-Polls warten auf ≥ N neue Messages (Default 1 = normales Verhalten). */
	minPendingForDelivery = 1;

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

	/**
	 * Postet eine beliebige Message in die Raum-Queue und weckt laufende
	 * Langpolls. Defaults entsprechen einer normalen User-Message; jede
	 * Feld-Übergabe (actorType, systemMessage, messageType, …) überschreibt
	 * sie — so lassen sich System-Events, Bot-Aktoren, `command` & Co.
	 * deterministisch in den Poll-Stream injizieren.
	 */
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
			referenceId: input.referenceId,
			markdown: input.markdown,
			lastEditTimestamp: input.lastEditTimestamp,
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
				this.sentMessages.push({
					room: room.token,
					id: msg.id,
					text: msg.message,
					at: Date.now(),
				});
				this.#respondOcs(res, msg);
				return;
			}
		}

		// OCS: Chat-Edit (Message-Update via PUT) — dieselbe Message-ID bleibt,
		// nur der Inhalt ändert sich (protokollgetreu: lastEditTimestamp gesetzt).
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
			msg.lastEditTimestamp = Math.floor(Date.now() / 1000);
			this.edits.push({ room: room.token, id: msg.id, text: msg.message, at: Date.now() });
			this.#respondOcs(res, msg);
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

		if (fresh().length >= this.minPendingForDelivery) {
			this.#respondChat(res, room.token, fresh());
			return;
		}
		if (!lookIntoFuture || timeoutSeconds <= 0) {
			res.writeHead(304);
			res.end();
			return;
		}

		// Langpoll: auf neue Messages warten (auf 2 s gedeckelt für Test-Tempo).
		// Solange < minPendingForDelivery pendend sind, wird weiter gewartet;
		// am Deadline-Ende wird trotzdem ausgeliefert, was da ist (kein Verlust:
		// die Watermark rückt nicht vor, der nächste Poll liefert neu).
		const deadline = Date.now() + Math.min(timeoutSeconds * 1000, 2000);
		for (;;) {
			if (this.closing) {
				res.writeHead(304);
				res.end();
				return;
			}
			const f = fresh();
			if (f.length >= this.minPendingForDelivery) {
				this.#respondChat(res, room.token, f);
				return;
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				if (f.length > 0) {
					this.#respondChat(res, room.token, f);
				} else {
					res.writeHead(304);
					res.end();
				}
				return;
			}
			await new Promise<void>((resolve) => {
				const finish = () => {
					room.waiters.delete(finish);
					resolve();
				};
				room.waiters.add(finish);
				const timer = setTimeout(finish, remaining);
				timer.unref();
			});
		}
	}

	#respondChat(res: ServerResponse, roomToken: string, messages: TalkChatMessage[]): void {
		this.deliveredBatches.push({
			room: roomToken,
			ids: messages.map((m) => m.id),
			at: Date.now(),
		});
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

/**
 * Wartet, bis die Watermark über `id` hinausgezogen wurde (eine Poll-Query mit
 * `lastKnownMessageId >= id` existiert). Beweist: der Poller hat den Batch mit
 * der Message verarbeitet und den Offset fortgeschrieben.
 */
async function waitForWatermark(nc: MockNextcloud, id: number): Promise<void> {
	await waitFor(
		() => nc.pollQueries.some((q) => q.lastKnownMessageId >= id),
		`Watermark zieht über Message ${id} hinweg`,
	);
}

/**
 * Non-Vacuity-Garantie: wartet darauf, dass die eigenen Bot-Messages
 * tatsächlich in Poll-Batches geliefert wurden (der Poller läuft im 50-ms-
 * Rhythmus — die Auslieferung kann also erst kurz nach dem Final-Edit
 * eintreffen). Ohne diesen Check wäre ein grüner Test wertlos: der Anti-Loop-
 * Filter wäre schlicht nie ausgeführt worden.
 */
async function expectBotMessagesDelivered(nc: MockNextcloud, ids: number[]): Promise<void> {
	for (const id of ids) {
		await waitFor(
			() => nc.deliveredBatches.some((b) => b.ids.includes(id)),
			`Bot-eigene Message ${id} in Poll-Batch geliefert (Non-Vacuity)`,
		);
	}
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
let activeAdapter: NextcloudTalkAdapter | null = null;
let roomCounter = 0;

async function nextRoomToken(): Promise<string> {
	roomCounter += 1;
	const token = `anti-loop-room-${roomCounter}`;
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

/** Wartet auf den Placeholder-POST der Bot-Auslieferung und liefert ihn. */
async function waitForSentPlaceholder(): Promise<{ room: string; id: number; text: string }> {
	await waitFor(() => nc.sentMessages.length >= 1, "Placeholder-POST");
	const placeholder = nc.sentMessages[0];
	expect(placeholder.text).toBe(PLACEHOLDER_TEXT);
	return placeholder;
}

/** Wartet auf die Final-Antwort im Raum (Edit mit dem Agent-Finaltext). */
async function waitForFinalResponse(minEdits = 1): Promise<void> {
	await waitFor(
		() => nc.edits.filter((e) => e.text === rpcMock.responseText).length >= minEdits,
		`Final-Edit(s) (${minEdits})`,
	);
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

beforeAll(() => {
	// Standard-Config mit erlaubter Test-User. Hinweis: "nextcloudTalk" ist
	// noch kein Wert der `Platform`-Union in src/security/auth.ts — die
	// Pipeline coerced unbekannte Platforms bei Security-Checks auf "web",
	// daher greift die Allowlist über den Wildcard-Key "*" (wie im E2E-Test).
	writeGatewayConfig({ allowedUids: { "*": [ALLOWED_USER] } });
	initRuntime();
});

beforeEach(async () => {
	writeGatewayConfig({ allowedUids: { "*": [ALLOWED_USER] } });

	freshSecurityStore();
	freshSessionStore();
	runtime.state.sessions.clear();
	rpcMock.promptCalls.length = 0;
	rpcMock.responseText = "Standardantwort vom Agenten.";
	rpcMock.streamDeltas = ["Erste Wörter…"];
	rpcMock.deltaDelayMs = 5;

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

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Anti-Loop Edge Cases (Phase 4 S6): Bot-Antwort auslösende Polls → kein 2ter Agent-Call", () => {
	it(
		"1. Basic Round-Trip: Bot-Antwort wird gepollt, löst aber keinen 2ten Agent-Call aus",
		{ timeout: 20_000 },
		async () => {
			const room = await nextRoomToken();
			await startAdapter(room);
			await waitFor(() => nc.pollQueries.length >= 1, "erster Poll");

			nc.postMessage(room, { actorId: ALLOWED_USER, message: "Was ist 2+2?" });

			// Bot-Auslieferung: Placeholder + Final-Edit (Streaming).
			const placeholder = await waitForSentPlaceholder();
			await waitForFinalResponse();

			// Kern-Assertion: die eigene Bot-Message wird tatsächlich in einem
			// Poll-Batch geliefert …
			await expectBotMessagesDelivered(nc, [placeholder.id]);
			// … und die Watermark zieht darüber hinweg.
			await waitForWatermark(nc, placeholder.id);

			// … aber der Agent wurde genau EINMAL aufgerufen (nur die User-Message).
			expect(rpcMock.promptCalls).toHaveLength(1);
			expect(rpcMock.promptCalls[0].message.endsWith("\n\nWas ist 2+2?")).toBe(true);

			// Basic-Auth war auf jedem Request korrekt.
			expect(nc.authFailures).toBe(0);
		},
	);

	it(
		"2. Streaming-Edit-Sturm: viele PUTs auf dieselbe Bot-Message → keine Re-Triggerung",
		{ timeout: 20_000 },
		async () => {
			const room = await nextRoomToken();
			// Drei Deltas im Abstand > EDIT_THROTTLE_MS (400 ms) der Pipeline →
			// jeder Delta erzeugt eine eigene Edit (PUT) auf derselben Message-ID.
			rpcMock.streamDeltas = ["Delta Eins…", "Delta Zwei…", "Delta Drei…"];
			rpcMock.deltaDelayMs = 450;

			await startAdapter(room);
			await waitFor(() => nc.pollQueries.length >= 1, "erster Poll");

			nc.postMessage(room, { actorId: ALLOWED_USER, message: "Erzähl mir was." });

			const placeholder = await waitForSentPlaceholder();
			await waitForFinalResponse();

			// Edit-Sturm verifiziert: ≥ 3 Delta-Edits + 1 Final-Edit auf derselben ID.
			const editsOnBotMsg = nc.edits.filter((e) => e.id === placeholder.id);
			expect(editsOnBotMsg.length).toBeGreaterThanOrEqual(4);
			expect(editsOnBotMsg[editsOnBotMsg.length - 1].text).toBe(rpcMock.responseText);

			// Die (editierte) Bot-Message wurde gepollt und die Watermark zieht
			// darüber hinweg — Edits erzeugen nie neue Message-IDs, also auch nie
			// neue Eingaben.
			await expectBotMessagesDelivered(nc, [placeholder.id]);
			await waitForWatermark(nc, placeholder.id);

			expect(rpcMock.promptCalls).toHaveLength(1);
		},
	);

	it(
		"3. Chunked-Langantwort: mehrere NEUE eigene Bot-Message-IDs im Stream → kein 2ter Agent-Call",
		{ timeout: 20_000 },
		async () => {
			const room = await nextRoomToken();
			await startAdapter(room);
			await waitFor(() => nc.pollQueries.length >= 1, "erster Poll");

			nc.postMessage(room, { actorId: ALLOWED_USER, message: "Schreib viel." });

			const placeholder = await waitForSentPlaceholder();
			await waitForFinalResponse();

			// Simulation einer chunked Langantwort (>32k, N6): der Adapter bricht
			// Content in mehrere POSTs — jeder Chunk ist eine NEUE Bot-Message mit
			// eigener ID. Beide Chunks direkt in den Poll-Stream injizieren.
			const chunk2 = nc.postMessage(room, {
				actorId: BOT_USER,
				actorDisplayName: "Pi Bot",
				message: "[Chunk 2/3] Fortsetzung…",
			});
			const chunk3 = nc.postMessage(room, {
				actorId: BOT_USER,
				actorDisplayName: "Pi Bot",
				message: "[Chunk 3/3] Ende.",
			});

			// Alle drei eigenen Bot-Messages wurden tatsächlich geliefert …
			await expectBotMessagesDelivered(nc, [placeholder.id, chunk2.id, chunk3.id]);
			// … und die Watermark zieht über ALLE hinweg.
			await waitForWatermark(nc, chunk3.id);

			// Trotz dreier eigener Bot-Message-IDs: genau ein Agent-Call.
			expect(rpcMock.promptCalls).toHaveLength(1);
			expect(rpcMock.promptCalls[0].message.endsWith("\n\nSchreib viel.")).toBe(true);
		},
	);

	it(
		"4. Gemischte Batch: eigene Bot-Antwort + User-Message in EINEM Poll → genau ein Agent-Call pro User-Message",
		{ timeout: 30_000 },
		async () => {
			const room = await nextRoomToken();
			await startAdapter(room);
			// Long-Polls halten, bis ≥ 2 neue Messages pendend sind → der Poll,
			// der die Bot-Antwort auf Message 1 sieht, holt zwingend auch
			// Message 2 mit (deterministische gemischte Batch).
			nc.minPendingForDelivery = 2;

			nc.postMessage(room, { actorId: ALLOWED_USER, message: "Erste Frage" });
			const placeholder1 = await waitForSentPlaceholder();
			await waitForFinalResponse();

			// Zweite User-Message, während die erste Antwort im Raum liegt.
			nc.postMessage(room, { actorId: ALLOWED_USER, message: "Zweite Frage" });
			await waitForFinalResponse(2);

			// Gemischte Batch nachweisen: ein Batch enthielt sowohl die eigene
			// Bot-Message (placeholder1) als auch die zweite User-Message.
			const userMsgIds = nc.deliveredBatches
				.flatMap((b) => b.ids)
				.filter((id) => id !== placeholder1.id);
			expect(userMsgIds.length).toBeGreaterThanOrEqual(2);
			const mixedBatch = nc.deliveredBatches.find((b) => {
				if (!b.ids.includes(placeholder1.id)) return false;
				return b.ids.some((id) => id !== placeholder1.id);
			});
			expect(
				mixedBatch,
				"erwartete gemischte Batch (Bot-Antwort + User-Message im selben Poll)",
			).toBeDefined();

			// Watermark zieht über alles hinweg — aber genau EIN Agent-Call pro
			// User-Message, KEIN Call für die eigene Bot-Antwort.
			await waitForWatermark(nc, Math.max(...nc.deliveredBatches.flatMap((b) => b.ids)));
			expect(rpcMock.promptCalls).toHaveLength(2);
			expect(rpcMock.promptCalls[0].message.endsWith("\n\nErste Frage")).toBe(true);
			expect(rpcMock.promptCalls[1].message.endsWith("\n\nZweite Frage")).toBe(true);
		},
	);

	it(
		"5. Nicht-publishable Typen im Poll-Stream (System/Command/comment_deleted) → kein Agent-Call",
		{ timeout: 20_000 },
		async () => {
			const room = await nextRoomToken();
			await startAdapter(room);
			await waitFor(() => nc.pollQueries.length >= 1, "erster Poll");

			// System-Event (wird vom POLLER gefiltert: systemMessage !== "") …
			const systemMsg = nc.postMessage(room, {
				actorId: ALLOWED_USER,
				systemMessage: "talk_user_added",
				message: "Alice wurde dem Raum hinzugefügt",
			});
			// … `command` und `comment_deleted` von einem echten User (der Poller
			// lässt sie durch — der zentrale isPublishable-Filter im ADAPTER muss
			// sie fangen, sonst kämen sie in der Pipeline an).
			const commandMsg = nc.postMessage(room, {
				actorId: ALLOWED_USER,
				messageType: "command",
				message: "/irgendein-kommando",
			});
			const deletedMsg = nc.postMessage(room, {
				actorId: ALLOWED_USER,
				messageType: "comment_deleted",
				message: "gelöscht",
			});

			// Alle drei wurden tatsächlich in Poll-Batches geliefert …
			await expectBotMessagesDelivered(nc, [systemMsg.id, commandMsg.id, deletedMsg.id]);
			// … und die Watermark zieht über alle hinweg.
			await waitForWatermark(nc, deletedMsg.id);

			// KEIN Agent-Call für nicht-publishable Inhalte.
			expect(rpcMock.promptCalls).toHaveLength(0);
		},
	);

	it(
		"6. Ablehnungs-Loop: Bot-Ablehnungs-Message wird gepollt → kein Agent-Call",
		{ timeout: 20_000 },
		async () => {
			const room = await nextRoomToken();
			// Security-Config ohne erlaubte Uids (neu gelesen bei jedem Check).
			writeGatewayConfig({ allowedUids: {} });

			await startAdapter(room);
			await waitFor(() => nc.pollQueries.length >= 1, "erster Poll");

			nc.postMessage(room, { actorId: "mallory", message: "Hallo Bot" });

			// Die Pipeline lehnt ab und liefert die Ablehnung als Bot-Message aus.
			await waitFor(() => nc.sentMessages.length >= 1, "Ablehnungs-POST");
			const rejectMsg = nc.sentMessages[0];
			expect(rejectMsg.text).toBe(REJECT_TEXT);

			// Die Ablehnung wurde gepollt und die Watermark zieht darüber hinweg —
			// sie triggert keinen Agent-Call (es gab ja auch keinen ersten).
			await expectBotMessagesDelivered(nc, [rejectMsg.id]);
			await waitForWatermark(nc, rejectMsg.id);

			expect(rpcMock.promptCalls).toHaveLength(0);
		},
	);

	it(
		"7. Restart: Warm-Watermark verhindert Re-Emission eigener Bot-Antworten",
		{ timeout: 30_000 },
		async () => {
			const room = await nextRoomToken();

			// Phase 1: Adapter A verarbeitet die User-Message und antwortet.
			const adapterA = await startAdapter(room);
			await waitFor(() => nc.pollQueries.length >= 1, "erster Poll");
			nc.postMessage(room, { actorId: ALLOWED_USER, message: "Vor dem Restart" });
			const placeholder = await waitForSentPlaceholder();
			await waitForFinalResponse();
			expect(rpcMock.promptCalls).toHaveLength(1);

			// Die eigene Bot-Antwort wurde gepollt; Watermark liegt danach ≥ Bot-ID.
			await expectBotMessagesDelivered(nc, [placeholder.id]);
			await waitForWatermark(nc, placeholder.id);

			// Phase 2: Adapter stoppen (Watermark bleibt in der Talk-State-DB).
			await adapterA.stop();
			activeAdapter = null;
			const pollsBeforeRestart = nc.pollQueries.length;

			// Phase 3: Neuer Adapter, gleicher Raum → Warm-Start.
			await startAdapter(room);
			await waitFor(
				() => nc.pollQueries.length > pollsBeforeRestart,
				"Poll des neuen Adapters",
			);
			const restartPolls = nc.pollQueries.slice(pollsBeforeRestart);
			expect(restartPolls.length).toBeGreaterThanOrEqual(1);
			for (const q of restartPolls) {
				// Jede Poll-Query nach dem Restart muss die persistierte Watermark
				// nutzen → die eigene Bot-Antwort wird nie erneut ausgeliefert.
				expect(q.lastKnownMessageId).toBeGreaterThanOrEqual(placeholder.id);
			}

			// Phase 4: Neue Message → genau EIN weiterer Agent-Call (keine
			// Re-Emission der alten Bot-Antwort, kein Duplikat).
			nc.postMessage(room, { actorId: ALLOWED_USER, message: "Nach dem Restart" });
			await waitFor(() => rpcMock.promptCalls.length >= 2, "Agent-Call für neue Message");
			expect(rpcMock.promptCalls).toHaveLength(2);
			expect(rpcMock.promptCalls[1].message.endsWith("\n\nNach dem Restart")).toBe(true);
		},
	);
});
