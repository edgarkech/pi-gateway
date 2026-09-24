/**
 * E2E-Test — Gateway-seitiger Anti-Bot-Loop-Filter (Ansatz B,
 * docs/concept-anti-bot-loop-filter.md §§3/4/6).
 *
 * Ziel: Bei nicht-adressierter Gruppen-Nachricht (@Igor/@all fehlt) wird das
 * Modell DETERMINISTISCH nicht befragt → stumm, 0 gesendete Nachrichten, kein
 * Auslösestoff für Bot-auf-Bot-Ping-Pong. Zusätzlich: Gateway-Fallback (leere
 * Antwort → „I processed your message…") global unterbunden. DM/unklare Kanäle
 * bleiben intakt (Filter greift nur bei positiv erkannter Gruppe).
 *
 * Methodik (exakt wie `anti-loop-edge.test.ts` und `pipeline-nextcloud.test.ts`,
 * bewusst maximal echt):
 * - ECHT: NextcloudTalkAdapter inkl. TalkPoller (Long-Poll) + message-pipeline
 *   (`adapterCallbacks.onMessage`).
 * - MOCKED: ausschließlich die Agent-RPC-Schicht (`src/core/rpc.js`) und
 *   Nextcloud selbst (lokaler `node:http`-Mock).
 * - NON-VACUITY: jeder Test verifiziert, dass die relevante Message tatsächlich
 *   in einem Poll-Batch geliefert wurde — sonst wäre ein grüner Test wertlos
 *   (Filter nie ausgeführt).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { adapterCallbacks, classifyChannel } from "../../src/core/message-pipeline.js";
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
const FALLBACK_TEXT = "I processed your message but had no text response. Please try again.";

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
	const token = `anti-bot-group-${roomCounter}`;
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

describe("Anti-Bot-Loop (Ansatz B): Gruppen-Adressierung + Fallback-Unterbindung", () => {
	it(
		"Gruppe, NICHT adressiert → 0 Modell-Befragungen, 0 gesendete Nachrichten",
		{ timeout: 20_000 },
		async () => {
			const room = await nextRoomToken();
			// Determinisch als Gruppe werten (NC-Talk ohne DM-Flag).
			runtime.config.groupRooms = [`gateway:nextcloudTalk:${room}`];
			await startAdapter(room);
			await waitFor(() => nc.pollQueries.length >= 1, "erster Poll");

			// Bot-auf-Bot-Szenario: Account, der NICHT @-adressiert (ein Bot kann
			// auch als normaler User erscheinen — Festzurrungspunkt 2). Nachricht
			// enthält @NICHT-Igor, um zu zeigen, dass Klartext-/fremde Nennungen
			// NICHT adressieren (ADR Pkt. 3).
			const msg = nc.postMessage(room, {
				actorType: "users",
				actorId: ALLOWED_USER,
				actorDisplayName: "Pepe",
				message: "Hallo, kannst Du Igor's Notizen lesen?",
			});

			// Non-Vacuity: die Bot-Message wurde wirklich ausgeliefert + Watermark
			// zog über sie hinaus (der Filter lief also).
			await expectDelivered(nc, msg.id);
			await waitFor(
				() => nc.pollQueries.some((q) => q.lastKnownMessageId >= msg.id),
				"Watermark über der Bot-Message",
			);

			// DAS KERN-ERGEBNIS: kein Modell-Call und KEINE Auslieferung
			// (weder Platzhalter noch Stumm-Notiz) → kein Loop-Auslösestoff.
			await new Promise((r) => setTimeout(r, 100));
			expect(rpcMock.promptCalls).toHaveLength(0);
			expect(nc.sentMessages).toHaveLength(0);
		},
	);

	it(
		"Gruppe, @Igor-adressiert → genau 1 Modell-Befragung + Antwort",
		{ timeout: 20_000 },
		async () => {
			const room = await nextRoomToken();
			runtime.config.groupRooms = [`gateway:nextcloudTalk:${room}`];
			await startAdapter(room);
			await waitFor(() => nc.pollQueries.length >= 1, "erster Poll");

			const msg = nc.postMessage(room, {
				actorType: "users",
				actorId: ALLOWED_USER,
				actorDisplayName: "Pepe",
				message: "@Igor Was ist 2+2?",
			});

			await expectDelivered(nc, msg.id);
			await waitFor(() => rpcMock.promptCalls.length >= 1, "Modell-Call");
			await waitFor(
				() => nc.edits.some((e) => e.text === rpcMock.responseText),
				"Final-Edit",
			);

			expect(rpcMock.promptCalls).toHaveLength(1);
			expect(rpcMock.promptCalls[0].message.endsWith("\n\n@Igor Was ist 2+2?")).toBe(true);
		},
	);

	it(
		"Gruppe, @all-adressiert → passiert den Filter (Modell-Call)",
		{ timeout: 20_000 },
		async () => {
			const room = await nextRoomToken();
			runtime.config.groupRooms = [`gateway:nextcloudTalk:${room}`];
			await startAdapter(room);
			await waitFor(() => nc.pollQueries.length >= 1, "erster Poll");

			const msg = nc.postMessage(room, {
				actorId: ALLOWED_USER,
				message: "@all Wer ist heute im Dienst?",
			});

			await expectDelivered(nc, msg.id);
			await waitFor(() => rpcMock.promptCalls.length >= 1, "Modell-Call");
			expect(rpcMock.promptCalls).toHaveLength(1);
			expect(
				rpcMock.promptCalls[0].message.endsWith("\n\n@all Wer ist heute im Dienst?"),
			).toBe(true);
		},
	);

	it(
		"Leere Antwort → Gateway-Fallback global unterbunden (kein 'I processed…')",
		{ timeout: 20_000 },
		async () => {
			const room = await nextRoomToken();
			runtime.config.groupRooms = [`gateway:nextcloudTalk:${room}`];
			rpcMock.responseText = ""; // Modell liefert leeren Text
			await startAdapter(room);
			await waitFor(() => nc.pollQueries.length >= 1, "erster Poll");

			const msg = nc.postMessage(room, {
				actorId: ALLOWED_USER,
				message: "@Igor erzähl was",
			});

			await expectDelivered(nc, msg.id);
			await waitFor(() => rpcMock.promptCalls.length >= 1, "Modell-Call");

			// Warten, bis die Pipeline die leere Antwort verarbeitet hat
			// (supress falls deleteMessage im Mock fehlschlägt → nur Warten).
			await new Promise((r) => setTimeout(r, 200));

			expect(rpcMock.promptCalls).toHaveLength(1);
			// Kein „I processed…"-Fallback wurde gesendet (weder POST noch Edit).
			expect(nc.sentMessages.some((s) => s.text === FALLBACK_TEXT)).toBe(false);
			expect(nc.edits.some((e) => e.text === FALLBACK_TEXT)).toBe(false);
		},
	);

	it(
		"DM-intakt: Kanal ohne Gruppen-Flag (kein groupRooms) wird weiter verarbeitet",
		{ timeout: 20_000 },
		async () => {
			const room = await nextRoomToken();
			// KEIN groupRooms-Eintrag → classifyChannel = "unknown" → NICHT Gruppe
			// → Filter greift nicht (Randbedingung des Konzepts: DM intakt).
			runtime.config.groupRooms = [];
			await startAdapter(room);
			await waitFor(() => nc.pollQueries.length >= 1, "erster Poll");

			const msg = nc.postMessage(room, {
				actorId: ALLOWED_USER,
				message: "Hallo ohne Adressierung",
			});

			await expectDelivered(nc, msg.id);
			await waitFor(() => rpcMock.promptCalls.length >= 1, "Modell-Call");
			expect(rpcMock.promptCalls).toHaveLength(1);
		},
	);
});

describe("Anti-Bot-Loop (Ansatz B, §5a): Leer-Nachrichten-Filter (global)", () => {
	it(
		"Leer-Nachricht '.' in Gruppe, NICHT adressiert → 0 Modell-Calls, 0 gesendet",
		{ timeout: 20_000 },
		async () => {
			const room = await nextRoomToken();
			runtime.config.groupRooms = [`gateway:nextcloudTalk:${room}`];
			await startAdapter(room);
			await waitFor(() => nc.pollQueries.length >= 1, "erster Poll");

			const msg = nc.postMessage(room, {
				actorId: ALLOWED_USER,
				message: ".",
			});

			await expectDelivered(nc, msg.id);
			await waitFor(
				() => nc.pollQueries.some((q) => q.lastKnownMessageId >= msg.id),
				"Watermark über der Leer-Nachricht",
			);

			// KERN: kein Modell-Call, keine Auslieferung → kein Loop-Auslösestoff.
			await new Promise((r) => setTimeout(r, 100));
			expect(rpcMock.promptCalls).toHaveLength(0);
			expect(nc.sentMessages).toHaveLength(0);
		},
	);

	it(
		"Leer-Nachricht '.', GLOBAL auch im unknown-Kanal (kein groupRooms) ignoriert",
		{ timeout: 20_000 },
		async () => {
			const room = await nextRoomToken();
			// KEIN groupRooms-Eintrag → channelKind = "unknown". Der Leer-Filter
			// ist GLOBAL (alle Plattformen, alle Kanäle) und greift auch hier —
			// im Gegensatz zur Adressierungs-Regel (Ansatz B), die unknown-Kanäle
			// (DM) intakt lässt.
			runtime.config.groupRooms = [];
			await startAdapter(room);
			await waitFor(() => nc.pollQueries.length >= 1, "erster Poll");

			const msg = nc.postMessage(room, {
				actorId: ALLOWED_USER,
				message: ",",
			});

			await expectDelivered(nc, msg.id);
			await waitFor(
				() => nc.pollQueries.some((q) => q.lastKnownMessageId >= msg.id),
				"Watermark über der Leer-Nachricht",
			);

			await new Promise((r) => setTimeout(r, 100));
			expect(rpcMock.promptCalls).toHaveLength(0);
			expect(nc.sentMessages).toHaveLength(0);
		},
	);

	it(
		"Leer-Nachricht, aber @Igor-adressiert → Ausnahme, Modell wird befragt",
		{ timeout: 20_000 },
		async () => {
			const room = await nextRoomToken();
			runtime.config.groupRooms = [`gateway:nextcloudTalk:${room}`];
			await startAdapter(room);
			await waitFor(() => nc.pollQueries.length >= 1, "erster Poll");

			// Echte Adressierung: @Igor + ein Zeichen (Länge > 1 → nicht leer).
			const msg = nc.postMessage(room, {
				actorId: ALLOWED_USER,
				message: "@Igor",
			});

			await expectDelivered(nc, msg.id);
			await waitFor(() => rpcMock.promptCalls.length >= 1, "Modell-Call");
			expect(rpcMock.promptCalls).toHaveLength(1);
		},
	);

	it(
		"? ist echte Kommunikation → wird NICHT gefiltert (Modell-Call)",
		{ timeout: 20_000 },
		async () => {
			const room = await nextRoomToken();
			// KEIN groupRooms-Eintrag (unknown-Kanal): Ansatz B (Adressierung)
			// greift hier nicht — nur der Leer-Filter läuft. „?" ist echte
			// Kommunikation (Ausnahme in §5a) → Modell wird befragt.
			runtime.config.groupRooms = [];
			await startAdapter(room);
			await waitFor(() => nc.pollQueries.length >= 1, "erster Poll");

			const msg = nc.postMessage(room, {
				actorId: ALLOWED_USER,
				message: "?",
			});

			await expectDelivered(nc, msg.id);
			await waitFor(() => rpcMock.promptCalls.length >= 1, "Modell-Call");
			expect(rpcMock.promptCalls).toHaveLength(1);
		},
	);
});
