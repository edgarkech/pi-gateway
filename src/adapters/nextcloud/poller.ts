/**
 * Nextcloud Talk — Poller (Phase 4 S3).
 *
 * Source: concept_phase_4_nextcloud.md §5.1 (Loop-Steuerung), §5.2 (Wasserstand),
 * §9.1 (DoS-Kontrolle/D9), §10 (Config-Defaults), §11 (Fehlerbehandlung N1–N4).
 *
 * Verantwortlichkeiten:
 * - **Long-Polling primär** (`lookIntoFuture=1` + `timeout=30`): im Leerlauf ein
 *   offener Socket pro Raum, nahezu null CPU. Fallback: **Interval-Polling**
 *   (`pollMode:"interval"`, `intervalMs`).
 * - **Pro Raum ein unabhängiger Loop** — nie parallel dasselbe
 *   `lastKnownMessageId` abfragen (1 offener Request pro Raum).
 * - **Last-Steuerung (D9):** max. `maxConcurrentPolls` offene Polls gleichzeitig
 *   (Slot-Semaphore), kein Poll schneller als `minPollIntervalMs` seit dem letzten
 *   Response, Batch-`limit` ≤ 100.
 * - **Fehlerbehandlung (§11):** exponentieller Backoff
 *   `backoff = min(backoff * 2, backoffMaxMs)` (Reset auf `minPollIntervalMs` bei
 *   Erfolg); **Circuit Breaker** nach `circuitThreshold` aufeinanderfolgenden
 *   Fehlern → Raum pausiert für `backoffMaxMs` und probiert dann neu;
 *   `AUTH_FAILED` → Raum pausiert bis Config-Änderung/Restart (N1);
 *   `ROOM_NOT_FOUND` → sofortiger Circuit-Break, periodische Probes (N2).
 * - **Persistenz (D3/N7):** `lastKnownMessageId` wird in der TalkStateStore erst
 *   NACH erfolgreicher Verarbeitung des kompletten Batches persistiert
 *   (at-least-once: bei Crash/Callback-Fehler liefert der Server die Batch neu,
 *   die Pipeline dedupliert idempotent).
 * - **Anti-Loop-Selbstfilter (D4/§5.3):** System-Nachrichten
 *   (`systemMessage !== ""`), Bot-Aktoren (`actorType === "bots"`) und — wenn
 *   `ownUserId` konfiguriert ist — eigene Nachrichten (`actorId === ownUserId`)
 *   werden NICHT via `onMessage` emittiert. Der Wasserstand wird aber trotzdem
 *   über sie fortgeschrieben, sonst würde der Server sie bei jedem Poll erneut
 *   liefern (Endlosschleife). Die zentralen Publishable-Checks (z. B.
 *   `messageType === "command"`) bleiben Aufgabe des Adapters (§5.3: "zentral
 *   im Adapter geprüft"); hier liegt nur die Loop-sichere Vorschaltfilterung.
 * - **Room-Prune (§5.2):** `start(rooms, { pruneRemovedRooms: true })` entfernt
 *   persistierte Wasserstände für Räume, die nicht mehr konfiguriert sind
 *   (opt-in, damit ein vorübergehend leeres Config keinen Zustand löscht).
 * - **Dynamisches Room-Set (P2b):** `setActiveRooms(rooms)` aktualisiert das
 *   überwachte Raum-Set zur Laufzeit (Auto-Discovery / Room-Refresh): neue
 *   Räume starten einen Loop mit Warm-Start aus der Store, entfernte Räume
 *   werden geschlossen (in-flight-Polls laufen bounded zu Ende) und können
 *   optional geprunt werden. Bestehende Räume bleiben unverändert.
 * - **Daemon-Lifecycle (§5.4):** `start(rooms)` liest die Wasserstände warm aus
 *   der Store; `stop()` beendet alle Loops (Timers sind unref'd, halten den
 *   Prozess nicht offen).
 */

import { logger } from "../../logger.js";
import { TalkError } from "./ocs.js";
import type { TalkChatMessage } from "./talk-types.js";
import {
	getAllStates as storeGetAllStates,
	getLastKnownMessageId as storeGetLastKnownMessageId,
	pruneRooms as storePruneRooms,
	setLastKnownMessageId as storeSetLastKnownMessageId,
} from "./store.js";

// ── Konfiguration ────────────────────────────────────────────────────────────

/** Poll-Modus: Long-Poll (primär) oder reines Intervall-Polling (Fallback). */
export type TalkPollMode = "long-poll" | "interval";

/**
 * Poller-Konfiguration (Konzept §10 — gleiche Felder/Defaults wie der
 * `platforms.nextcloudTalk`-Config-Block; S5 mappt 1:1).
 */
export interface TalkPollerConfig {
	/** Default `"long-poll"`. */
	pollMode?: TalkPollMode;
	/** Long-Poll-Timeout in Sekunden (0–60), default 30. */
	longPollTimeoutSeconds?: number;
	/** Intervall im Interval-Modus, default 5000 ms. */
	intervalMs?: number;
	/** Mindestabstand zwischen zwei Polls desselben Raums, default 1000 ms. */
	minPollIntervalMs?: number;
	/** Backoff-Obergrenze, default 60000 ms. */
	backoffMaxMs?: number;
	/** Max. offene Polls gleichzeitig (alle Räume zusammen), default 4. */
	maxConcurrentPolls?: number;
	/** Consecutive Errors bis Circuit-Break pro Raum, default 5. */
	circuitThreshold?: number;
	/** Nachrichten-Limit pro Poll (D9: ≤ 100), default 100. */
	batchLimit?: number;
	/**
	 * Nextcloud-UserID des Bot-Accounts (Anti-Loop-Selselfilter, §5.3/D4).
	 * Wenn gesetzt (nicht leer), werden Nachrichten mit
	 * `actorId === ownUserId` verworfen — nur der Offset wird fortgeschrieben.
	 * Verhindert die Endlosschleife "Bot antwortet auf sich selbst". System-
	 * Nachrichten und Bot-Aktoren werden unabhängig von diesem Feld immer
	 * gefiltert. Default `""` (Eigenfilter aus, z. B. für reine Test-Sets).
	 */
	ownUserId?: string;
}

/** Defaults laut Konzept §10 / §9.1. */
const DEFAULTS: Required<TalkPollerConfig> = {
	pollMode: "long-poll",
	longPollTimeoutSeconds: 30,
	intervalMs: 5_000,
	minPollIntervalMs: 1_000,
	backoffMaxMs: 60_000,
	maxConcurrentPolls: 4,
	circuitThreshold: 5,
	batchLimit: 100,
	ownUserId: "",
};

// ── Zustands-Modelle (für onState / getStatus) ───────────────────────────────

/** Status eines einzelnen Raums im Poller. */
export type RoomPollStatus = "polling" | "backoff" | "circuit-open" | "auth-failed";

/** Snapshot des Zustands eines Raum-Loops. */
export interface RoomState {
	room: string;
	status: RoomPollStatus;
	/** Letzter persistierter Wasserstand (`lastKnownMessageId`). */
	lastKnownMessageId: number;
	/** Aufeinanderfolgende Fehler seit letztem Erfolg (Circuit-Breaker-Zähler). */
	consecutiveErrors: number;
	/** Aktueller Backoff-Wert (wird bei Erfolg auf `minPollIntervalMs` zurückgesetzt). */
	backoffMs: number;
	/** Epoch-ms des letzten abgeschlossenen Polls (Erfolg oder Fehler). */
	lastPollAt?: number;
	/** Latenz des letzten erfolgreichen Polls in ms. */
	lastLatencyMs?: number;
	/** Beschreibung des letzten Fehlers (log-sicher, ohne Secrets). */
	lastError?: string;
	/** Anzahl per Anti-Loop-Filter verworfener Nachrichten (§5.3/D4). */
	filteredMessages: number;
}

/** Gesamtsnapshot des Pollers — Zieltyp des `onState`-Callbacks. */
export interface PollerState {
	running: boolean;
	pollMode: TalkPollMode;
	/** Anzahl aktuell offener Poll-Requests (≤ `maxConcurrentPolls`). */
	activePolls: number;
	rooms: RoomState[];
}

// ── Injektions-Schnittstellen (Testbarkeit) ──────────────────────────────────

/** Query-Parameter für `receiveChat` (spiegelt die OcsClient-Signatur). */
export interface TalkReceiveChatQuery {
	lookIntoFuture?: 0 | 1;
	limit?: number;
	lastKnownMessageId?: number;
	timeout?: number;
	setReadMarker?: 0 | 1;
}

/** Ergebnis eines `receiveChat`-Aufrufs (spiegelt die OcsClient-Signatur). */
export interface TalkReceiveChatResult {
	status: number;
	messages: TalkChatMessage[];
	xChatLastGiven?: number;
}

/**
 * Strukturelle Teilmengen-Schnittstelle von `OcsClient` — der Poller braucht
 * nur den Chat-Poll-Endpoint. Tests können ein Fake ohne echte HTTP-Schicht
 * injizieren (Konzept §12: "Fake OcsClient + talk_state in tmp-Dir").
 */
export interface TalkChatPollClient {
	receiveChat(room: string, q: TalkReceiveChatQuery): Promise<TalkReceiveChatResult>;
	/**
	 * Optional (P2a): setzt den Nextcloud-ReadMarker auf die letzte gelesene
	 * Message-ID, damit der Ungelesen-Zähler der Instanz zurückgesetzt wird.
	 * Der Poller ruft es nach erfolgreicher Batch-Verarbeitung best-effort
	 * auf — Fehler werden nur geloggt (keine Redelivery, kein Backoff).
	 */
	setReadMarker?(room: string, messageId: number): Promise<void>;
}

/**
 * Wasserstands-Store (S2). Der Poller persistiert den Offset NUR über diese
 * Schnittstelle — Default ist die SQLite-Implementierung aus `store.ts`.
 */
export interface TalkStateStore {
	getLastKnownMessageId(roomToken: string): number;
	setLastKnownMessageId(roomToken: string, lastKnownMessageId: number): void;
	/** Alle persistierten Wasserstände (Warm-Start/Room-Prune). Optional. */
	getAllStates?(): Record<string, number>;
	/** Entfernt die Wasserstände der übergebenen Räume; liefert Anzahl. Optional. */
	pruneRooms?(roomTokens: string[]): number;
}

/** Default-Store: delegiert an die S2-Module (SQLite, `talk_state`). */
export const defaultTalkStateStore: TalkStateStore = {
	getLastKnownMessageId: (roomToken) => storeGetLastKnownMessageId(roomToken),
	setLastKnownMessageId: (roomToken, lastKnownMessageId) =>
		storeSetLastKnownMessageId(roomToken, lastKnownMessageId),
	getAllStates: () => storeGetAllStates(),
	pruneRooms: (roomTokens) => storePruneRooms(roomTokens),
};

// ── Callbacks & Optionen ─────────────────────────────────────────────────────

/** Callback-Signaturen für den Adapter (Konzept §7.1). */
export interface TalkPollerCallbacks {
	/**
	 * Wird pro neuer, publishable-relevanter Nachricht aufgerufen
	 * (fire-and-forget; der Adapter wickelt seine eigene Async-Logik ab und
	 * fängt eigene Fehler selbst). Wirft der Callback, gilt die Batch als
	 * NICHT verarbeitet → kein Persist → at-least-once-Redelivery.
	 */
	onMessage: (msg: TalkChatMessage) => void;
	/** Wird bei Zustandswechseln aufgerufen (Start/Stop, Poll-Ergebnis, Fehler). */
	onState?: (state: PollerState) => void;
}

export interface TalkPollerOptions extends TalkPollerCallbacks {
	config?: TalkPollerConfig;
	/** Wasserstands-Store (Default: SQLite via `store.ts`). */
	store?: TalkStateStore;
}

// ── Interne Raum-Runtime ─────────────────────────────────────────────────────

interface RoomRuntime {
	room: string;
	/**
	 * P2b: gesetzt, wenn der Raum per `setActiveRooms()` entfernt wurde. Der
	 * Loop prüft es in jeder Iteration und bricht ab — auch wenn derselbe
	 * Token zwischenzeitlich erneut hinzugefügt wurde (frisches Runtime-Objekt,
	 * kein Doppel-Loop).
	 */
	closed?: boolean;
	status: RoomPollStatus;
	lastKnownMessageId: number;
	consecutiveErrors: number;
	backoffMs: number;
	/** Epoch-ms des letzten abgeschlossenen Requests (für minPollIntervalMs). */
	lastResponseAt: number;
	lastPollAt?: number;
	lastLatencyMs?: number;
	lastError?: string;
	/** Anti-Loop-Filter-Zähler (§5.3/D4) — für Status/Debug. */
	filteredMessages: number;
}

// ── Poller ───────────────────────────────────────────────────────────────────

/**
 * Nextcloud-Talk-Poller (S3).
 *
 * ```ts
 * const poller = new NextcloudTalkPoller(ocs, {
 *   config: { /* aus platforms.nextcloudTalk *\/ },
 *   onMessage: (msg) => adapter.handleTalkMessage(msg).catch(...),
 *   onState: (s) => { lastState = s; },
 * });
 * poller.start(config.rooms);   // Warm-Start aus talk_state
 * await poller.stop();          // Daemon-Shutdown
 * ```
 */
export class NextcloudTalkPoller {
	private readonly ocs: TalkChatPollClient;
	private readonly store: TalkStateStore;
	private readonly onMessage: (msg: TalkChatMessage) => void;
	private readonly onState?: (state: PollerState) => void;
	private readonly cfg: Required<TalkPollerConfig>;

	private running = false;
	private rooms = new Map<string, RoomRuntime>();
	private loops = new Map<string, Promise<void>>();

	// Slot-Semaphore (D9: max. `maxConcurrentPolls` offene Polls).
	private activePolls = 0;
	private slotWaiters: Array<() => void> = [];

	// Stop-Plumbing: wird bei jedem start() neu angelegt.
	private stopResolve: (() => void) | null = null;
	private stoppedPromise: Promise<void>;

	constructor(ocs: TalkChatPollClient, opts: TalkPollerOptions) {
		if (!opts || typeof opts.onMessage !== "function") {
			throw new Error("NextcloudTalkPoller: opts.onMessage ist Pflicht");
		}
		this.ocs = ocs;
		this.store = opts.store ?? defaultTalkStateStore;
		this.onMessage = opts.onMessage;
		this.onState = opts.onState;
		this.cfg = normalizeConfig(opts.config ?? {});
		this.stoppedPromise = new Promise<void>((resolve) => {
			this.stopResolve = resolve;
		});
	}

	/**
	 * Startet einen unabhängigen Loop pro Raum. Die Wasserstände werden warm
	 * aus der Store geladen (D3: kein Re-Processing, kein Überspringen).
	 * Duplikate in `rooms` werden still dedupliziert.
	 *
	 * @param rooms Konfigurierte Raum-Tokens.
	 * @param opts.pruneRemovedRooms Wenn `true`, werden persistierte
	 *   Wasserstände für Räume entfernt, die NICHT in `rooms` enthalten sind
	 *   (Room-Prune, Konzept §5.2). Opt-in: ein versehentlich leeres Config
	 *   löscht sonst keinen Zustand.
	 */
	start(rooms: string[], opts: { pruneRemovedRooms?: boolean } = {}): void {
		if (this.running) {
			throw new Error("NextcloudTalkPoller: bereits läuft — erst stop() aufrufen");
		}

		// Frisches Stop-Signal pro Lebenszyklus.
		this.stoppedPromise = new Promise<void>((resolve) => {
			this.stopResolve = resolve;
		});

		this.rooms.clear();
		this.loops.clear();
		this.activePolls = 0;
		this.slotWaiters = [];

		const uniqueRooms = [...new Set(rooms)];
		for (const room of uniqueRooms) {
			if (typeof room !== "string" || room.trim() === "") {
				throw new Error("NextcloudTalkPoller: rooms enthält einen leeren Token");
			}
			this.rooms.set(room, {
				room,
				status: "polling",
				// Warm-Start (D3): exakt dort weitermachen, wo der letzte
				// erfolgreiche Poll persistiert hat.
				lastKnownMessageId: this.store.getLastKnownMessageId(room),
				consecutiveErrors: 0,
				backoffMs: this.cfg.minPollIntervalMs,
				lastResponseAt: 0,
				filteredMessages: 0,
			});
		}

		// Room-Prune (§5.2): Wasserstände für entfernte Räume aufräumen —
		// NACH Validierung, VOR Loop-Start; Fehler hier dürfen den Start nicht
		// blockieren (Persistenz-Aufräumen ist Best-Effort).
		if (opts.pruneRemovedRooms) {
			this.pruneRemovedRooms(uniqueRooms);
		}

		this.running = true;
		for (const room of uniqueRooms) {
			const loop = this.roomLoop(room).catch((err) => {
				logger.error(`[TalkPoller] Room-Loop ${room} crashed:`, err);
			});
			this.loops.set(room, loop);
		}

		logger.info(
			`[TalkPoller] Gestartet: ${uniqueRooms.length} Raum(e), mode=${this.cfg.pollMode}, ` +
				`maxConcurrentPolls=${this.cfg.maxConcurrentPolls}, minPollIntervalMs=${this.cfg.minPollIntervalMs}`,
		);
		this.emitState();
	}

	/**
	 * Aktualisiert das überwachte Raum-Set zur Laufzeit (P2b: Auto-Discovery /
	 * Room-Refresh, Konzept §10.2). Nur während `running`.
	 *
	 * - **Neue Räume:** Warm-Start des Wasserstands aus der Store (D3) +
	 *   eigener Loop — identisch zum Verhalten von `start()`.
	 * - **Entfernte Räume:** Runtime wird geschlossen (`closed`), der Loop
	 *   bricht beim nächsten Check ab. Ein in-flight-Poll läuft zu Ende
	 *   (bounded durch Long-Poll-Timeout bzw. `minPollIntervalMs`) und persistiert
	 *   ggf. noch den letzten Offset — das ist gewollt (at-least-once, N7);
	 *   der Zustand wird bei Bedarf beim nächsten Refresh erneut geprunt.
	 * - **Bestehende Räume:** unverändert (Wasserstand, Backoff, Fehlerzähler).
	 *
	 * @param rooms Neues, vollständiges Raum-Set (konfigurierte + entdeckte
	 *   Tokens; Duplikate werden still dedupliziert, leere Tokens werfen).
	 * @param opts.pruneRemovedRooms Wenn `true`, werden persistierte
	 *   Wasserstände für Räume entfernt, die NICHT in `rooms` enthalten sind
	 *   (Room-Prune, §5.2 — Best-Effort wie bei `start()`).
	 */
	setActiveRooms(rooms: string[], opts: { pruneRemovedRooms?: boolean } = {}): void {
		if (!this.running) {
			throw new Error(
				"NextcloudTalkPoller: setActiveRooms() nur während der Laufzeit — erst start() aufrufen",
			);
		}
		const uniqueRooms = [...new Set(rooms)];
		for (const room of uniqueRooms) {
			if (typeof room !== "string" || room.trim() === "") {
				throw new Error("NextcloudTalkPoller: rooms enthält einen leeren Token");
			}
		}

		// 1) Neue Räume anlegen + Loops starten (Warm-Start wie in start()).
		const added: string[] = [];
		for (const room of uniqueRooms) {
			if (this.rooms.has(room)) continue;
			this.rooms.set(room, {
				room,
				status: "polling",
				lastKnownMessageId: this.store.getLastKnownMessageId(room),
				consecutiveErrors: 0,
				backoffMs: this.cfg.minPollIntervalMs,
				lastResponseAt: 0,
				filteredMessages: 0,
			});
			added.push(room);
			const loop = this.roomLoop(room).catch((err) => {
				logger.error(`[TalkPoller] Room-Loop ${room} crashed:`, err);
			});
			this.loops.set(room, loop);
		}

		// 2) Entfernte Räume schließen (Loop bricht beim nächsten Check ab).
		const removed: string[] = [];
		for (const room of [...this.rooms.keys()]) {
			if (uniqueRooms.includes(room)) continue;
			const rt = this.rooms.get(room);
			if (rt) rt.closed = true;
			this.rooms.delete(room);
			removed.push(room);
		}

		// 3) Optional: persistierte Wasserstände für nicht mehr aktive Räume prunen.
		if (opts.pruneRemovedRooms && removed.length > 0) {
			this.pruneRemovedRooms(uniqueRooms);
		}

		if (added.length > 0 || removed.length > 0) {
			logger.info(
				`[TalkPoller] Room-Set aktualisiert: +${added.length} ` +
					`${added.length > 0 ? `(${added.join(", ")}) ` : ""}` +
					`-${removed.length} ` +
					`${removed.length > 0 ? `(${removed.join(", ")})` : ""} ` +
					`→ ${uniqueRooms.length} aktiv`,
			);
			this.emitState();
		}
	}

	/**
	 * Stoppt alle Room-Loops und wartet, bis in-flight-Polls abgeschlossen sind
	 * (diese sind durch den OcsClient-Timeout begrenzt). Idempotent.
	 * Wasserstände bleiben unangetastet (sie waren bereits nach dem letzten
	 * erfolgreichen Batch persistiert). Die Store selbst schließt der Daemon
	 * separat via `shutdownTalkStateStore()`.
	 */
	async stop(): Promise<void> {
		if (!this.running) return;
		this.running = false;
		this.stopResolve?.(); // weckt alle sleepOrStop-/Slot-Waiter
		const loops = [...this.loops.values()];
		this.loops.clear();
		await Promise.allSettled(loops);
		logger.info(`[TalkPoller] Gestoppt (${this.rooms.size} Raum(e))`);
		this.emitState();
	}

	/** Snapshot des aktuellen Zustands (für `getStatus()` / Tests). */
	getState(): PollerState {
		return {
			running: this.running,
			pollMode: this.cfg.pollMode,
			activePolls: this.activePolls,
			rooms: [...this.rooms.values()].map((r) => ({
				room: r.room,
				status: r.status,
				lastKnownMessageId: r.lastKnownMessageId,
				consecutiveErrors: r.consecutiveErrors,
				backoffMs: r.backoffMs,
				lastPollAt: r.lastPollAt,
				lastLatencyMs: r.lastLatencyMs,
				lastError: r.lastError,
				filteredMessages: r.filteredMessages,
			})),
		};
	}

	// ── Room-Loop (§5.1) ─────────────────────────────────────────────────────

	/**
	 * Unabhängiger Poll-Loop für einen Raum. Reihenfolge pro Iteration:
	 * min-Poll-Intervall → Slot akquirieren → receiveChat → Batch verarbeiten /
	 * Fehlerpfad → (Interval-Modus) Intervall auffüllen.
	 */
	private async roomLoop(room: string): Promise<void> {
		const state = this.rooms.get(room);
		if (!state) return;

		// `!state.closed`: Raum wurde per setActiveRooms() entfernt (P2b) —
		// der Loop bricht ab, auch wenn derselbe Token bereits wieder neu
		// hinzugefügt wurde (das neue Runtime-Objekt hat ein eigenes `closed`-Flag).
		while (this.running && !state.closed) {
			// AUTH_FAILED: Raum bleibt pausiert bis Config-Änderung/Restart (N1).
			if (state.status === "auth-failed") break;

			// 1) Last-Steuerung: kein Poll schneller als minPollIntervalMs seit
			//    dem letzten Response (gilt auch nach 304, §9.1).
			const minWait = state.lastResponseAt + this.cfg.minPollIntervalMs - Date.now();
			if (minWait > 0 && (await this.sleepOrStop(minWait))) break;

			// 2) Last-Steuerung: max. `maxConcurrentPolls` offene Polls.
			if (await this.acquireSlot()) break;

			const t0 = Date.now();
			try {
				const res = await this.ocs.receiveChat(room, this.pollParams(state));
				this.releaseSlot();

				state.lastResponseAt = Date.now();
				state.lastPollAt = state.lastResponseAt;
				state.lastLatencyMs = Date.now() - t0;

				this.processResult(state, res);
			} catch (err) {
				this.releaseSlot();
				this.handleRoomError(state, err);
				if (await this.sleepAfterError(state)) break;
				continue;
			}

			// 3) Interval-Modus: Zyklus auf `intervalMs` auffüllen (gemessen ab
			//    letztem Response; minPollIntervalMs wird oben zusätzlich erzwungen).
			if (this.cfg.pollMode === "interval") {
				const remain = this.cfg.intervalMs - (Date.now() - state.lastResponseAt);
				if (remain > 0 && (await this.sleepOrStop(remain))) break;
			}
		}
	}

	// ── Erfolgs-Pfad ─────────────────────────────────────────────────────────

	/**
	 * Verarbeitet ein erfolgreiches Poll-Ergebnis:
	 * - `304` / leere Batch → nichts zu tun (Offset bleibt, Backoff/Errors reset).
	 * - Sonst: jede neue Nachricht (`id > lastKnownMessageId`, defensives Dedup)
	 *   via `onMessage` liefern und den neuen Wasserstand persistieren — aber
	 *   erst NACH erfolgreicher Verarbeitung des kompletten Batches (D3/N7).
	 *
	 * @throws Wenn der `onMessage`-Callback wirft (Batch gilt als nicht
	 *         verarbeitet → kein Persist → Redelivery im nächsten Poll).
	 */
	private processResult(state: RoomRuntime, res: TalkReceiveChatResult): void {
		// Erfolg → Fehlerzustand zurücksetzen.
		this.resetErrorState(state);

		if (res.status === 304) return;

		const batch = res.messages.filter(
			(m) => Number.isFinite(m.id) && m.id > state.lastKnownMessageId,
		);
		if (batch.length === 0) return;

		// Nächster Offset: max(X-Chat-Last-Given, max(msg.id), aktuelles Offset).
		let nextOffset = state.lastKnownMessageId;
		for (const msg of batch) nextOffset = Math.max(nextOffset, msg.id);
		if (Number.isFinite(res.xChatLastGiven)) {
			nextOffset = Math.max(nextOffset, res.xChatLastGiven as number);
		}

		// 1) Batch liefern. Verworfene Nachrichten (Anti-Loop-Filter, §5.3/D4)
		//    werden NICHT emittiert — der Offset (nextOffset) wurde aber bereits
		//    über den kompletten Batch berechnet, d. h. verworfene Nachrichten
		//    werden nie erneut geliefert. Ein Callback-Fehler bricht die
		//    Verarbeitung ab — bewusst VOR dem Persist (at-least-once, N7).
		for (const msg of batch) {
			if (this.isFiltered(msg)) {
				state.filteredMessages += 1;
				continue;
			}
			try {
				this.onMessage(msg);
			} catch (err) {
				throw new Error(
					`onMessage-Callback fehlgeschlagen (Raum ${state.room}, Nachricht ${msg.id}): ` +
						`${(err as Error)?.message ?? String(err)}`,
					{ cause: err },
				);
			}
		}

		// 2) Erst jetzt persistieren — nach vollständiger, erfolgreicher
		//    Verarbeitung (Konzept §5.1/§5.2, Anforderung 6).
		state.lastKnownMessageId = nextOffset;
		this.store.setLastKnownMessageId(state.room, nextOffset);

		// 3) ReadMarker (P2a): den Raum in Nextcloud als gelesen bis
		//    nextOffset markieren, damit der Ungelesen-Zähler zurückgesetzt
		//    wird. Best-effort: nur wenn eine gültige letzte gelesene ID
		//    existiert; Fehler werden geloggt, aber die Poll-Logik NICHT
		//    beeinflussen (Batch ist bereits persistiert → keine Redelivery).
		if (
			typeof this.ocs.setReadMarker === "function" &&
			Number.isFinite(nextOffset) &&
			nextOffset > 0
		) {
			void this.ocs.setReadMarker(state.room, nextOffset).catch((err) => {
				logger.warn(
					`[TalkPoller] ReadMarker für Raum ${state.room} fehlgeschlagen: ` +
						`${describeError(err)}`,
				);
			});
		}

		this.emitState();
	}

	// ── Anti-Loop-Selbstfilter (D4/§5.3) ─────────────────────────────────────

	/**
	 * Vorschaltfilter gegen Endlosschleifen (Konzept §5.3, MVP-Teil für S3):
	 * - `systemMessage !== ""` → System-Event, kein User-Input → verwerfen.
	 * - `actorType === "bots"` → Bot-Aktor → verwerfen.
	 * - `actorId === ownUserId` (nur wenn konfiguriert) → unsere eigene
	 *   Nachricht → verwerfen (der Gateway pollt als derselbe OCS-User, der
	 *   auch antwortet — ohne Filter wäre jede Bot-Antwort neue Eingabe).
	 *
	 * Bewusst NICHT hier: `messageType === "command"` und die restlichen
	 * Publishable-Checks — die liegen zentral im Adapter (§5.3), damit die
	 * Filter-Logik UI-lastig und dort testbar bleibt.
	 */
	private isFiltered(msg: TalkChatMessage): boolean {
		if (msg.systemMessage !== "") return true;
		if (msg.actorType === "bots") return true;
		if (this.cfg.ownUserId !== "" && msg.actorId === this.cfg.ownUserId) return true;
		return false;
	}

	// ── Room-Prune (§5.2) ─────────────────────────────────────────────────────

	/**
	 * Entfernt persistierte Wasserstände für Räume, die nicht mehr in der
	 * Konfiguration stehen (Konzept §5.2: "talk_poll_state wird bei Entfernung
	 * eines Raums geprunt"). Best-Effort: Store ohne Prune-Support → no-op;
	 * Fehler werden geloggt, werfen aber nicht (der Poller-Start geht weiter).
	 */
	private pruneRemovedRooms(configuredRooms: string[]): void {
		// Methoden AM Store-Objekt aufrufen (nicht als referenzierte Funktion),
		// damit der `this`-Kontext der Implementierung erhalten bleibt.
		if (
			typeof this.store.getAllStates !== "function" ||
			typeof this.store.pruneRooms !== "function"
		) {
			return;
		}

		try {
			const stored = Object.keys(this.store.getAllStates());
			const toPrune = stored.filter((room) => !configuredRooms.includes(room));
			if (toPrune.length === 0) return;
			const removed = this.store.pruneRooms(toPrune);
			logger.info(
				`[TalkPoller] Room-Prune: ${removed} Zustand(e) entfernt: ${toPrune.join(", ")}`,
			);
		} catch (err) {
			logger.warn(`[TalkPoller] Room-Prune fehlgeschlagen: ${describeError(err)}`);
		}
	}

	// ── Fehler-Pfad (§11) ────────────────────────────────────────────────────

	/**
	 * Fehlerbehandlung pro Raum:
	 * - `AUTH_FAILED` → Status `auth-failed`, Raum pausiert bis Restart (N1).
	 * - `ROOM_NOT_FOUND` → sofortiger Circuit-Break, Probes alle `backoffMaxMs` (N2).
	 * - Sonst: Zähler hoch, exponentieller Backoff `min(backoff*2, backoffMaxMs)`;
	 *   ab `circuitThreshold` aufeinanderfolgenden Fehlern → Circuit offen.
	 */
	private handleRoomError(state: RoomRuntime, err: unknown): void {
		state.consecutiveErrors += 1;
		state.lastError = describeError(err);

		if (err instanceof TalkError && err.code === "AUTH_FAILED") {
			state.status = "auth-failed";
			logger.error(
				`[TalkPoller] Raum ${state.room}: Auth fehlgeschlagen — Raum pausiert bis Config-Änderung/Restart`,
			);
			this.emitState();
			return;
		}

		if (err instanceof TalkError && err.code === "ROOM_NOT_FOUND") {
			state.status = "circuit-open";
			logger.warn(
				`[TalkPoller] Raum ${state.room}: nicht verfügbar (404) — Circuit offen, ` +
					`Probe alle ${this.cfg.backoffMaxMs} ms`,
			);
			this.emitState();
			return;
		}

		if (state.consecutiveErrors >= this.cfg.circuitThreshold) {
			state.status = "circuit-open";
			logger.warn(
				`[TalkPoller] Raum ${state.room}: Circuit offen nach ${state.consecutiveErrors} ` +
					`aufeinanderfolgenden Fehlern (${state.lastError}) — Pause ${this.cfg.backoffMaxMs} ms`,
			);
			this.emitState();
			return;
		}

		state.backoffMs = Math.min(state.backoffMs * 2, this.cfg.backoffMaxMs);
		state.status = "backoff";
		logger.warn(
			`[TalkPoller] Raum ${state.room}: Poll-Fehler ${state.consecutiveErrors}/` +
				`${this.cfg.circuitThreshold} (${state.lastError}) — Backoff ${state.backoffMs} ms`,
		);
		this.emitState();
	}

	/**
	 * Pause nach einem Fehler: normaler Backoff oder (bei offenem Circuit) die
	 * längere Pause von `backoffMaxMs`, danach frische Probe mit resettem
	 * Fehlerzustand. Liefert `true`, wenn der Poller während des Wartens
	 * gestoppt wurde.
	 */
	private async sleepAfterError(state: RoomRuntime): Promise<boolean> {
		if (!this.running) return true;

		if (state.status === "auth-failed") return true; // Loop bricht ab

		if (state.status === "circuit-open") {
			const stopped = await this.sleepOrStop(this.cfg.backoffMaxMs);
			if (stopped) return true;
			this.resetErrorState(state);
			logger.info(`[TalkPoller] Raum ${state.room}: Circuit-Probe nach Pause`);
			this.emitState();
			return false;
		}

		return this.sleepOrStop(state.backoffMs);
	}

	/** Fehlerzähler/Backoff/Status zurücksetzen (nach Erfolg oder Circuit-Pause). */
	private resetErrorState(state: RoomRuntime): void {
		if (state.consecutiveErrors === 0 && state.status === "polling") return;
		state.consecutiveErrors = 0;
		state.backoffMs = this.cfg.minPollIntervalMs;
		state.status = "polling";
	}

	// ── Last-Steuerung (D9) ──────────────────────────────────────────────────

	/** Query-Parameter für den aktuellen Modus (§5.1). */
	private pollParams(state: RoomRuntime): TalkReceiveChatQuery {
		if (this.cfg.pollMode === "long-poll") {
			return {
				lookIntoFuture: 1,
				timeout: this.cfg.longPollTimeoutSeconds,
				lastKnownMessageId: state.lastKnownMessageId,
				limit: this.cfg.batchLimit,
			};
		}
		return {
			lookIntoFuture: 0,
			lastKnownMessageId: state.lastKnownMessageId,
			limit: this.cfg.batchLimit,
		};
	}

	/**
	 * Akquiriert einen der `maxConcurrentPolls` Poll-Slots. Liefert `true`, wenn
	 * der Poller während des Wartens gestoppt wurde (kein Slot gehalten).
	 */
	private acquireSlot(): Promise<boolean> {
		if (!this.running) return Promise.resolve(true);
		if (this.activePolls < this.cfg.maxConcurrentPolls) {
			this.activePolls += 1;
			return Promise.resolve(false);
		}
		return new Promise<boolean>((resolve) => {
			let settled = false;
			const takeSlot = () => {
				if (settled) return;
				const idx = this.slotWaiters.indexOf(takeSlot);
				if (idx !== -1) this.slotWaiters.splice(idx, 1);
				settled = true;
				if (!this.running) {
					resolve(true);
					return;
				}
				this.activePolls += 1;
				resolve(false);
			};
			this.slotWaiters.push(takeSlot);
			void this.stoppedPromise.then(() => takeSlot());
		});
	}

	/** Gibt einen Poll-Slot frei und reicht ihn an den nächsten Wartenden weiter. */
	private releaseSlot(): void {
		const next = this.slotWaiters.shift();
		if (next) {
			next(); // Der Waiter inkrementiert activePolls selbst (oder löst "stopped" auf).
		} else if (this.activePolls > 0) {
			this.activePolls -= 1;
		}
	}

	// ── Stop-aware Sleep ─────────────────────────────────────────────────────

	/**
	 * Schläft bis zu `ms` ms. Löst `true`, wenn der Poller dazwischen gestoppt
	 * wurde (frühes Aufwachen), sonst `false`. Timer sind unref'd (§5.4: Loops
	 * dürfen den Prozess nicht offen halten).
	 */
	private sleepOrStop(ms: number): Promise<boolean> {
		if (!this.running) return Promise.resolve(true);
		if (ms <= 0) return Promise.resolve(false);
		return new Promise<boolean>((resolve) => {
			let done = false;
			const timer = setTimeout(() => {
				if (!done) {
					done = true;
					resolve(false);
				}
			}, ms);
			timer.unref?.();
			void this.stoppedPromise.then(() => {
				if (!done) {
					done = true;
					clearTimeout(timer);
					resolve(true);
				}
			});
		});
	}

	// ── State-Emission ───────────────────────────────────────────────────────

	/** Ruft `onState` mit einem frischen Snapshot auf (Callback-Fehler isoliert). */
	private emitState(): void {
		if (!this.onState) return;
		try {
			this.onState(this.getState());
		} catch (err) {
			logger.warn(`[TalkPoller] onState-Callback fehlgeschlagen: ${describeError(err)}`);
		}
	}
}

// ── Hilfsfunktionen ──────────────────────────────────────────────────────────

/** Config normalisieren + validieren (Fail-Fast, analog OcsClient). */
function normalizeConfig(raw: TalkPollerConfig): Required<TalkPollerConfig> {
	const cfg: Record<string, unknown> = { ...DEFAULTS };
	for (const [key, value] of Object.entries(raw)) {
		if (value !== undefined) cfg[key] = value;
	}
	const c = cfg as Required<TalkPollerConfig>;

	if (c.pollMode !== "long-poll" && c.pollMode !== "interval") {
		throw new Error(
			`TalkPoller: ungültiges pollMode "${String(c.pollMode)}" (erwartet "long-poll" | "interval")`,
		);
	}
	if (
		!Number.isInteger(c.longPollTimeoutSeconds) ||
		c.longPollTimeoutSeconds < 0 ||
		c.longPollTimeoutSeconds > 60
	) {
		throw new Error(
			`TalkPoller: longPollTimeoutSeconds muss eine Ganzzahl in [0, 60] sein, erhalten ${String(c.longPollTimeoutSeconds)}`,
		);
	}
	if (!Number.isFinite(c.intervalMs) || c.intervalMs <= 0) {
		throw new Error(`TalkPoller: intervalMs muss > 0 sein, erhalten ${String(c.intervalMs)}`);
	}
	if (!Number.isFinite(c.minPollIntervalMs) || c.minPollIntervalMs <= 0) {
		throw new Error(
			`TalkPoller: minPollIntervalMs muss > 0 sein, erhalten ${String(c.minPollIntervalMs)}`,
		);
	}
	if (!Number.isFinite(c.backoffMaxMs) || c.backoffMaxMs < c.minPollIntervalMs) {
		throw new Error(
			`TalkPoller: backoffMaxMs muss ≥ minPollIntervalMs sein, erhalten ${String(c.backoffMaxMs)}`,
		);
	}
	if (!Number.isInteger(c.maxConcurrentPolls) || c.maxConcurrentPolls < 1) {
		throw new Error(
			`TalkPoller: maxConcurrentPolls muss eine Ganzzahl ≥ 1 sein, erhalten ${String(c.maxConcurrentPolls)}`,
		);
	}
	if (!Number.isInteger(c.circuitThreshold) || c.circuitThreshold < 1) {
		throw new Error(
			`TalkPoller: circuitThreshold muss eine Ganzzahl ≥ 1 sein, erhalten ${String(c.circuitThreshold)}`,
		);
	}
	if (!Number.isInteger(c.batchLimit) || c.batchLimit < 1 || c.batchLimit > 100) {
		throw new Error(
			`TalkPoller: batchLimit muss eine Ganzzahl in [1, 100] sein (D9), erhalten ${String(c.batchLimit)}`,
		);
	}
	if (typeof c.ownUserId !== "string") {
		throw new Error(
			`TalkPoller: ownUserId muss ein String sein, erhalten ${typeof c.ownUserId}`,
		);
	}
	c.ownUserId = c.ownUserId.trim();
	return c;
}

/** Log-sichere Fehlerbeschreibung (OcsClient liefert bereits ohne Secrets). */
function describeError(err: unknown): string {
	if (err instanceof TalkError) return `${err.code}: ${err.message}`;
	if (err instanceof Error) return err.message;
	return String(err);
}
