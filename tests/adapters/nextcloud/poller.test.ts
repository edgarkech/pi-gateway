/**
 * Phase 4 (S3) — NextcloudTalkPoller unit tests.
 *
 * Abdeckung nach Konzept §12 (Zeile 609, `poller.test.ts`):
 *   1. Long-Poll-Modus (304/200, Query-Parameter, X-Chat-Last-Given).
 *   2. Intervall-Modus (Rhythmus, lookIntoFuture=0).
 *   3. Backoff-Verhalten (exponentielle Verdopplung, Cap, Reset bei Erfolg).
 *   4. minPollIntervalMs (kein Poll schneller als X).
 *   5. Circuit Breaker (Schwellwert, ROOM_NOT_FOUND → sofort, AUTH_FAILED →
 *      dauerhafte Pause bis Restart).
 *   6. Wasserstands-Persistenz (erst NACH komplettem Batch, at-least-once
 *      Redelivery bei Callback-Fehler).
 *   7. Last-Steuerung (Slot-Semaphore maxConcurrentPolls, activePolls).
 *   8. Lifecycle (start/stop, Warm-Start, Raum-Dedup, onState-Isolation).
 *   9. Anti-Loop-Filter (D4/§5.3): eigene Bot-Nachrichten, System-Nachrichten
 *      und Bot-Aktoren werden nicht emittiert — der Offset wird aber trotzdem
 *      fortgeschrieben (sonst würde der Server sie ewig neu liefern).
 *  10. Room-Prune (§5.2): `start(rooms, { pruneRemovedRooms: true })` entfernt
 *      persistierte Wasserstände für nicht mehr konfigurierte Räume.
 *
 * Methodik nach Konzept §12 ("Fake OcsClient + talk_state in tmp-Dir"):
 * Fake `OcsClient` mit skriptierten Antworten + In-Memory-`TalkStateStore` —
 * keine echte Nextcloud, kein SQLite (die Store-Schnittstelle ist exakt der
 * Kontrakt, den `defaultTalkStateStore` aus S2 erfüllt; die SQLite-Details
 * sind in store.test.ts abgedeckt).
 *
 * Timing: echte Timer mit kleinen Werten (ms-Bereich). Assertions zielen auf
 * Struktur, Emissions-Reihenfolge und Zustands-Snapshots statt auf
 * Wanduhr-Präzision — deterministisch ohne Fake-Clock.
 */

import { afterEach, describe, expect, it } from "vitest";

import { TalkError } from "../../../src/adapters/nextcloud/ocs.js";
import {
	NextcloudTalkPoller,
	type PollerState,
	type TalkPollerConfig,
	type TalkPollerOptions,
	type TalkReceiveChatQuery,
	type TalkReceiveChatResult,
	type TalkStateStore,
} from "../../../src/adapters/nextcloud/poller.js";
import type { TalkChatMessage } from "../../../src/adapters/nextcloud/talk-types.js";

// ── Test-Helfer ────────────────────────────────────────────────────────────────

/** Builder für eine realistische Talk-Chat-Nachricht (wie ocs.test.ts). */
function talkMessage(overrides: Partial<TalkChatMessage> = {}): TalkChatMessage {
	return {
		id: 501,
		token: "room-tok",
		actorType: "users",
		actorId: "alice",
		actorDisplayName: "Alice",
		timestamp: 1_700_000_000,
		systemMessage: "",
		messageType: "comment",
		message: "hello",
		messageParameters: {},
		...overrides,
	};
}

/** 200-Ergebnis mit Nachrichten-Batch (optional X-Chat-Last-Given). */
function batchResult(ids: number[], xChatLastGiven?: number): TalkReceiveChatResult {
	return {
		status: 200,
		messages: ids.map((id) => talkMessage({ id })),
		...(xChatLastGiven !== undefined ? { xChatLastGiven } : {}),
	};
}

/** 304-Ergebnis ("nichts Neues"). */
const idleResult: TalkReceiveChatResult = { status: 304, messages: [] };

/** Skript-Eintrag: festes Ergebnis, zu werfender Error oder dynamische Funktion. */
type ScriptEntry =
	| TalkReceiveChatResult
	| Error
	| ((
			room: string,
			q: TalkReceiveChatQuery,
	  ) => TalkReceiveChatResult | Promise<TalkReceiveChatResult>);

interface CallRecord {
	room: string;
	query: TalkReceiveChatQuery;
	at: number;
}

/**
 * Fake OcsClient: liefert skriptierte Antworten der Reihe nach (nach
 * Erschöpfung des Skripts ewig 304 = inaktiver Raum). Protokolliert Aufrufe
 * mit Zeitstempel und zählt die parallel offenen Requests (für den
 * Slot-Semaphore-Test).
 */
class FakeOcsClient {
	readonly calls: CallRecord[] = [];
	inFlight = 0;
	maxInFlight = 0;
	/** Protokoll aller setReadMarker-Aufrufe (P2a). */
	readonly setReadMarkerCalls: Array<{ room: string; id: number }> = [];
	/** Wenn gesetzt: setReadMarker wirft diesen Fehler (Best-Effort-Test). */
	setReadMarkerError?: Error;
	private script: ScriptEntry[];

	constructor(script: ScriptEntry[] = []) {
		this.script = [...script];
	}

	callsFor(room: string): CallRecord[] {
		return this.calls.filter((c) => c.room === room);
	}

	setReadMarker(room: string, messageId: number): Promise<void> {
		this.setReadMarkerCalls.push({ room, id: messageId });
		return this.setReadMarkerError
			? Promise.reject(this.setReadMarkerError)
			: Promise.resolve();
	}

	receiveChat(room: string, q: TalkReceiveChatQuery): Promise<TalkReceiveChatResult> {
		const entry: ScriptEntry =
			this.script.length > 0 ? (this.script.shift() as ScriptEntry) : idleResult;
		this.calls.push({ room, query: q, at: Date.now() });
		this.inFlight += 1;
		this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);

		const value: TalkReceiveChatResult | Promise<TalkReceiveChatResult> =
			entry instanceof Error
				? Promise.reject(entry)
				: typeof entry === "function"
					? entry(room, q)
					: entry;

		return Promise.resolve(value).then(
			(res) => {
				this.inFlight -= 1;
				return res;
			},
			(err) => {
				this.inFlight -= 1;
				throw err;
			},
		);
	}
}

/** In-Memory-Wasserstands-Store (statt SQLite, vgl. Konzept §12). */
class FakeStore implements TalkStateStore {
	values = new Map<string, number>();
	sets: Array<{ room: string; id: number }> = [];
	/** Protokoll aller pruneRooms-Aufrufe (für Room-Prune-Assertions). */
	pruneCalls: string[][] = [];
	private readonly onSet?: (room: string, id: number) => void;
	private readonly pruneImpl?: (roomTokens: string[]) => number;

	constructor(
		onSet?: (room: string, id: number) => void,
		pruneImpl?: (roomTokens: string[]) => number,
	) {
		this.onSet = onSet;
		this.pruneImpl = pruneImpl;
	}

	seed(room: string, id: number): void {
		this.values.set(room, id);
	}

	getLastKnownMessageId(roomToken: string): number {
		return this.values.get(roomToken) ?? 0;
	}

	setLastKnownMessageId(roomToken: string, lastKnownMessageId: number): void {
		this.values.set(roomToken, lastKnownMessageId);
		this.sets.push({ room: roomToken, id: lastKnownMessageId });
		this.onSet?.(roomToken, lastKnownMessageId);
	}

	getAllStates(): Record<string, number> {
		return Object.fromEntries(this.values);
	}

	pruneRooms(roomTokens: string[]): number {
		this.pruneCalls.push([...roomTokens]);
		if (this.pruneImpl) return this.pruneImpl(roomTokens);
		let removed = 0;
		for (const room of roomTokens) {
			if (this.values.delete(room)) removed += 1;
		}
		return removed;
	}
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Pollt `cond`, bis es true ist oder das Timeout abläuft (echte Timer). */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
	const t0 = Date.now();
	while (!cond()) {
		if (Date.now() - t0 > timeoutMs) {
			throw new Error(`waitFor: Bedingung nicht erfüllt innerhalb von ${timeoutMs} ms`);
		}
		await sleep(3);
	}
}

/** Skript-Eintrag, der den Request `ms` lang offen hält (Slot-Semaphore-Tests). */
function holdFor(ms: number): ScriptEntry {
	return () =>
		new Promise<TalkReceiveChatResult>((resolve) => setTimeout(() => resolve(idleResult), ms));
}

// ── Anti-Loop-Nachrichten-Baukasten (D4/§5.3) ────────────────────────────────

/** Echte User-Nachricht (publishable). */
function userMsg(id: number, actorId = "alice"): TalkChatMessage {
	return talkMessage({ id, actorType: "users", actorId });
}

/** Eigene Bot-Nachricht (Gateway-Antwort — muss NICHT re-emittiert werden). */
function ownMsg(id: number, userId = "bot-gw"): TalkChatMessage {
	return talkMessage({ id, actorType: "users", actorId: userId });
}

/** System-Event (z. B. message_deleted — kein User-Input). */
function systemMsg(id: number): TalkChatMessage {
	return talkMessage({ id, systemMessage: "message_deleted", messageType: "system" });
}

/** Nachricht eines Talk-Bot-Accounts (actorType "bots"). */
function botMsg(id: number): TalkChatMessage {
	return talkMessage({ id, actorType: "bots", actorId: "other-bot" });
}

// ── Harness ────────────────────────────────────────────────────────────────────

interface Harness {
	poller: NextcloudTalkPoller;
	client: FakeOcsClient;
	store: FakeStore;
	/** Alle via onMessage erhaltenen Nachrichten (inkl. fehlgeschlagener Versuche). */
	messages: TalkChatMessage[];
	/** Alle via onState emittierten PollerState-Snapshots (Historie). */
	states: PollerState[];
	/** Ereignislog "msg:<id>" / "set:<room>:<id>" — für Reihenfolge-Assertions. */
	events: string[];
}

function makePoller(
	opts: {
		script?: ScriptEntry[];
		config?: TalkPollerConfig;
		seed?: Record<string, number>;
		onMessage?: (msg: TalkChatMessage) => void;
		onStateThrows?: boolean;
		/** Override für FakeStore.pruneRooms (z. B. um Fehler zu simulieren). */
		pruneImpl?: (roomTokens: string[]) => number;
	} = {},
): Harness {
	const client = new FakeOcsClient(opts.script ?? []);
	const events: string[] = [];
	const store = new FakeStore((room, id) => events.push(`set:${room}:${id}`), opts.pruneImpl);
	for (const [room, id] of Object.entries(opts.seed ?? {})) store.seed(room, id);

	const messages: TalkChatMessage[] = [];
	const states: PollerState[] = [];

	const poller = new NextcloudTalkPoller(client, {
		config: opts.config,
		store,
		onMessage: (msg) => {
			messages.push(msg);
			events.push(`msg:${msg.id}`);
			opts.onMessage?.(msg);
		},
		onState: (state) => {
			states.push(state);
			if (opts.onStateThrows) throw new Error("onState-Boom");
		},
	});

	return { poller, client, store, messages, states, events };
}

// Stellt sicher, dass nach jedem Test keine Loops/Timer überleben.
const active: Harness[] = [];
function track(h: Harness): Harness {
	active.push(h);
	return h;
}

afterEach(async () => {
	for (const h of active) await h.poller.stop();
	active.length = 0;
});

// ── 1. Konstruktor & Config-Validierung (Fail-Fast) ───────────────────────────

describe("NextcloudTalkPoller — Konstruktor & Config-Validierung", () => {
	const fakeClient = () => new FakeOcsClient();

	it("wirft ohne onMessage-Callback", () => {
		expect(
			() => new NextcloudTalkPoller(fakeClient(), {} as unknown as TalkPollerOptions),
		).toThrow(/onMessage/);
	});

	it("akzeptiert die Default-Config (keine Config)", () => {
		expect(() => new NextcloudTalkPoller(fakeClient(), { onMessage: () => {} })).not.toThrow();
	});

	it("wirft bei ungültigem pollMode", () => {
		expect(
			() =>
				new NextcloudTalkPoller(fakeClient(), {
					onMessage: () => {},
					config: { pollMode: "sometimes" } as unknown as TalkPollerConfig,
				}),
		).toThrow(/pollMode/);
	});

	it("validiert longPollTimeoutSeconds (Ganzzahl in [0, 60])", () => {
		for (const bad of [-1, 61, 2.5]) {
			expect(
				() =>
					new NextcloudTalkPoller(fakeClient(), {
						onMessage: () => {},
						config: { longPollTimeoutSeconds: bad } as TalkPollerConfig,
					}),
			).toThrow(/longPollTimeoutSeconds/);
		}
		// Randwerte sind gültig.
		for (const ok of [0, 60]) {
			expect(
				() =>
					new NextcloudTalkPoller(fakeClient(), {
						onMessage: () => {},
						config: { longPollTimeoutSeconds: ok } as TalkPollerConfig,
					}),
			).not.toThrow();
		}
	});

	it("validiert intervalMs und minPollIntervalMs (> 0)", () => {
		for (const bad of [0, -5]) {
			expect(
				() =>
					new NextcloudTalkPoller(fakeClient(), {
						onMessage: () => {},
						config: { intervalMs: bad } as TalkPollerConfig,
					}),
			).toThrow(/intervalMs/);
			expect(
				() =>
					new NextcloudTalkPoller(fakeClient(), {
						onMessage: () => {},
						config: { minPollIntervalMs: bad } as TalkPollerConfig,
					}),
			).toThrow(/minPollIntervalMs/);
		}
	});

	it("validiert backoffMaxMs (>= minPollIntervalMs)", () => {
		expect(
			() =>
				new NextcloudTalkPoller(fakeClient(), {
					onMessage: () => {},
					config: { minPollIntervalMs: 100, backoffMaxMs: 50 } as TalkPollerConfig,
				}),
		).toThrow(/backoffMaxMs/);
	});

	it("validiert maxConcurrentPolls (Ganzzahl >= 1)", () => {
		for (const bad of [0, 1.5]) {
			expect(
				() =>
					new NextcloudTalkPoller(fakeClient(), {
						onMessage: () => {},
						config: { maxConcurrentPolls: bad } as TalkPollerConfig,
					}),
			).toThrow(/maxConcurrentPolls/);
		}
	});

	it("validiert circuitThreshold (Ganzzahl >= 1)", () => {
		expect(
			() =>
				new NextcloudTalkPoller(fakeClient(), {
					onMessage: () => {},
					config: { circuitThreshold: 0 } as TalkPollerConfig,
				}),
		).toThrow(/circuitThreshold/);
	});

	it("validiert batchLimit (Ganzzahl in [1, 100], D9)", () => {
		for (const bad of [0, 101]) {
			expect(
				() =>
					new NextcloudTalkPoller(fakeClient(), {
						onMessage: () => {},
						config: { batchLimit: bad } as TalkPollerConfig,
					}),
			).toThrow(/batchLimit/);
		}
		for (const ok of [1, 100]) {
			expect(
				() =>
					new NextcloudTalkPoller(fakeClient(), {
						onMessage: () => {},
						config: { batchLimit: ok } as TalkPollerConfig,
					}),
			).not.toThrow();
		}
	});
});

// ── 2. Lifecycle (start/stop) ──────────────────────────────────────────────────

describe("NextcloudTalkPoller — Lifecycle", () => {
	it("getState() vor start: running=false, keine Räume", () => {
		const h = track(makePoller());
		const s = h.poller.getState();
		expect(s.running).toBe(false);
		expect(s.rooms).toEqual([]);
	});

	it("start() emittiert onState mit running=true und lädt Warm-Start-Wasserstände aus der Store", async () => {
		const h = track(
			makePoller({ seed: { r1: 501, r2: 77 }, config: { minPollIntervalMs: 10 } }),
		);
		h.poller.start(["r1", "r2"]);

		expect(h.states.at(-1)?.running).toBe(true);
		await waitFor(
			() => h.client.callsFor("r1").length >= 1 && h.client.callsFor("r2").length >= 1,
		);
		// Exakt dort weitermachen, wo die Store gelassen hat (D3: kein
		// Re-Processing, kein Überspringen).
		expect(h.client.callsFor("r1")[0].query.lastKnownMessageId).toBe(501);
		expect(h.client.callsFor("r2")[0].query.lastKnownMessageId).toBe(77);
	});

	it("start() wirft, wenn bereits läuft", () => {
		const h = track(makePoller());
		h.poller.start(["r"]);
		expect(() => h.poller.start(["r"])).toThrow(/bereits läuft/);
	});

	it("start() wirft bei leerem Raum-Token", () => {
		const h = track(makePoller());
		expect(() => h.poller.start(["ok", "   "])).toThrow(/leeren Token/);
	});

	it("dedupliziert doppelte Räume (ein Loop pro Raum)", async () => {
		const h = track(makePoller({ config: { minPollIntervalMs: 10 } }));
		h.poller.start(["r", "r"]);
		expect(h.poller.getState().rooms).toHaveLength(1);
		await waitFor(() => h.client.callsFor("r").length >= 2);
	});

	it("stop() vor start ist ein No-Op", async () => {
		const h = track(makePoller());
		await expect(h.poller.stop()).resolves.toBeUndefined();
		expect(h.poller.getState().running).toBe(false);
	});

	it("stop() beendet alle Loops; Wasserstände bleiben erhalten", async () => {
		const h = track(
			makePoller({ script: [batchResult([1, 2, 3])], config: { minPollIntervalMs: 10 } }),
		);
		h.poller.start(["r"]);
		await waitFor(() => h.store.sets.length === 1);

		await h.poller.stop();
		expect(h.poller.getState().running).toBe(false);

		const callsAfterStop = h.client.calls.length;
		await sleep(60);
		expect(h.client.calls.length).toBe(callsAfterStop); // keine neuen Polls nach stop()
		expect(h.store.sets).toEqual([{ room: "r", id: 3 }]);
	});

	it("stop() ist idempotent", async () => {
		const h = track(makePoller());
		h.poller.start(["r"]);
		await h.poller.stop();
		await expect(h.poller.stop()).resolves.toBeUndefined();
	});
});

// ── 3. Long-Poll-Modus (Default) ───────────────────────────────────────────────

describe("NextcloudTalkPoller — Long-Poll-Modus", () => {
	it("sendet korrekte Query-Parameter (lookIntoFuture=1, timeout, limit)", async () => {
		const h = track(makePoller({ seed: { r: 42 } }));
		h.poller.start(["r"]);
		await waitFor(() => h.client.calls.length >= 1);

		expect(h.client.calls[0].query).toEqual({
			lookIntoFuture: 1,
			timeout: 30,
			lastKnownMessageId: 42,
			limit: 100,
		});
	});

	it("respektiert Custom-Config (longPollTimeoutSeconds, batchLimit)", async () => {
		const h = track(makePoller({ config: { longPollTimeoutSeconds: 5, batchLimit: 25 } }));
		h.poller.start(["r"]);
		await waitFor(() => h.client.calls.length >= 1);

		expect(h.client.calls[0].query).toMatchObject({ lookIntoFuture: 1, timeout: 5, limit: 25 });
	});

	it("liefert Batch-Nachrichten in Reihenfolge und persistiert erst nach dem kompletten Batch (D3/N7)", async () => {
		const h = track(makePoller({ script: [batchResult([501, 502])] }));
		h.poller.start(["r"]);
		await waitFor(() => h.store.sets.length === 1);

		expect(h.messages.map((m) => m.id)).toEqual([501, 502]);
		// Ereignisreihenfolge: msg:501 → msg:502 → set:r:502 (Persist erst nach
		// vollständiger Verarbeitung des Batches).
		const i501 = h.events.indexOf("msg:501");
		const i502 = h.events.indexOf("msg:502");
		const iset = h.events.lastIndexOf("set:r:502");
		expect(i501).toBeGreaterThanOrEqual(0);
		expect(i502).toBeGreaterThan(i501);
		expect(iset).toBeGreaterThan(i502);
	});

	it("304 → keine onMessage, kein Persist, Offset bleibt unverändert", async () => {
		const h = track(makePoller({ seed: { r: 501 }, config: { minPollIntervalMs: 20 } }));
		h.poller.start(["r"]);
		await waitFor(() => h.client.callsFor("r").length >= 2);

		expect(h.messages).toHaveLength(0);
		expect(h.store.sets).toHaveLength(0);
		// Offset bleibt beim Warm-Start-Wert.
		expect(h.client.callsFor("r")[1].query.lastKnownMessageId).toBe(501);
	});

	it("X-Chat-Last-Given bestimmt den nächsten Offset", async () => {
		const h = track(
			makePoller({ script: [batchResult([501], 505)], config: { minPollIntervalMs: 20 } }),
		);
		h.poller.start(["r"]);
		await waitFor(() => h.store.sets.length === 1);

		expect(h.store.sets[0].id).toBe(505);
		await waitFor(() => h.client.callsFor("r").length >= 2);
		expect(h.client.callsFor("r")[1].query.lastKnownMessageId).toBe(505);
	});

	it("defensives Dedup: Nachrichten mit id <= Offset werden nicht erneut geliefert", async () => {
		const h = track(makePoller({ seed: { r: 501 }, script: [batchResult([501, 502])] }));
		h.poller.start(["r"]);
		await waitFor(() => h.store.sets.length === 1);

		expect(h.messages.map((m) => m.id)).toEqual([502]);
		expect(h.store.sets[0].id).toBe(502);
	});

	it("filtert Nachrichten mit nicht-endlichem id", async () => {
		const h = track(
			makePoller({
				script: [
					{
						status: 200,
						messages: [talkMessage({ id: Number.NaN }), talkMessage({ id: 502 })],
					},
				],
			}),
		);
		h.poller.start(["r"]);
		await waitFor(() => h.store.sets.length === 1);

		expect(h.messages.map((m) => m.id)).toEqual([502]);
	});

	it("onMessage-Fehler → kein Persist, Redelivery im nächsten Poll (at-least-once)", async () => {
		let threwOnce = false;
		const h = track(
			makePoller({
				script: [batchResult([501, 502]), batchResult([501, 502])],
				config: { minPollIntervalMs: 10 },
				onMessage: (msg) => {
					if (msg.id === 501 && !threwOnce) {
						threwOnce = true;
						throw new Error("pipeline down");
					}
				},
			}),
		);
		h.poller.start(["r"]);
		await waitFor(() => h.store.sets.length === 1, 3000);

		// Persist genau einmal — nach dem erfolgreich redelivered Batch.
		expect(h.store.sets).toEqual([{ room: "r", id: 502 }]);
		// 501 wurde zweimal zugestellt (fehlgeschlagener Erstversuch + Redelivery),
		// 502 genau einmal.
		expect(h.messages.map((m) => m.id)).toEqual([501, 501, 502]);
	});
});

// ── 4. Fehlerbehandlung & Backoff (§11) ────────────────────────────────────────

describe("NextcloudTalkPoller — Fehlerbehandlung & Backoff", () => {
	it("verdoppelt den Backoff pro Fehler (mit Cap) und setzt bei Erfolg zurück", async () => {
		const h = track(
			makePoller({
				script: [
					new TalkError("HTTP_500", "boom"),
					new TalkError("HTTP_500", "boom"),
					idleResult,
				],
				config: { minPollIntervalMs: 10, backoffMaxMs: 30, circuitThreshold: 5 },
			}),
		);
		h.poller.start(["r"]);

		// Nach Fehler 1: Backoff 2*10=20 ms; nach Fehler 2: min(40, 30)=30 ms (Cap).
		await waitFor(() => h.states.some((s) => s.rooms[0]?.consecutiveErrors === 2));
		const errStates = h.states.filter((s) => s.rooms[0]?.status === "backoff");
		expect(errStates.map((s) => s.rooms[0].backoffMs)).toEqual([20, 30]);
		// Log-sichere Fehlerbeschreibung: TalkError-Code + Message.
		expect(errStates[0].rooms[0].lastError).toBe("HTTP_500: boom");

		// Erfolg (3. Aufruf) setzt Zähler, Backoff und Status zurück.
		await waitFor(() => h.client.calls.length >= 3);
		const room = h.poller.getState().rooms[0];
		expect(room.status).toBe("polling");
		expect(room.consecutiveErrors).toBe(0);
		expect(room.backoffMs).toBe(10);
	});

	it("Circuit Breaker: offen nach circuitThreshold Fehlern, Probe nach backoffMaxMs", async () => {
		const h = track(
			makePoller({
				script: [
					new TalkError("HTTP_500", "e1"),
					new TalkError("HTTP_500", "e2"),
					new TalkError("HTTP_500", "e3"),
					idleResult,
				],
				config: { minPollIntervalMs: 10, backoffMaxMs: 60, circuitThreshold: 3 },
			}),
		);
		h.poller.start(["r"]);

		await waitFor(() => h.states.some((s) => s.rooms[0]?.status === "circuit-open"));
		const open = h.states.find((s) => s.rooms[0]?.status === "circuit-open");
		expect(open?.rooms[0]?.consecutiveErrors).toBe(3);

		// Nach der backoffMaxMs-Pause: frische Probe (4. Aufruf) erfolgreich → Reset.
		await waitFor(() => h.client.calls.length >= 4, 3000);
		const room = h.poller.getState().rooms[0];
		expect(room.status).toBe("polling");
		expect(room.consecutiveErrors).toBe(0);
	});

	it("AUTH_FAILED: Raum pausiert bis Config-Änderung/Restart (N1)", async () => {
		const h = track(makePoller({ script: [new TalkError("AUTH_FAILED", "401")] }));
		h.poller.start(["r"]);

		await waitFor(() => h.poller.getState().rooms[0]?.status === "auth-failed");
		const callsAfter = h.client.calls.length;
		await sleep(80);
		expect(h.client.calls.length).toBe(callsAfter); // keine weiteren Polls
	});

	it("ROOM_NOT_FOUND: sofortiger Circuit-Break + Probe nach backoffMaxMs (N2)", async () => {
		const h = track(
			makePoller({
				script: [new TalkError("ROOM_NOT_FOUND", "404"), idleResult],
				config: { minPollIntervalMs: 10, backoffMaxMs: 50 },
			}),
		);
		h.poller.start(["r"]);

		await waitFor(() => h.states.some((s) => s.rooms[0]?.status === "circuit-open"));
		// Circuit ist bereits nach dem ERSTEN Fehler offen (unabhängig vom Zähler).
		const open = h.states.find((s) => s.rooms[0]?.status === "circuit-open");
		expect(open?.rooms[0]?.consecutiveErrors).toBe(1);

		await waitFor(() => h.client.calls.length >= 2, 3000); // Probe nach der Pause
		expect(h.poller.getState().rooms[0]?.status).toBe("polling");
	});

	it("lastError trägt die log-sichere Beschreibung (plain Error → message)", async () => {
		const h = track(makePoller({ script: [new Error("boom")] }));
		h.poller.start(["r"]);
		await waitFor(() => h.poller.getState().rooms[0]?.lastError === "boom");
	});
});

// ── 5. Last-Steuerung (D9) ─────────────────────────────────────────────────────

describe("NextcloudTalkPoller — Last-Steuerung", () => {
	it("pollt nie schneller als minPollIntervalMs", async () => {
		const h = track(makePoller({ config: { minPollIntervalMs: 30 } }));
		h.poller.start(["r"]);
		await waitFor(() => h.client.calls.length >= 4, 3000);

		const ts = h.client.calls.map((c) => c.at);
		for (let i = 1; i < ts.length; i += 1) {
			// 30 ms − 5 ms Toleranz: unter Parallel-Last (fileParallelism) kann der
			// Timer um wenige ms früh feuern. Eine echte Regression (fehlende
			// Min-Intervall-Logik) würde Intervalle im einstelligen ms-Bereich
			// liefern und wird damit weiterhin zuverlässig erwischt.
			expect(ts[i] - ts[i - 1]).toBeGreaterThanOrEqual(25);
		}
	});

	it("begrenzt offene Polls auf maxConcurrentPolls (Slot-Semaphore)", async () => {
		const h = track(
			makePoller({
				script: Array.from({ length: 12 }, () => holdFor(40)),
				config: { minPollIntervalMs: 5, maxConcurrentPolls: 1 },
			}),
		);
		h.poller.start(["r1", "r2"]);

		await waitFor(() => h.client.calls.length >= 8, 5000);
		expect(h.client.maxInFlight).toBe(1);
		// Beide Räume werden bedient (FIFO-Übergabe des Slots).
		expect(h.client.callsFor("r1").length).toBeGreaterThanOrEqual(1);
		expect(h.client.callsFor("r2").length).toBeGreaterThanOrEqual(1);
	});

	it("getState().activePolls spiegelt offene Polls", async () => {
		const h = track(makePoller({ script: [holdFor(60)] }));
		h.poller.start(["r"]);

		await waitFor(() => h.poller.getState().activePolls === 1);
		expect(h.poller.getState().activePolls).toBe(1);
		await waitFor(() => h.poller.getState().activePolls === 0, 3000);
	});
});

// ── 6. Intervall-Modus ─────────────────────────────────────────────────────────

describe("NextcloudTalkPoller — Intervall-Modus", () => {
	it("sendet lookIntoFuture=0 ohne timeout-Parameter", async () => {
		const h = track(
			makePoller({ config: { pollMode: "interval", intervalMs: 25, minPollIntervalMs: 5 } }),
		);
		h.poller.start(["r"]);
		await waitFor(() => h.client.calls.length >= 1);

		expect(h.client.calls[0].query).toEqual({
			lookIntoFuture: 0,
			lastKnownMessageId: 0,
			limit: 100,
		});
	});

	it("pollt im Rhythmus von intervalMs (Zyklus >= intervalMs, Loop bleibt am Leben)", async () => {
		const h = track(
			makePoller({ config: { pollMode: "interval", intervalMs: 25, minPollIntervalMs: 5 } }),
		);
		h.poller.start(["r"]);
		await waitFor(() => h.client.calls.length >= 5, 3000);

		const ts = h.client.calls.map((c) => c.at);
		for (let i = 1; i < ts.length; i += 1) {
			// Zykluszeit mindestens intervalMs (Auffüllen ab letztem Response).
			expect(ts[i] - ts[i - 1]).toBeGreaterThanOrEqual(23);
		}
	});
});

// ── 7. Zustand & Callbacks ─────────────────────────────────────────────────────

describe("NextcloudTalkPoller — Zustand & Callbacks", () => {
	it("onState wird beim Start mit running=true aufgerufen", () => {
		const h = track(makePoller());
		h.poller.start(["r"]);
		expect(h.states.at(-1)).toMatchObject({ running: true, pollMode: "long-poll" });
		expect(h.states.at(-1)?.rooms).toHaveLength(1);
	});

	it("werfender onState-Callback crash't den Poller nicht", async () => {
		const h = track(makePoller({ config: { minPollIntervalMs: 15 }, onStateThrows: true }));
		h.poller.start(["r"]);
		await waitFor(() => h.client.calls.length >= 3, 3000); // pollt weiter
	});

	it("getState() liefert pro Raum einen Snapshot mit Wasserstand & Backoff", async () => {
		const h = track(makePoller({ seed: { r: 9 }, script: [batchResult([10])] }));
		h.poller.start(["r"]);
		await waitFor(() => h.store.sets.length === 1);

		const room = h.poller.getState().rooms[0];
		expect(room.room).toBe("r");
		expect(room.status).toBe("polling");
		expect(room.lastKnownMessageId).toBe(10);
		expect(typeof room.lastPollAt).toBe("number");
		expect(typeof room.lastLatencyMs).toBe("number");
		expect(room.filteredMessages).toBe(0);
	});
});

// ── 8. Anti-Loop-Filter (D4/§5.3) ────────────────────────────────────────────

describe("NextcloudTalkPoller — Anti-Loop-Filter (D4)", () => {
	it("verwirft eigene Nachrichten (actorId === ownUserId); Offset springt darüber hinweg", async () => {
		const h = track(
			makePoller({
				config: { ownUserId: "bot-gw", minPollIntervalMs: 10 },
				script: [{ status: 200, messages: [userMsg(501), ownMsg(502)] }],
			}),
		);
		h.poller.start(["r"]);
		await waitFor(() => h.store.sets.length === 1);

		// Nur die echte User-Nachricht wird emittiert — die eigene Antwort des
		// Bots (502) löst KEINE neue Pipeline-Auslösung aus (Loop-Schutz).
		expect(h.messages.map((m) => m.id)).toEqual([501]);
		// ABER: der Wasserstand wird über die verworfene Nachricht fortgeschrieben
		// (§5.3: "verwerfen (nur Offset fortschreiben)") — sonst würde der Server
		// 502 bei jedem Poll erneut liefern.
		expect(h.store.sets).toEqual([{ room: "r", id: 502 }]);
		await waitFor(() => h.client.callsFor("r").length >= 2);
		expect(h.client.callsFor("r")[1].query.lastKnownMessageId).toBe(502);
		expect(h.poller.getState().rooms[0]?.filteredMessages).toBe(1);
	});

	it('verwirft System-Nachrichten (systemMessage !== "") — auch ohne ownUserId', async () => {
		const h = track(
			makePoller({
				config: { minPollIntervalMs: 10 },
				script: [{ status: 200, messages: [systemMsg(501), userMsg(502)] }],
			}),
		);
		h.poller.start(["r"]);
		await waitFor(() => h.store.sets.length === 1);

		expect(h.messages.map((m) => m.id)).toEqual([502]);
		expect(h.store.sets).toEqual([{ room: "r", id: 502 }]);
		expect(h.poller.getState().rooms[0]?.filteredMessages).toBe(1);
	});

	it('verwirft Bot-Aktoren (actorType === "bots")', async () => {
		const h = track(
			makePoller({
				config: { minPollIntervalMs: 10 },
				script: [{ status: 200, messages: [botMsg(501), userMsg(502)] }],
			}),
		);
		h.poller.start(["r"]);
		await waitFor(() => h.store.sets.length === 1);

		expect(h.messages.map((m) => m.id)).toEqual([502]);
		expect(h.poller.getState().rooms[0]?.filteredMessages).toBe(1);
	});

	it("Mixed-Batch: nur echte User-Nachrichten emittiert, Offset = max(id) des Batches", async () => {
		const h = track(
			makePoller({
				config: { ownUserId: "bot-gw", minPollIntervalMs: 10 },
				script: [
					{
						status: 200,
						messages: [
							userMsg(501),
							ownMsg(502),
							systemMsg(503),
							botMsg(504),
							userMsg(505),
						],
					},
				],
			}),
		);
		h.poller.start(["r"]);
		await waitFor(() => h.store.sets.length === 1);

		expect(h.messages.map((m) => m.id)).toEqual([501, 505]);
		expect(h.store.sets).toEqual([{ room: "r", id: 505 }]);
		expect(h.poller.getState().rooms[0]?.filteredMessages).toBe(3);
	});

	it("Batch NUR aus verworfenen Nachrichten → kein onMessage, aber Persist (Offset muss springen)", async () => {
		// Der kritische Anti-Loop-Fall: der Bot antwortet, der Server liefert die
		// Antwort zurück. Ohne Persist des Offsets würde diese Nachricht bei JEDEM
		// weiteren Poll erneut geliefert → Endlosschleife.
		const h = track(
			makePoller({
				config: { ownUserId: "bot-gw", minPollIntervalMs: 10 },
				script: [{ status: 200, messages: [ownMsg(501), systemMsg(502)] }],
			}),
		);
		h.poller.start(["r"]);
		await waitFor(() => h.store.sets.length === 1);

		expect(h.messages).toHaveLength(0); // nichts emittiert
		expect(h.store.sets).toEqual([{ room: "r", id: 502 }]); // Offset trotzdem fort
		expect(h.poller.getState().rooms[0]?.filteredMessages).toBe(2);
	});

	it("ohne ownUserId: User-Nachrichten werden emittiert (Eigenfilter ist opt-in)", async () => {
		const h = track(
			makePoller({
				config: { minPollIntervalMs: 10 },
				script: [{ status: 200, messages: [userMsg(501, "alice")] }],
			}),
		);
		h.poller.start(["r"]);
		await waitFor(() => h.store.sets.length === 1);

		expect(h.messages.map((m) => m.id)).toEqual([501]);
		expect(h.poller.getState().rooms[0]?.filteredMessages).toBe(0);
	});

	it("validiert ownUserId (muss String sein)", () => {
		const fakeClient = () => new FakeOcsClient();
		expect(
			() =>
				new NextcloudTalkPoller(fakeClient(), {
					onMessage: () => {},
					config: { ownUserId: 42 } as unknown as TalkPollerConfig,
				}),
		).toThrow(/ownUserId/);
	});
});

// ── 9. Room-Prune (§5.2) ─────────────────────────────────────────────────────

describe("NextcloudTalkPoller — Room-Prune (§5.2)", () => {
	it("pruned mit pruneRemovedRooms=true: persistierte, nicht mehr konfigurierte Räume", async () => {
		const h = track(makePoller({ seed: { r1: 10, r2: 20, old: 99 } }));
		h.poller.start(["r1", "r2"], { pruneRemovedRooms: true });

		expect(h.store.pruneCalls).toEqual([["old"]]);
		expect(h.store.values.get("old")).toBeUndefined(); // Zustand entfernt
		expect(h.store.values.get("r1")).toBe(10); // konfigurierte Räume bleiben
		expect(h.store.values.get("r2")).toBe(20);
	});

	it("ohne Flag: kein Prune (Default-Sicherheit gegen versehentlich leeres Config)", async () => {
		const h = track(makePoller({ seed: { r1: 10, old: 99 } }));
		h.poller.start(["r1"]);

		expect(h.store.pruneCalls).toHaveLength(0);
		expect(h.store.values.get("old")).toBe(99); // Zustand bleibt erhalten
	});

	it("alle persistierten Räume entfernt → alle werden geprunt", async () => {
		const h = track(makePoller({ seed: { a: 1, b: 2 } }));
		h.poller.start(["c"], { pruneRemovedRooms: true });

		expect(h.store.pruneCalls).toEqual([["a", "b"]]);
		expect(h.store.values.size).toBe(0);
	});

	it("Store ohne Prune-Support (optionale Methoden) → no-op, kein Crash", async () => {
		const minimalStore: TalkStateStore = {
			getLastKnownMessageId: () => 0,
			setLastKnownMessageId: () => {},
		};
		const client = new FakeOcsClient();
		const poller = new NextcloudTalkPoller(client, {
			store: minimalStore,
			onMessage: () => {},
		});

		expect(() => poller.start(["r"], { pruneRemovedRooms: true })).not.toThrow();
		expect(poller.getState().running).toBe(true);
		await waitFor(() => client.calls.length >= 1); // pollt trotzdem weiter
	});

	it("Prune-Fehler bricht start() nicht ab (Warn-Log, Poller läuft weiter)", async () => {
		const h = track(
			makePoller({
				seed: { old: 99 },
				pruneImpl: () => {
					throw new Error("disk full");
				},
			}),
		);

		expect(() => h.poller.start(["r1"], { pruneRemovedRooms: true })).not.toThrow();
		expect(h.poller.getState().running).toBe(true);
		await waitFor(() => h.client.calls.length >= 1); // Loop läuft trotz Prune-Fehler
	});
});

// ── 10. ReadMarker (P2a) ──────────────────────────────────────────────────────

/** Schnelle Poll-Config für die ReadMarker-Tests (kleine Intervalle). */
const fastConfig: TalkPollerConfig = { minPollIntervalMs: 10, longPollTimeoutSeconds: 1 };

describe("NextcloudTalkPoller — ReadMarker nach dem Lesen (P2a)", () => {
	it("setzt den ReadMarker auf nextOffset nach erfolgreicher Batch-Verarbeitung", async () => {
		const h = track(makePoller({ script: [batchResult([501, 502])], config: fastConfig }));
		h.poller.start(["room-tok"]);

		await waitFor(() => h.client.setReadMarkerCalls.length >= 1);
		expect(h.client.setReadMarkerCalls[0]).toEqual({ room: "room-tok", id: 502 });

		// Reihenfolge: erst persistieren, dann Marker (set-Event liegt vor dem Marker).
		expect(h.store.values.get("room-tok")).toBe(502);
	});

	it("setzt den ReadMarker auf X-Chat-Last-Given, wenn er über der max Message-ID liegt", async () => {
		const h = track(makePoller({ script: [batchResult([501], 509)], config: fastConfig }));
		h.poller.start(["room-tok"]);

		await waitFor(() => h.client.setReadMarkerCalls.length >= 1);
		expect(h.client.setReadMarkerCalls[0]).toEqual({ room: "room-tok", id: 509 });
	});

	it("ruft setReadMarker NICHT auf bei 304 / leerer Batch (keine gültige neue ID)", async () => {
		const h = track(makePoller({ script: [idleResult, idleResult], config: fastConfig }));
		h.poller.start(["room-tok"]);

		// Zwei Poll-Zyklen abwarten (Loop lebt), dann: kein Marker-Aufruf.
		await waitFor(() => h.client.calls.length >= 2);
		expect(h.client.setReadMarkerCalls).toEqual([]);
	});

	it("Client ohne setReadMarker-Support → Poller läuft trotzdem (optionale Methode)", async () => {
		const full = new FakeOcsClient([batchResult([10])]);
		// Strukturell minimaler Client: NUR receiveChat, kein setReadMarker.
		const minimal = {
			receiveChat: (room: string, q: TalkReceiveChatQuery) => full.receiveChat(room, q),
		};
		const store = new FakeStore();
		const poller = new NextcloudTalkPoller(minimal, {
			config: fastConfig,
			store,
			onMessage: () => {},
		});
		track({ poller, client: full, store, messages: [], states: [], events: [] });

		poller.start(["r"]);
		await waitFor(() => store.values.get("r") === 10); // Batch verarbeitet
		expect(full.setReadMarkerCalls).toEqual([]); // Marker nie angefragt
	});

	it("ein ReadMarker-Fehler bricht den Poll-Loop NICHT ab (best-effort)", async () => {
		const h = track(
			makePoller({
				script: [batchResult([1]), idleResult, idleResult],
				config: fastConfig,
			}),
		);
		h.client.setReadMarkerError = new TalkError("HTTP_500", "marker boom");
		h.poller.start(["room-tok"]);

		// Batch wird persistiert, Marker-Aufruf erfolgt (und wirft) …
		await waitFor(() => h.store.values.get("room-tok") === 1);
		await waitFor(() => h.client.setReadMarkerCalls.length >= 1);

		// … aber der Loop läuft weiter (zweiter Poll wird gestellt).
		await waitFor(() => h.client.calls.length >= 2);
		expect(h.poller.getState().rooms[0]?.status).toBe("polling");
	});
});

// ── P2b: dynamisches Room-Set (setActiveRooms) ───────────────────────────────

/** Interval-Config für schnelle, deterministische setActiveRooms-Tests. */
const p2bConfig: TalkPollerConfig = {
	pollMode: "interval",
	intervalMs: 20,
	minPollIntervalMs: 5,
};

describe("NextcloudTalkPoller — setActiveRooms (P2b: dynamisches Room-Set)", () => {
	it("wirft, wenn der Poller nicht läuft", () => {
		const h = track(makePoller({ config: p2bConfig }));
		expect(() => h.poller.setActiveRooms(["a"])).toThrow(/erst start\(\)/);
	});

	it("fügt neue Räume zur Laufzeit hinzu (Warm-Start aus der Store + eigener Loop)", async () => {
		const h = track(makePoller({ config: p2bConfig, seed: { "room-b": 42 } }));
		h.poller.start(["room-a"]);
		await waitFor(() => h.client.callsFor("room-a").length >= 1);

		h.poller.setActiveRooms(["room-a", "room-b"]);

		await waitFor(() => h.client.callsFor("room-b").length >= 1);
		// Warm-Start (D3): der neue Loop startet exakt am persistierten Offset.
		expect(h.client.callsFor("room-b")[0].query.lastKnownMessageId).toBe(42);

		const rooms = h.poller
			.getState()
			.rooms.map((r) => r.room)
			.sort();
		expect(rooms).toEqual(["room-a", "room-b"]);
	});

	it("stoppt entfernte Räume (keine weiteren Polls), andere Räume laufen weiter", async () => {
		const h = track(makePoller({ config: p2bConfig }));
		h.poller.start(["room-a", "room-b"]);
		await waitFor(() => h.client.callsFor("room-a").length >= 1);
		await waitFor(() => h.client.callsFor("room-b").length >= 1);

		h.poller.setActiveRooms(["room-a"]);

		// room-a wird weiterhin gepollt (Poller lebt) …
		await waitFor(() => h.client.callsFor("room-a").length > 1);
		// … room-b nicht mehr: zwei aufeinanderfolgende Fenster ohne neuen Poll
		// (ein in-flight-Poll zum Zeitpunkt der Entfernung läuft bounded zu Ende).
		await sleep(80);
		const bCountAtSettle = h.client.callsFor("room-b").length;
		await sleep(80);
		expect(h.client.callsFor("room-b").length).toBe(bCountAtSettle);
		expect(h.poller.getState().rooms.map((r) => r.room)).toEqual(["room-a"]);
	});

	it("dedupliziert Duplikate und ist no-op bei unverändertem Set", async () => {
		const h = track(makePoller({ config: p2bConfig }));
		h.poller.start(["room-a"]);
		await waitFor(() => h.client.callsFor("room-a").length >= 1);

		// Unverändertes Set (inkl. Duplikat) → kein zweiter Loop, keine Änderung.
		const statesBefore = h.states.length;
		h.poller.setActiveRooms(["room-a", "room-a"]);
		expect(h.poller.getState().rooms).toHaveLength(1);
		expect(h.states.length).toBe(statesBefore); // kein onState (nichts geändert)
	});

	it("pruned mit pruneRemovedRooms=true: Wasserstand entfernter Räume wird gelöscht", async () => {
		const h = track(makePoller({ config: p2bConfig, seed: { "room-a": 1, "room-b": 2 } }));
		h.poller.start(["room-a", "room-b"]);
		await waitFor(() => h.client.callsFor("room-b").length >= 1);

		h.poller.setActiveRooms(["room-a"], { pruneRemovedRooms: true });

		expect(h.store.pruneCalls.flat()).toContain("room-b");
		expect(h.store.values.has("room-b")).toBe(false);
		expect(h.store.values.has("room-a")).toBe(true);
	});

	it("ohne Flag: kein Prune (Bestands-Sicherheit wie bei start())", async () => {
		const h = track(makePoller({ config: p2bConfig, seed: { "room-a": 1, "room-b": 2 } }));
		h.poller.start(["room-a", "room-b"]);
		await waitFor(() => h.client.callsFor("room-b").length >= 1);

		h.poller.setActiveRooms(["room-a"]);

		expect(h.store.pruneCalls).toEqual([]);
		expect(h.store.values.has("room-b")).toBe(true); // Zustand bleibt erhalten
	});

	it("wirft bei leerem Token OHNE partielle Änderungen", async () => {
		const h = track(makePoller({ config: p2bConfig }));
		h.poller.start(["room-a"]);
		await waitFor(() => h.client.callsFor("room-a").length >= 1);

		expect(() => h.poller.setActiveRooms(["room-a", ""])).toThrow(/leeren Token/);
		expect(h.poller.getState().rooms.map((r) => r.room)).toEqual(["room-a"]);
	});

	it("entfernen → neu hinzufügen: frischer Loop mit neuem Wasserstand, kein Doppel-Loop", async () => {
		const h = track(makePoller({ config: p2bConfig, seed: { "room-a": 100 } }));
		h.poller.start(["room-a"]);
		await waitFor(() => h.client.callsFor("room-a").length >= 1);

		// Raum entfernen, Store-Offset zwischenzeitlich vorziehen, Raum neu hinzufügen.
		h.poller.setActiveRooms([]);
		h.store.seed("room-a", 200);
		h.poller.setActiveRooms(["room-a"]);

		// Der NEUE Loop pollt mit dem frischen Offset (200) …
		await waitFor(() =>
			h.client.callsFor("room-a").some((c) => c.query.lastKnownMessageId === 200),
		);
		// … und der alte Loop (Offset 100) ist tot: genau ein Poll mit Offset 100.
		await sleep(100);
		const offset100 = h.client
			.callsFor("room-a")
			.filter((c) => c.query.lastKnownMessageId === 100);
		expect(offset100).toHaveLength(1);
	});
});
