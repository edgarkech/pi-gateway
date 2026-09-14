/**
 * Nextcloud Talk Adapter (Phase 4 S4).
 *
 * Source: concept_phase_4_nextcloud.md §7 (Adapter-Design), §5.3 (Selbst-Filter/D4),
 * §6.4 (UserID-Identifikation), §7.2 (Outbound-Mapping auf OCS), §7.3 (Medien-Inbound),
 * §7.4 (Rich-Object-Auflösung), §10 (Config-Validierung), §11 (Fehlerbehandlung
 * N1/N5/N6/N8), §12 (Teststrategie).
 *
 * Architektur (D5/D6):
 * - Der Adapter orchestriert; das eigentliche Polling läuft im eigenen,
 *   testbaren Modul `NextcloudTalkPoller` (S3) auf Basis von `OcsClient` (S1)
 *   und dem SQLite-Wasserstands-Store (S2).
 * - `start()` instanziiert + startet den Poller für alle konfigurierten Räume;
 *   `stop()` beendet ihn und schließt die Talk-State-DB — aber nur bei
 *   Default-Store (Symmetrie zu `start()`, das ihn auch nur dort initialisiert);
 *   injizierte Stores verwalten ihre eigene Persistenz. Der Daemon darf
 *   `shutdownTalkStateStore()` zusätzlich aufrufen (§5.4, idempotent).
 * - Inbound: Poller → `handleTalkMessage()` → zentraler `isPublishable`-Filter
 *   (D4 Anti-Loop) → `resolveRichText()` + `ingestAttachments()` (Phase-3-
 *   MediaManager, D7) → `emitMessage(PlatformMessage)` → bestehende Pipeline
 *   (Sessions/Allowlist/Rate-Limit greifen unverändert, §8).
 * - Outbound: `sendMessage`/`editMessage`/`deleteMessage` mappen 1:1 auf die
 *   OCS-Chat-Endpoints; Nachrichten > 32k Zeichen werden clientseitig in
 *   Teilnachrichten gebrochen (N6, Talk-Limit → sonst HTTP 413).
 * - `setTyping` ist ein No-Op (N2: kein REST-Endpoint ohne Signaling-Server);
 *   `sendInteractive` nutzt den Text-Fallback aus `BaseAdapter`.
 *
 * Testbarkeit (§12): `isPublishable`, `resolveRichText`, `kindForMime`,
 * `extractFileObjects`, `chunkMessage` und `validateNextcloudTalkConfig` sind
 * exportierte Pure Functions. OCS-Client und State-Store sind strukturell über
 * den Constructor (`deps`) injizierbar — Tests brauchen keine echte Nextcloud.
 */

import type { Readable } from "node:stream";

import {
	BaseAdapter,
	type AdapterCallbacks,
	type PlatformConfig,
	type PlatformMessage,
} from "./base.js";
import { OcsClient, TalkError } from "./nextcloud/ocs.js";
import {
	NextcloudTalkPoller,
	defaultTalkStateStore,
	type PollerState,
	type TalkChatPollClient,
	type TalkPollerConfig,
	type TalkStateStore,
} from "./nextcloud/poller.js";
import { initTalkStateStore, shutdownTalkStateStore } from "./nextcloud/store.js";
import type { TalkChatMessage, TalkRichObject, TalkRoom } from "./nextcloud/talk-types.js";
import { logger } from "../logger.js";
import { runtime } from "../state.js";
import { MediaError, type MediaAttachment, type MediaKind } from "../media/types.js";
import { initMediaManager } from "../media/manager.js";

// ── Konfiguration (Konzept §7.1 / §10) ────────────────────────────────────────

/**
 * Adapter-Konfiguration. Spiegelt den `platforms.nextcloudTalk`-Config-Block
 * aus Konzept §10 — die eigentliche Config-Integration (types.ts/config.ts/
 * registry.ts) folgt in S5; bis dahin wird der Adapter direkt mit diesem
 * Objekt konstruiert.
 */
export interface NextcloudTalkConfig extends PlatformConfig {
	platform: "nextcloudTalk";
	/** z. B. "https://nextcloud.local" (ohne trailing slash). */
	baseUrl: string;
	/** Nextcloud-Login des Bot-Accounts (Auth, Selbst-Filter, WebDAV-Pfad). */
	userId: string;
	/** App-Passwort/App-Token — NICHT das Hauptpasswort (D8). */
	appToken: string;
	/** Talk-Raum-Tokens (MVP: explizit konfiguriert, D2). */
	rooms: string[];

	// Polling (Defaults im Poller, §10)
	pollMode?: "long-poll" | "interval";
	longPollTimeoutSeconds?: number;
	intervalMs?: number;
	minPollIntervalMs?: number;
	backoffMaxMs?: number;
	maxConcurrentPolls?: number;
	circuitThreshold?: number;

	// Discovery (P2b, Konzept §10.2 — war bisher nur in config, jetzt konsumiert)
	/**
	 * Wenn `true`: beim Start/Reload werden alle Räume, denen der Bot-User
	 * angehört (`listRooms()`), zusätzlich zu den explizit konfigurierten
	 * Räumen überwacht. Default `false` (MVP: explizite Räume, D2).
	 */
	autoDiscoverRooms?: boolean;
	/**
	 * Refresh-Intervall in ms für die Room-Discovery — nur wirksam bei
	 * `autoDiscoverRooms: true`. In jedem Intervall wird das Raum-Set neu
	 * geladen und der Poller diffed (neue Räume aufgenommen, verschwundene
	 * entfernt + geprunt). Default 60_000 (wie config).
	 */
	roomRefreshIntervalMs?: number;

	// Security
	allowInsecureHttp?: boolean;

	// Media (Default: media.maxAttachmentsPerMessage aus Konzept §10)
	maxAttachmentsPerMessage?: number;
}

/**
 * Strukturelle OCS-Schnittstelle des Adapters — `OcsClient` erfüllt sie
 * automatisch. Tests injizieren ein Fake ohne echte HTTP-Schicht (§12).
 * Enthält zusätzlich zu den Outbound-/Media-Methoden den Chat-Poll-Endpoint,
 * weil derselbe Client an den Poller (S3) weitergereicht wird.
 */
export interface NextcloudTalkOcs extends TalkChatPollClient {
	listRooms(opts?: { modifiedSince?: number }): Promise<TalkRoom[]>;
	sendChatMessage(room: string, text: string): Promise<TalkChatMessage>;
	editChatMessage(room: string, messageId: number, text: string): Promise<void>;
	deleteChatMessage(room: string, messageId: number): Promise<void>;
	/** WebDAV-Stream für den Media-Ingest (§7.3/D7). */
	openFileStream(userPath: string): Promise<Readable>;
}

// ── Pure Helpers (exportiert für Unit-Tests, Konzept §12) ─────────────────────

/** Talk-Nachrichten-Limit in Zeichen (Konzept §7.2/N6 — sonst HTTP 413). */
export const TALK_MESSAGE_LIMIT = 32_000;

/** Default-Intervall für die Room-Discovery (P2b, entspricht config-Default). */
export const DEFAULT_ROOM_REFRESH_INTERVAL_MS = 60_000;

/**
 * Rich-Object-Typen, die ein teilbares Medium darstellen (Konzept §7.3:
 * "file" bzw. "media"/"audio"/"voice"/"video"/"recording").
 */
const MEDIA_OBJECT_TYPES = new Set(["file", "media", "audio", "video", "voice", "recording"]);

/**
 * Zentraler Publishable-Filter (Konzept §5.3/D4 — Anti-Endlos-Loop-Core).
 * Der Gateway antwortet als derselbe OCS-User, der auch pollt; ohne diesen
 * Filter würde jede Bot-Antwort erneut als Eingabe verarbeitet.
 *
 * | Bedingung                              | Ergebnis    |
 * |----------------------------------------|-------------|
 * | `actorType === "bots"`                 | verwerfen   |
 * | `actorId === config.userId` (eigene)   | verwerfen   |
 * | `systemMessage !== ""` (System-Event)  | verwerfen   |
 * | `messageType === "command"` (MVP)      | verwerfen   |
 * | `messageType === "comment_deleted"`    | verwerfen   |
 * | sonst (echter User-Text/Datei-Sharing) | **publishable** |
 */
export function isPublishable(config: NextcloudTalkConfig, msg: TalkChatMessage): boolean {
	if (msg.actorType === "bots") return false;
	if (config.userId !== "" && msg.actorId === config.userId) return false;
	if (msg.systemMessage !== "") return false;
	if (msg.messageType === "command") return false;
	if (msg.messageType === "comment_deleted") return false;
	return true;
}

/**
 * `PlatformMessage.userId` aus dem Sender ableiten (Konzept §6.4): bei
 * `actorType === "users"` der stabile Nextcloud-UserID (Allowlist-kompatibel),
 * sonst Anzeigename mit Fallback auf actorId (Gäste/Federation).
 */
export function resolveUserId(msg: TalkChatMessage): string {
	if (msg.actorType === "users") return msg.actorId;
	return msg.actorDisplayName || msg.actorId;
}

/**
 * Menschlesbare Beschreibung eines Rich Objects für den Klartext-Pfad
 * (Konzept §7.4): Datei-Platzhalter → "[Anhang: <name>]", Mentions →
 * "@<Anzeigename>", Emojis → Name, unbekannt → "[<type>: <name>]".
 */
export function describeRichObject(obj: TalkRichObject): string {
	if (MEDIA_OBJECT_TYPES.has(obj.type)) return `[Anhang: ${obj.name}]`;
	if (obj.type === "user" || obj.type === "guest" || obj.type === "federated_user") {
		return `@${obj.name}`;
	}
	if (obj.type === "emoji") return obj.name;
	return `[${obj.type}: ${obj.name}]`;
}

/**
 * Rich-Object-Platzhalter in Klartext auflösen (Konzept §7.4).
 * `msg.message` enthält `{key}`-Platzhalter; jeder wird durch die Beschreibung
 * des zugehörigen `messageParameters[key]` ersetzt (alle Vorkommen). Die
 * eigentliche Medienverarbeitung läuft separat über `ingestAttachments()`.
 */
export function resolveRichText(msg: TalkChatMessage): string {
	let text = msg.message ?? "";
	const params = msg.messageParameters;
	if (params) {
		for (const [key, obj] of Object.entries(params)) {
			if (!obj || typeof obj !== "object") continue;
			text = text.split(`{${key}}`).join(describeRichObject(obj));
		}
	}
	return text.trim();
}

/** MIME → MediaKind-Hinweis (Konzept §7.3); der Manager verifiziert ohnehin. */
export function kindForMime(mime: string | undefined): MediaKind {
	if (!mime) return "document";
	const m = mime.toLowerCase();
	if (m.startsWith("image/")) return "image";
	if (m.startsWith("audio/")) return "audio";
	if (m.startsWith("video/")) return "video";
	return "document";
}

/**
 * Medien-Rich-Objects aus `messageParameters` extrahieren und auf
 * `maxPerMessage` deckeln (Konzept §7.3, D9-Rate-Cap). Reihenfolge =
 * Object-Eintragsreihenfolge des Servers.
 */
export function extractFileObjects(msg: TalkChatMessage, maxPerMessage: number): TalkRichObject[] {
	const params = msg.messageParameters ?? {};
	const files: TalkRichObject[] = [];
	for (const obj of Object.values(params)) {
		if (!obj || typeof obj !== "object") continue;
		if (!MEDIA_OBJECT_TYPES.has(obj.type)) continue;
		files.push(obj);
	}
	return files.slice(0, Math.max(1, maxPerMessage));
}

/**
 * Nachricht in Teilnachrichten ≤ `limit` Zeichen brechen (Konzept §7.2/N6).
 * Zeilenumbrüche werden bevorzugt (ab der Fensterhälfte), sonst wird hart
 * geschnitten — die Verkettung aller Teile ergibt exakt den Originaltext.
 */
export function chunkMessage(text: string, limit: number = TALK_MESSAGE_LIMIT): string[] {
	if (!Number.isInteger(limit) || limit < 1) {
		throw new Error(
			`chunkMessage: limit muss eine Ganzzahl ≥ 1 sein, erhalten ${String(limit)}`,
		);
	}
	if (text.length <= limit) return [text];

	const parts: string[] = [];
	let rest = text;
	while (rest.length > limit) {
		const nl = rest.lastIndexOf("\n", limit - 1);
		const cut = nl >= Math.floor(limit / 2) ? nl + 1 : limit;
		parts.push(rest.slice(0, cut));
		rest = rest.slice(cut);
	}
	if (rest.length > 0) parts.push(rest);
	return parts;
}

/**
 * Konfigurierte und entdeckte Raum-Tokens zusammenführen (P2b, Auto-Discovery):
 * konfigurierte Räume zuerst (stabile Reihenfolge), Duplikate werden entfernt,
 * leere/ungültige Tokens still übersprungen. Exportiert für Unit-Tests (§12).
 */
export function mergeDiscoveredRooms(configured: string[], discovered: string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const room of [...configured, ...discovered]) {
		if (typeof room !== "string" || room.trim() === "") continue;
		if (seen.has(room)) continue;
		seen.add(room);
		out.push(room);
	}
	return out;
}

/**
 * Config-Validierung (Konzept §10): Fail-Fast mit klaren Meldungen. Wird in
 * `initialize()` aufgerufen — ungültige Konfiguration deaktiviert den Kanal
 * sauber statt zur Laufzeit zu scheitern (N1).
 */
export function validateNextcloudTalkConfig(config: NextcloudTalkConfig): void {
	const fail = (msg: string): never => {
		throw new Error(`NextcloudTalk config: ${msg}`);
	};

	if (typeof config.baseUrl !== "string" || config.baseUrl.trim() === "") {
		fail("baseUrl fehlt");
	}
	// Hinweis (TS 6): `never`-returnende Helper werden von der CFA nicht als
	// Terminierung erkannt — daher hier expliziter throw statt `fail()`.
	let url: URL | null;
	try {
		url = new URL(config.baseUrl);
	} catch {
		url = null;
	}
	if (url === null) {
		throw new Error(`NextcloudTalk config: baseUrl ist keine gültige URL: "${config.baseUrl}"`);
	}
	const proto = url.protocol.toLowerCase();
	if (proto !== "https:" && !(proto === "http:" && config.allowInsecureHttp)) {
		fail("baseUrl muss https:// sein (oder http:// nur mit allowInsecureHttp: true)");
	}

	if (typeof config.userId !== "string" || config.userId.trim() === "") {
		fail("userId fehlt (Nextcloud-Login des Bot-Accounts)");
	}
	if (typeof config.appToken !== "string" || config.appToken.trim() === "") {
		fail("appToken fehlt (App-Passwort, nicht das Hauptpasswort — D8)");
	}
	if (config.appToken.includes("…") || config.appToken.startsWith("<")) {
		fail(
			"appToken ist ein Platzhalter — bitte ein echtes App-Passwort setzen " +
				"(Config oder NEXTCLOUD_TALK_APP_TOKEN)",
		);
	}

	if (!Array.isArray(config.rooms) || config.rooms.length === 0) {
		fail("rooms muss ein nicht-leeres Array aus Raum-Tokens sein (MVP: explizit, D2)");
	}
	for (const room of config.rooms) {
		if (typeof room !== "string" || room.trim() === "") {
			fail("rooms enthält einen leeren/ungültigen Token");
		}
	}

	if (
		config.pollMode !== undefined &&
		config.pollMode !== "long-poll" &&
		config.pollMode !== "interval"
	) {
		fail(
			`pollMode muss "long-poll" oder "interval" sein, erhalten "${String(config.pollMode)}"`,
		);
	}

	checkIntInRange("longPollTimeoutSeconds", config.longPollTimeoutSeconds, 0, 60);
	checkPositive("intervalMs", config.intervalMs);
	checkPositive("minPollIntervalMs", config.minPollIntervalMs);
	checkPositive("backoffMaxMs", config.backoffMaxMs);
	checkIntMin("maxConcurrentPolls", config.maxConcurrentPolls, 1);
	checkIntMin("circuitThreshold", config.circuitThreshold, 1);
	checkIntMin("maxAttachmentsPerMessage", config.maxAttachmentsPerMessage, 1);

	// P2b: Discovery-Optionen (TS erzwingt die Typen bereits; defensiv für
	// zur Laufzeit gemergte Config-Objekte).
	if (config.autoDiscoverRooms !== undefined && typeof config.autoDiscoverRooms !== "boolean") {
		fail(
			`autoDiscoverRooms muss ein Boolean sein, erhalten ${String(config.autoDiscoverRooms)}`,
		);
	}
	checkPositive("roomRefreshIntervalMs", config.roomRefreshIntervalMs);
}

function checkPositive(name: string, value: number | undefined): void {
	if (value === undefined) return;
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`NextcloudTalk config: ${name} muss > 0 sein, erhalten ${String(value)}`);
	}
}

function checkIntMin(name: string, value: number | undefined, min: number): void {
	if (value === undefined) return;
	if (!Number.isInteger(value) || value < min) {
		throw new Error(
			`NextcloudTalk config: ${name} muss eine Ganzzahl ≥ ${min} sein, erhalten ${String(value)}`,
		);
	}
}

function checkIntInRange(name: string, value: number | undefined, min: number, max: number): void {
	if (value === undefined) return;
	if (!Number.isInteger(value) || value < min || value > max) {
		throw new Error(
			`NextcloudTalk config: ${name} muss eine Ganzzahl in [${min}, ${max}] sein, erhalten ${String(value)}`,
		);
	}
}

/** Log-sichere Fehlerbeschreibung (TalkError liefert bereits ohne Secrets). */
function describeError(err: unknown): string {
	if (err instanceof TalkError) return `${err.code}: ${err.message}`;
	if (err instanceof Error) return err.message;
	return String(err);
}

// ── Adapter ───────────────────────────────────────────────────────────────────

/** Default für Anhänge pro Nachricht (Konzept §10, bis S5 config-gesetzt). */
const DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE = 4;

/** Optional injizierbare Abhängigkeiten (Testbarkeit, Konzept §12). */
export interface NextcloudTalkAdapterDeps {
	/** Fertiger OCS-Client (Default: aus Config gebaut in `initialize()`). */
	ocs?: NextcloudTalkOcs;
	/** Wasserstands-Store (Default: SQLite via `store.ts`, S2). */
	store?: TalkStateStore;
}

export class NextcloudTalkAdapter extends BaseAdapter {
	readonly platform = "nextcloudTalk" as const;
	config: NextcloudTalkConfig;

	private ocs: NextcloudTalkOcs | null = null;
	private poller: NextcloudTalkPoller | null = null;
	private readonly store: TalkStateStore;
	private connected = false;
	/** Letzter Poller-State-Snapshot (für `getStatus()`). */
	private lastState: PollerState | null = null;
	/** P2b: Timer für den periodischen Room-Discovery-Refresh (unref'd). */
	private roomRefreshTimer: ReturnType<typeof setInterval> | null = null;

	constructor(config: NextcloudTalkConfig, deps: NextcloudTalkAdapterDeps = {}) {
		super();
		this.config = config;
		this.ocs = deps.ocs ?? null;
		this.store = deps.store ?? defaultTalkStateStore;
	}

	/**
	 * Config validieren (§10), OCS-Client anlegen und die Auth früh prüfen
	 * (Muster Telegram `/getMe`): `listRooms()` wirft bei 401/403 `AUTH_FAILED`
	 * → der Adapter-Registry-Pfad deaktiviert den Kanal sauber (N1).
	 */
	async initialize(): Promise<void> {
		validateNextcloudTalkConfig(this.config);

		if (!this.ocs) {
			this.ocs = new OcsClient({
				baseUrl: this.config.baseUrl,
				userId: this.config.userId,
				appToken: this.config.appToken,
				allowInsecureHttp: this.config.allowInsecureHttp,
			});
			if (this.config.allowInsecureHttp) {
				logger.warn(
					"[NextcloudTalk] WARNUNG: unsicheres http:// aktiviert (allowInsecureHttp: true)",
				);
			}
		}

		try {
			await this.ocs.listRooms();
		} catch (err) {
			throw new Error(`Nextcloud Talk auth failed: ${describeError(err)}`, { cause: err });
		}

		logger.info(
			`[NextcloudTalk] Initialisiert (user=${this.config.userId}, ` +
				`rooms=${this.config.rooms.length})`,
		);
	}

	/**
	 * Startet den Talk-Poller für alle überwachten Räume (§5.4/D5, P2b).
	 * Der Poller liest die Wasserstände warm aus dem Store (D3: kein
	 * Re-Processing nach Restart) und emittiert neue Nachrichten via
	 * `handleTalkMessage()` (fire-and-forget, Fehler isoliert).
	 *
	 * P2b (Auto-Discovery): bei `autoDiscoverRooms: true` werden zusätzlich
	 * alle Räume aus `listRooms()` aufgenommen; bei gesetztem
	 * `roomRefreshIntervalMs` läuft ein unref'd-Timer, der das Raum-Set in dem
	 * Intervall per `setActiveRooms()` auffrischt (neue Räume an, verschwundene
	 * aus + Prune). Discovery-Fehler brechen den Start NICHT — der Adapter
	 * läuft dann nur mit den explizit konfigurierten Räumen weiter (N1-Analog).
	 */
	async start(callbacks: AdapterCallbacks): Promise<void> {
		await super.start(callbacks);
		if (!this.ocs) {
			throw new Error(
				"NextcloudTalkAdapter: initialize() muss vor start() aufgerufen werden",
			);
		}
		if (this.poller) {
			throw new Error("NextcloudTalkAdapter: bereits gestartet — erst stop() aufrufen");
		}

		// Warm-Start der Talk-State-DB (nur bei Default-Store; injizierte Stores
		// verwalten ihre eigene Persistenz, §5.4).
		if (this.store === defaultTalkStateStore) {
			initTalkStateStore();
		}

		this.poller = new NextcloudTalkPoller(this.ocs, {
			config: this.pollerConfig(),
			store: this.store,
			onMessage: (msg) => {
				// Fire-and-forget (Konzept §7.1): die Async-Logik (Rich-Text,
				// Media-Ingest, Emit) läuft parallel zum Poll-Loop; Fehler werden
				// isoliert geloggt, der Loop bleibt am Leben (§11).
				void this.handleTalkMessage(msg).catch((err) =>
					logger.error("[NextcloudTalk] handle message failed:", err),
				);
			},
			onState: (state) => {
				this.lastState = state;
			},
		});
		this.connected = true;

		// P2b: Auto-Discovery — konfigurierte + entdeckte Räume zusammenführen.
		// Bei Discovery-Fehler (z. B. transientes 5xx): nur konfigurierte Räume
		// starten, und KEIN Prune (der Zustand kurzzeitig nicht sichtbarer Räume
		// darf nicht gelöscht werden — der nächste Refresh heilt das).
		let rooms = [...this.config.rooms];
		let prune = true;
		if (this.config.autoDiscoverRooms) {
			const discovered = await this.discoverRoomTokens();
			if (discovered === null) {
				prune = false; // Discovery fehlgeschlagen (bereits gewarnt)
			} else {
				rooms = mergeDiscoveredRooms(rooms, discovered);
				logger.info(
					`[NextcloudTalk] Auto-Discovery: ${discovered.length} Raum(e) entdeckt ` +
						`→ ${rooms.length} überwacht`,
				);
			}
		}

		// Room-Prune (§5.2): persistierte Wasserstände für Räume, die nicht mehr
		// konfiguriert sind, aufräumen — sicher, da `rooms` bei Validierung
		// nicht-leer sein muss (ein leeres Config kann keinen Zustand löschen).
		this.poller.start(rooms, { pruneRemovedRooms: prune });
		this.startRoomRefresh();

		logger.info(
			`[NextcloudTalk] Gestartet (${rooms.length} Räume, ` +
				`mode=${this.config.pollMode ?? "long-poll"}, ` +
				`autoDiscover=${this.config.autoDiscoverRooms ? "on" : "off"})`,
		);
	}

	/**
	 * P2b: Raum-Tokens des Bot-Users per `listRooms()` laden. Liefert `null`
	 * bei Fehler (mit Warn-Log) — der Aufrufer fällt dann auf die explizit
	 * konfigurierten Räume zurück.
	 */
	private async discoverRoomTokens(): Promise<string[] | null> {
		const ocs = this.ocs;
		if (!ocs) return null;
		try {
			const rooms = await ocs.listRooms();
			return rooms
				.map((r) => r.token)
				.filter(
					(token): token is string => typeof token === "string" && token.trim() !== "",
				);
		} catch (err) {
			logger.warn(
				`[NextcloudTalk] Auto-Discovery fehlgeschlagen — nur konfigurierte Räume aktiv: ` +
					`${describeError(err)}`,
			);
			return null;
		}
	}

	/**
	 * P2b: startet den periodischen Room-Refresh (nur bei `autoDiscoverRooms`
	 * aktiv). Der Timer ist unref'd und hält den Prozess nicht offen (§5.4).
	 */
	private startRoomRefresh(): void {
		this.stopRoomRefresh();
		if (!this.config.autoDiscoverRooms) return;
		const intervalMs = this.config.roomRefreshIntervalMs ?? DEFAULT_ROOM_REFRESH_INTERVAL_MS;
		this.roomRefreshTimer = setInterval(() => {
			void this.refreshRooms().catch((err) =>
				logger.error("[NextcloudTalk] Room-Refresh fehlgeschlagen:", err),
			);
		}, intervalMs);
		this.roomRefreshTimer.unref?.();
	}

	/** P2b: führt einen Discovery-Zyklus aus und diffed das Poller-Raum-Set. */
	private async refreshRooms(): Promise<void> {
		const poller = this.poller;
		if (!this.connected || !poller) return;
		const discovered = await this.discoverRoomTokens();
		if (discovered === null) return; // bereits gewarnt; altes Set bleibt aktiv
		const rooms = mergeDiscoveredRooms([...this.config.rooms], discovered);
		poller.setActiveRooms(rooms, { pruneRemovedRooms: true });
	}

	/** P2b: stoppt den Room-Refresh-Timer (idempotent). */
	private stopRoomRefresh(): void {
		if (this.roomRefreshTimer) {
			clearInterval(this.roomRefreshTimer);
			this.roomRefreshTimer = null;
		}
	}

	/**
	 * Stoppt den Poller (wartet auf in-flight-Polls) und schließt die
	 * Talk-State-DB. Idempotent; sicher auch ohne vorherigen `start()`.
	 *
	 * Die SQLite-DB wird nur geschlossen, wenn der Default-Store verwendet
	 * wird — Symmetrie zu `start()`, das `initTalkStateStore()` ebenfalls nur
	 * dort aufruft. Ein injizierter Store (Tests) darf dadurch keine globale
	 * Singleton-DB schließen.
	 */
	async stop(): Promise<void> {
		this.connected = false;
		this.stopRoomRefresh(); // P2b: kein Refresh-Timer überleben
		if (this.poller) {
			await this.poller.stop();
			this.poller = null;
		}
		if (this.store === defaultTalkStateStore) {
			shutdownTalkStateStore();
		}
		await super.stop();
	}

	/**
	 * Inbound-Kern (Konzept §7.1): transformiert eine Talk-Nachricht in ein
	 * `PlatformMessage` und emittiert es in die bestehende Pipeline (§8).
	 *
	 * Ablauf: zentraler `isPublishable`-Filter (D4 Anti-Loop) → Rich-Text-
	 * Auflösung (§7.4) → Medien-Ingest (§7.3, isolierte Fehler, N5) → Emit.
	 * Öffentliche Methode (statt `private` aus dem Konzept-Skizze), damit die
	 * PlatformMessage-Mappings und der Anti-Loop-Filter direkt unit-testbar
	 * sind (Konzept §12).
	 */
	async handleTalkMessage(msg: TalkChatMessage): Promise<void> {
		if (!isPublishable(this.config, msg)) return;

		const content = resolveRichText(msg);
		const attachments = await this.ingestAttachments(msg);

		// Analog Telegram E9: weder Text noch Anhänge → nichts emittieren.
		if (content === "" && attachments.length === 0) return;

		const message: PlatformMessage = {
			id: this.generateMessageId(),
			platform: "nextcloudTalk",
			channelId: msg.token,
			userId: resolveUserId(msg),
			content,
			timestamp: msg.timestamp * 1000,
			metadata: {
				talkMessageId: msg.id,
				actorType: msg.actorType,
				actorDisplayName: msg.actorDisplayName,
				roomToken: msg.token,
				isEdit: msg.lastEditTimestamp !== undefined,
			},
			attachments: attachments.length > 0 ? attachments : undefined,
		};
		await this.emitMessage(message);
	}

	/**
	 * Medien-Inbound (Konzept §7.3/D7): Datei-Rich-Objects aus
	 * `messageParameters` werden über den Phase-3-MediaManager ingestet —
	 * Download-Closure streamt per WebDAV als Bot-User, Magic-Byte-Sniffing,
	 * Quota und TTL übernimmt der Manager unverändert. Dedup über die stabile
	 * File-ID (`fileRef`). Fehler sind pro Anhang isoliert (N5): die Nachricht
	 * läuft weiter, nur der fehlerhafte Anhang fehlt.
	 */
	private async ingestAttachments(msg: TalkChatMessage): Promise<MediaAttachment[]> {
		const ocs = this.ocs;
		if (!ocs) return [];

		const maxPerMsg =
			this.config.maxAttachmentsPerMessage ?? DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE;
		const files = extractFileObjects(msg, maxPerMsg);
		if (files.length === 0) return [];

		const mediaManager = runtime.media ?? initMediaManager();
		const out: MediaAttachment[] = [];
		for (const f of files) {
			const path = f.path;
			if (!f.id || !path) {
				logger.warn(
					`[NextcloudTalk] Datei-Anhang ohne id/path ignoriert ` +
						`(Nachricht ${msg.id}, "${f.name}")`,
				);
				continue;
			}
			try {
				const attachment = await mediaManager.ingest({
					platform: "nextcloudTalk",
					messageId: String(msg.id),
					channelId: msg.token,
					userId: msg.actorId,
					fileRef: f.id, // stabile File-ID → Dedup-Key (D7)
					fileName: f.name,
					declaredMime: f.mimetype,
					declaredSizeBytes: f.size,
					kindHint: kindForMime(f.mimetype),
					// Lazy-Download-Closure: WebDAV-Stream aus
					// remote.php/dav/files/{userId}/{path} (verifiziert via
					// Phase-3-Magic-Bytes, §9.3).
					fetch: () => ocs.openFileStream(path),
				});
				out.push(attachment);
			} catch (err) {
				const code = err instanceof MediaError ? err.code : "UNKNOWN";
				logger.warn(
					`[NextcloudTalk] media ingest failed (${code}) für "${f.name}": ` +
						describeError(err),
				);
			}
		}
		return out;
	}

	/**
	 * Nachricht senden (Konzept §7.2): `POST /chat/{token}` → messageId.
	 * Nachrichten > 32k Zeichen werden clientseitig in Teilnachrichten
	 * gebrochen (N6 — Talk-Limit, sonst HTTP 413).
	 */
	async sendMessage(channelId: string, content: string): Promise<string> {
		const ocs = this.requireOcs();
		if (content.trim() === "") {
			throw new Error("NextcloudTalk: sendMessage verweigert leeren Content");
		}
		let lastId = "0";
		for (const part of chunkMessage(content)) {
			const sent = await ocs.sendChatMessage(channelId, part);
			lastId = String(sent?.id ?? 0);
		}
		return lastId;
	}

	/** Nachricht editieren (§7.2): `PUT /chat/{token}/{messageId}` (Streaming-Edit). */
	async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
		const ocs = this.requireOcs();
		await ocs.editChatMessage(channelId, parseMessageId(messageId), content);
	}

	/** Nachricht löschen (§7.2): `DELETE /chat/{token}/{messageId}` (nur eigene). */
	async deleteMessage(channelId: string, messageId: string): Promise<void> {
		const ocs = this.requireOcs();
		await ocs.deleteChatMessage(channelId, parseMessageId(messageId));
	}

	/**
	 * Typing-Indikator: No-Op (Konzept N2) — Talk stellt ohne
	 * Signaling-Server keinen REST-Endpoint dafür bereit.
	 */
	async setTyping(_channelId: string, _isTyping: boolean): Promise<void> {
		// bewusst leer (N2)
	}

	/**
	 * Adapter-Status (§7.2): `connected` + Latenz des letzten erfolgreichen
	 * Polls (max. über alle Räume aus dem Poller-State).
	 */
	async getStatus(): Promise<{ connected: boolean; latency?: number }> {
		const state = this.lastState ?? this.poller?.getState() ?? null;
		let latency: number | undefined;
		if (state) {
			for (const room of state.rooms) {
				if (room.lastLatencyMs !== undefined && Number.isFinite(room.lastLatencyMs)) {
					latency = Math.max(latency ?? 0, room.lastLatencyMs);
				}
			}
		}
		return { connected: this.connected, latency };
	}

	/**
	 * Interactive-Cleanup: No-Op (Konzept §7.2) — `sendInteractive` nutzt den
	 * Text-Fallback aus `BaseAdapter`; es gibt keine Buttons zum Entfernen.
	 */
	override async cleanupInteractive(_channelId: string, _messageId: string): Promise<void> {
		// bewusst leer — kein natives Interactive-UI im MVP
	}

	// ── Private Hilfsfunktionen ───────────────────────────────────────────────

	/** OCS-Client oder klarer Fehler (vor `initialize()`). */
	private requireOcs(): NextcloudTalkOcs {
		if (!this.ocs) {
			throw new Error("NextcloudTalkAdapter: nicht initialisiert (initialize() aufrufen)");
		}
		return this.ocs;
	}

	/** Adapter-Config → Poller-Config (1:1-Mapping, Konzept §10). */
	private pollerConfig(): TalkPollerConfig {
		return {
			pollMode: this.config.pollMode,
			longPollTimeoutSeconds: this.config.longPollTimeoutSeconds,
			intervalMs: this.config.intervalMs,
			minPollIntervalMs: this.config.minPollIntervalMs,
			backoffMaxMs: this.config.backoffMaxMs,
			maxConcurrentPolls: this.config.maxConcurrentPolls,
			circuitThreshold: this.config.circuitThreshold,
			// D4: Anti-Loop-Selbstfilter im Poller (Vorschaltfilter; der
			// zentrale Check läuft zusätzlich in `isPublishable`).
			ownUserId: this.config.userId,
		};
	}
}

/** Talk-Nachrichten-ID (Integer) aus dem String-MessageId parsen. */
function parseMessageId(messageId: string): number {
	const id = Number(messageId);
	if (!Number.isInteger(id) || id <= 0) {
		throw new Error(
			`NextcloudTalk: ungültige messageId "${messageId}" (erwartet positive Integer-ID)`,
		);
	}
	return id;
}
