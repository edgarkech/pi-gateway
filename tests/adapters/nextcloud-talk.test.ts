/**
 * Phase 4 (S4) — NextcloudTalkAdapter unit tests.
 *
 * Abdeckung nach Konzept §12 (Zeile "nextcloud-talk.test.ts"):
 *   1. `isPublishable` — Selbst-/System-/Command-Filter (Anti-Loop-Core, D4).
 *   2. `resolveRichText` / `describeRichObject` / `resolveUserId` (§7.4/§6.4).
 *   3. `kindForMime`, `extractFileObjects` (§7.3, D9-Rate-Cap).
 *   4. `chunkMessage` (§7.2/N6: Talk-Limit 32k, sonst HTTP 413).
 *   5. `validateNextcloudTalkConfig` (§10: Fail-Fast, https-Pflicht,
 *      Platzhalter-Guard, Intervall-Grenzen).
 *   6. Adapter-Methoden: `initialize()` (Auth-Frühcheck N1),
 *      `handleTalkMessage` (PlatformMessage-Mapping §8, Medien-Inbound D7,
 *      isolierte Media-Fehler N5), `sendMessage`/`editMessage`/`deleteMessage`
 *      (§7.2), `setTyping`-No-Op (N2), `getStatus`, `sendInteractive`-Fallback.
 *   7. Lifecycle & Poller-Integration: start/stop, Config-Mapping an den
 *      Poller (S3), Injizierter Store ohne SQLite-Side-Effects.
 *   8. Anti-Loop-Integration End-to-End (§12-Fokus): Bot-Antworten aus dem
 *      Poll-Batch werden NICHT erneut emittiert; der Offset springt darüber
 *      hinweg (kein Re-Delivery, keine Endlosschleife).
 *
 * Methodik nach Konzept §12 ("Mock-Klient + Mock-MediaManager"):
 * Fake `OcsClient` (strukturell über `NextcloudTalkOcs` injizierbar) +
 * In-Memory-`TalkStateStore` + Fake-`MediaManager` auf `runtime.media` —
 * keine echte Nextcloud, kein SQLite, kein Dateisystem.
 */

import { existsSync } from "node:fs";
import { Readable } from "node:stream";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { AdapterCallbacks, PlatformMessage } from "../../src/adapters/base.js";
import {
	DEFAULT_ROOM_REFRESH_INTERVAL_MS,
	NextcloudTalkAdapter,
	TALK_MESSAGE_LIMIT,
	chunkMessage,
	describeRichObject,
	extractFileObjects,
	isPublishable,
	kindForMime,
	mergeDiscoveredRooms,
	resolveRichText,
	resolveUserId,
	validateNextcloudTalkConfig,
	type NextcloudTalkConfig,
	type NextcloudTalkOcs,
} from "../../src/adapters/nextcloud-talk.js";
import { TalkError } from "../../src/adapters/nextcloud/ocs.js";
import type {
	TalkReceiveChatQuery,
	TalkReceiveChatResult,
	TalkStateStore,
} from "../../src/adapters/nextcloud/poller.js";
import type {
	TalkChatMessage,
	TalkRichObject,
	TalkRoom,
} from "../../src/adapters/nextcloud/talk-types.js";
import { MediaError, type MediaAttachment } from "../../src/media/types.js";
import type { MediaIngestRequest, MediaManager } from "../../src/media/manager.js";
import { runtime } from "../../src/state.js";

// ── Test-Helfer: Builder ───────────────────────────────────────────────────────

/** Builder für eine gültige Adapter-Config (MVP-Defaults, §10). */
function testConfig(overrides: Partial<NextcloudTalkConfig> = {}): NextcloudTalkConfig {
	return {
		enabled: true,
		platform: "nextcloudTalk",
		baseUrl: "https://nc.local",
		userId: "bot-gw",
		appToken: "app-token-123",
		rooms: ["room-a"],
		...overrides,
	};
}

/** Builder für eine realistische Talk-Chat-Nachricht (wie ocs.test.ts). */
function talkMessage(overrides: Partial<TalkChatMessage> = {}): TalkChatMessage {
	return {
		id: 501,
		token: "room-a",
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

/** Datei-Rich-Object (wie bei Talk-Datei-Sharing, §6.2/§7.3). */
function fileObject(overrides: Partial<TalkRichObject> = {}): TalkRichObject {
	return {
		type: "file",
		id: "file-1",
		name: "report.pdf",
		path: "Inbox/report.pdf",
		mimetype: "application/pdf",
		size: 1234,
		link: "https://nc.local/s/abc",
		...overrides,
	};
}

// ── Test-Helfer: Fakes (Konzept §12: Mock-Klient + Mock-MediaManager) ─────────

/**
 * Fake OCS-Client: erfüllt `NextcloudTalkOcs` strukturell ohne HTTP-Schicht.
 * Protokolliert alle Outbound-Aufrufe; `receiveChat` liefert skriptierte
 * Antworten (nach Erschöpfung ewig 304 = inaktiver Raum).
 */
class FakeOcs implements NextcloudTalkOcs {
	rooms: TalkRoom[] = [];
	listRoomsCalls = 0;
	/** Wenn gesetzt, wirft `listRooms()` mit diesem Error (Auth-Frühcheck-Tests). */
	listRoomsError: unknown = null;
	sent: Array<{ room: string; text: string }> = [];
	edits: Array<{ room: string; id: number; text: string }> = [];
	deletes: Array<{ room: string; id: number }> = [];
	openFileCalls: string[] = [];
	receiveChatCalls: Array<{ room: string; query: TalkReceiveChatQuery }> = [];
	/** Skript für `receiveChat` (pro Aufruf ein Eintrag); danach ewig 304. */
	receiveScript: TalkReceiveChatResult[] = [];
	private nextId = 1000;

	async listRooms(): Promise<TalkRoom[]> {
		this.listRoomsCalls += 1;
		if (this.listRoomsError) throw this.listRoomsError;
		return this.rooms;
	}

	async receiveChat(room: string, query: TalkReceiveChatQuery): Promise<TalkReceiveChatResult> {
		this.receiveChatCalls.push({ room, query });
		const entry = this.receiveScript.shift();
		return entry ?? { status: 304, messages: [] };
	}

	async sendChatMessage(room: string, text: string): Promise<TalkChatMessage> {
		this.sent.push({ room, text });
		return {
			id: this.nextId++,
			token: room,
			actorType: "users",
			actorId: "bot-gw",
			actorDisplayName: "Bot",
			timestamp: Math.floor(Date.now() / 1000),
			systemMessage: "",
			messageType: "comment",
			message: text,
			messageParameters: {},
		};
	}

	async editChatMessage(room: string, messageId: number, text: string): Promise<void> {
		this.edits.push({ room, id: messageId, text });
	}

	async deleteChatMessage(room: string, messageId: number): Promise<void> {
		this.deletes.push({ room, id: messageId });
	}

	async openFileStream(userPath: string): Promise<Readable> {
		this.openFileCalls.push(userPath);
		return Readable.from([Buffer.from("fake-webdav-bytes")]);
	}
}

/** In-Memory-Wasserstands-Store (statt SQLite, vgl. Konzept §12). */
class FakeStore implements TalkStateStore {
	values = new Map<string, number>();
	sets: Array<{ room: string; id: number }> = [];

	getLastKnownMessageId(roomToken: string): number {
		return this.values.get(roomToken) ?? 0;
	}

	setLastKnownMessageId(roomToken: string, lastKnownMessageId: number): void {
		this.values.set(roomToken, lastKnownMessageId);
		this.sets.push({ room: roomToken, id: lastKnownMessageId });
	}

	getAllStates(): Record<string, number> {
		return Object.fromEntries(this.values);
	}

	pruneRooms(roomTokens: string[]): number {
		let removed = 0;
		for (const room of roomTokens) {
			if (this.values.delete(room)) removed += 1;
		}
		return removed;
	}
}

/**
 * Fake MediaManager: erfüllt das Phase-3-`MediaManager`-Interface und
 * protokolliert die Ingest-Requests. Pro Aufruf skriptierbar (Attachment oder
 * Error); Default = erfolgreiches Attachment.
 */
class FakeMediaManager implements MediaManager {
	ingestCalls: MediaIngestRequest[] = [];
	/** Skript pro Ingest-Aufruf (Error werfen oder festes Attachment liefern). */
	script: Array<MediaAttachment | Error> = [];

	async ingest(req: MediaIngestRequest): Promise<MediaAttachment> {
		this.ingestCalls.push(req);
		const entry = this.script.shift();
		if (entry instanceof Error) throw entry;
		if (entry) return entry;
		return {
			id: `med_${String(this.ingestCalls.length).padStart(2, "0")}`,
			kind: req.kindHint ?? "document",
			mimeType: req.declaredMime ?? "application/octet-stream",
			fileName: req.fileName ?? "file.bin",
			sizeBytes: 10,
			localPath: "/tmp/fake-media/file.bin",
			source: { platform: req.platform, messageId: req.messageId, fileRef: req.fileRef },
		};
	}

	async discard(ids: string[]): Promise<void> {
		void ids;
	}

	async sweep(): Promise<{ deletedFiles: number; freedBytes: number }> {
		return { deletedFiles: 0, freedBytes: 0 };
	}

	async stats(): Promise<{ fileCount: number; totalBytes: number; oldestAt: number | null }> {
		return { fileCount: 0, totalBytes: 0, oldestAt: null };
	}
}

// ── Test-Helfer: Harness & Timing ─────────────────────────────────────────────

interface Harness {
	adapter: NextcloudTalkAdapter;
	ocs: FakeOcs;
	store: FakeStore;
	media: FakeMediaManager;
	/** Alle via Adapter-Callback emittierten PlatformMessages. */
	emitted: PlatformMessage[];
}

/**
 * Baut einen Adapter mit injizierten Fakes (OCS + Store + MediaManager auf
 * `runtime.media`). Keine SQLite, keine echte Nextcloud, kein Dateisystem.
 */
function makeHarness(configOverrides: Partial<NextcloudTalkConfig> = {}): Harness {
	const ocs = new FakeOcs();
	const store = new FakeStore();
	const media = new FakeMediaManager();
	runtime.media = media;
	const emitted: PlatformMessage[] = [];
	const adapter = new NextcloudTalkAdapter(testConfig(configOverrides), { ocs, store });
	activeAdapters.push(adapter);
	return { adapter, ocs, store, media, emitted };
}

/** Adapter-Callbacks, die emittierte Nachrichten in `emitted` sammeln. */
function callbacksFor(emitted: PlatformMessage[]): AdapterCallbacks {
	return {
		onMessage: (message) => {
			emitted.push(message);
			return Promise.resolve();
		},
	};
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Pollt `cond`, bis es true ist oder das Timeout abläuft (echte Timer). */
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
	const t0 = Date.now();
	while (!cond()) {
		if (Date.now() - t0 > timeoutMs) {
			throw new Error(`waitFor: Bedingung nicht erfüllt innerhalb von ${timeoutMs} ms`);
		}
		await sleep(3);
	}
}

// Stellt sicher, dass nach jedem Test keine Poller-Loops/Timer überleben und
// der MediaManager-Slot wieder frei ist.
const activeAdapters: NextcloudTalkAdapter[] = [];
afterEach(async () => {
	for (const adapter of activeAdapters) {
		await adapter.stop().catch(() => {});
	}
	activeAdapters.length = 0;
	runtime.media = null;
});

// ── 1. isPublishable (Konzept §5.3/D4 — Anti-Endlos-Loop-Core) ────────────────

describe("isPublishable (D4 Anti-Loop-Core)", () => {
	const config = testConfig(); // userId: "bot-gw"

	it("akzeptiert eine normale User-Nachricht", () => {
		expect(isPublishable(config, talkMessage())).toBe(true);
	});

	it("verwirft eigene Nachrichten (actorId === config.userId)", () => {
		expect(isPublishable(config, talkMessage({ actorId: "bot-gw" }))).toBe(false);
	});

	it('verwirft Bot-Aktoren (actorType === "bots")', () => {
		expect(
			isPublishable(config, talkMessage({ actorType: "bots", actorId: "other-bot" })),
		).toBe(false);
	});

	it('verwirft System-Nachrichten (systemMessage !== "")', () => {
		expect(
			isPublishable(
				config,
				talkMessage({ systemMessage: "message_deleted", messageType: "system" }),
			),
		).toBe(false);
	});

	it('verwirft Commands (messageType === "command", MVP ohne Bot-Kommandos)', () => {
		expect(isPublishable(config, talkMessage({ messageType: "command" }))).toBe(false);
	});

	it('verwirft gelöschte Kommentare (messageType === "comment_deleted")', () => {
		expect(isPublishable(config, talkMessage({ messageType: "comment_deleted" }))).toBe(false);
	});

	it('akzeptiert Gäste (actorType === "guests")', () => {
		expect(
			isPublishable(
				config,
				talkMessage({ actorType: "guests", actorId: "g-1", actorDisplayName: "Guest" }),
			),
		).toBe(true);
	});
});

// ── 2. resolveUserId (Konzept §6.4) ───────────────────────────────────────────

describe("resolveUserId (§6.4)", () => {
	it('liefert bei actorType === "users" den stabilen Nextcloud-UserID', () => {
		expect(resolveUserId(talkMessage({ actorType: "users", actorId: "alice" }))).toBe("alice");
	});

	it("liefert bei Gästen den Anzeigenamen", () => {
		expect(
			resolveUserId(
				talkMessage({ actorType: "guests", actorId: "g-9", actorDisplayName: "Gast" }),
			),
		).toBe("Gast");
	});

	it("fällt bei Gästen ohne Anzeigenamen auf actorId zurück", () => {
		expect(
			resolveUserId(
				talkMessage({ actorType: "guests", actorId: "g-9", actorDisplayName: "" }),
			),
		).toBe("g-9");
	});
});

// ── 3. describeRichObject & resolveRichText (Konzept §7.4) ────────────────────

describe("describeRichObject (§7.4)", () => {
	it("beschreibt Medien-Typen als Anhang", () => {
		for (const type of ["file", "media", "audio", "video", "voice", "recording"]) {
			expect(describeRichObject({ type, id: "1", name: "x.bin" })).toBe("[Anhang: x.bin]");
		}
	});

	it("beschreibt Mentions als @Name", () => {
		for (const type of ["user", "guest", "federated_user"]) {
			expect(describeRichObject({ type, id: "1", name: "Alice" })).toBe("@Alice");
		}
	});

	it("beschreibt Emojis als Namen", () => {
		expect(describeRichObject({ type: "emoji", id: "1", name: "🎉" })).toBe("🎉");
	});

	it("beschreibt unbekannte Typen generisch", () => {
		expect(describeRichObject({ type: "call", id: "1", name: "Meeting" })).toBe(
			"[call: Meeting]",
		);
	});
});

describe("resolveRichText (§7.4)", () => {
	it("liefert Klartext ohne Parameter unverändert (getrimmt)", () => {
		expect(resolveRichText(talkMessage({ message: "  hallo welt  " }))).toBe("hallo welt");
	});

	it("ersetzt Datei-Platzhalter durch [Anhang: <name>]", () => {
		const msg = talkMessage({
			message: "siehe {file}",
			messageParameters: { file: fileObject() },
		});
		expect(resolveRichText(msg)).toBe("siehe [Anhang: report.pdf]");
	});

	it("ersetzt Mention-Platzhalter durch @<Anzeigename>", () => {
		const msg = talkMessage({
			message: "hallo {user}",
			messageParameters: { user: { type: "user", id: "u1", name: "Bob" } },
		});
		expect(resolveRichText(msg)).toBe("hallo @Bob");
	});

	it("ersetzt alle Vorkommen desselben Platzhalters", () => {
		const msg = talkMessage({
			message: "{file} und nochmal {file}",
			messageParameters: { file: fileObject() },
		});
		expect(resolveRichText(msg)).toBe("[Anhang: report.pdf] und nochmal [Anhang: report.pdf]");
	});

	it("ersetzt unbekannte Objekt-Typen generisch", () => {
		const msg = talkMessage({
			message: "rund um {call}",
			messageParameters: { call: { type: "call", id: "c1", name: "Sprint" } },
		});
		expect(resolveRichText(msg)).toBe("rund um [call: Sprint]");
	});

	it("liefert leeren String bei fehlendem/leerem message-Feld", () => {
		expect(resolveRichText({ ...talkMessage(), message: undefined } as TalkChatMessage)).toBe(
			"",
		);
		expect(resolveRichText(talkMessage({ message: "   " }))).toBe("");
	});

	it("überspringt nicht-objektige Parameter-Werte (defensiv)", () => {
		const msg = talkMessage({
			message: "kaputt {file}",
			messageParameters: { file: "kein-objekt" } as unknown as Record<string, TalkRichObject>,
		});
		expect(resolveRichText(msg)).toBe("kaputt {file}");
	});
});

// ── 4. kindForMime (Konzept §7.3) ─────────────────────────────────────────────

describe("kindForMime (§7.3)", () => {
	it("mappt image/* → image", () => {
		expect(kindForMime("image/png")).toBe("image");
		expect(kindForMime("IMAGE/JPEG")).toBe("image"); // case-insensitiv
	});

	it("mappt audio/* → audio", () => {
		expect(kindForMime("audio/mpeg")).toBe("audio");
	});

	it("mappt video/* → video", () => {
		expect(kindForMime("video/mp4")).toBe("video");
	});

	it("mappt alles andere auf document (Default)", () => {
		expect(kindForMime("application/pdf")).toBe("document");
		expect(kindForMime("text/plain")).toBe("document");
	});

	it("liefert document bei fehlendem MIME", () => {
		expect(kindForMime(undefined)).toBe("document");
	});
});

// ── 5. extractFileObjects (Konzept §7.3, D9-Rate-Cap) ─────────────────────────

describe("extractFileObjects (§7.3)", () => {
	function msgWithFiles(): TalkChatMessage {
		return talkMessage({
			message: "{a} {b} {c} {mention}",
			messageParameters: {
				a: fileObject({ id: "f1", name: "a.pdf" }),
				b: { type: "user", id: "u1", name: "Bob" }, // kein Medium
				c: fileObject({ id: "f2", name: "c.mp4", type: "video", mimetype: "video/mp4" }),
				mention: { type: "user", id: "u2", name: "Alice" }, // kein Medium
			},
		});
	}

	it("extrahiert nur Medien-Typen in Eintragsreihenfolge", () => {
		const files = extractFileObjects(msgWithFiles(), 10);
		expect(files.map((f) => f.id)).toEqual(["f1", "f2"]);
	});

	it("deckelt auf maxPerMessage", () => {
		expect(extractFileObjects(msgWithFiles(), 1)).toHaveLength(1);
		expect(extractFileObjects(msgWithFiles(), 1)[0].id).toBe("f1");
	});

	it("liefert [] bei fehlenden/leeren Parametern", () => {
		expect(extractFileObjects(talkMessage({ messageParameters: {} }), 4)).toEqual([]);
		expect(
			extractFileObjects(
				{ ...talkMessage(), messageParameters: undefined } as TalkChatMessage,
				4,
			),
		).toEqual([]);
	});

	it("akzeptiert maxPerMessage < 1 (mindestens 1 Anhang)", () => {
		expect(extractFileObjects(msgWithFiles(), 0)).toHaveLength(1);
	});
});

// ── 6. chunkMessage (Konzept §7.2/N6 — Talk-Limit 32k) ────────────────────────

describe("chunkMessage (§7.2/N6)", () => {
	it("liefert kurze Texte als Einzelteil", () => {
		expect(chunkMessage("hallo", 100)).toEqual(["hallo"]);
	});

	it("liefert Text exakt am Limit als Einzelteil", () => {
		const text = "x".repeat(50);
		expect(chunkMessage(text, 50)).toEqual([text]);
	});

	it("schneidet hart, wenn kein Zeilenumbruch passt (Verlustfreiheit)", () => {
		const parts = chunkMessage("abcdefghij", 3);
		expect(parts).toEqual(["abc", "def", "ghi", "j"]);
		expect(parts.join("")).toBe("abcdefghij");
		for (const p of parts) expect(p.length).toBeLessThanOrEqual(3);
	});

	it("bricht bevorzugt an Zeilenumbrüchen (ab Fensterhälfte)", () => {
		const doc = "zeile1\nzeile2\nzeile3\nzeile4";
		const parts = chunkMessage(doc, 10);
		expect(parts).toEqual(["zeile1\n", "zeile2\n", "zeile3\n", "zeile4"]);
		expect(parts.join("")).toBe(doc);
	});

	it("schneidet hart, wenn der Umbruch in der ersten Fensterhälfte liegt", () => {
		// "ab\ncdefghij" (11 Zeichen): \n bei Index 2 < floor(6/2)=3 → harter Cut bei 6.
		const parts = chunkMessage("ab\ncdefghij", 6);
		expect(parts).toEqual(["ab\ncde", "fghij"]);
		expect(parts.join("")).toBe("ab\ncdefghij");
	});

	it("liefert leeren String als einzelnes leeres Teil", () => {
		expect(chunkMessage("", 10)).toEqual([""]);
	});

	it("nutzt per Default TALK_MESSAGE_LIMIT (32k)", () => {
		const long = "a".repeat(TALK_MESSAGE_LIMIT + 10);
		const parts = chunkMessage(long);
		expect(parts).toHaveLength(2);
		expect(parts[0].length).toBe(TALK_MESSAGE_LIMIT);
		expect(parts.join("")).toBe(long);
	});

	it("wirft bei ungültigem Limit (Ganzzahl ≥ 1)", () => {
		for (const bad of [0, -5, 2.5, Number.NaN]) {
			expect(() => chunkMessage("abc", bad)).toThrow(/Ganzzahl/);
		}
	});
});

// ── 7. validateNextcloudTalkConfig (Konzept §10) ──────────────────────────────

describe("validateNextcloudTalkConfig (§10)", () => {
	it("akzeptiert eine gültige Minimal-Config", () => {
		expect(() => validateNextcloudTalkConfig(testConfig())).not.toThrow();
	});

	it("akzeptiert http:// nur mit allowInsecureHttp: true", () => {
		expect(() => validateNextcloudTalkConfig(testConfig({ baseUrl: "http://nc.lan" }))).toThrow(
			/https/,
		);
		expect(() =>
			validateNextcloudTalkConfig(
				testConfig({ baseUrl: "http://nc.lan", allowInsecureHttp: true }),
			),
		).not.toThrow();
	});

	it("verwirft fehlende/ungültige baseUrl", () => {
		expect(() => validateNextcloudTalkConfig(testConfig({ baseUrl: "" }))).toThrow(/baseUrl/);
		// Ohne Scheme wirft `new URL(...)` → „keine gültige URL“.
		expect(() =>
			validateNextcloudTalkConfig(testConfig({ baseUrl: "plain-string-ohne-scheme" })),
		).toThrow(/gültige URL/);
	});

	it("verwirft fehlende userId/appToken", () => {
		expect(() => validateNextcloudTalkConfig(testConfig({ userId: "" }))).toThrow(/userId/);
		expect(() => validateNextcloudTalkConfig(testConfig({ appToken: "" }))).toThrow(/appToken/);
	});

	it("verwirft Platzhalter-App-Tokens (Guard gegen unkonfigurierte Seeds)", () => {
		expect(() => validateNextcloudTalkConfig(testConfig({ appToken: "…" }))).toThrow(
			/Platzhalter/,
		);
		expect(() => validateNextcloudTalkConfig(testConfig({ appToken: "<token>" }))).toThrow(
			/Platzhalter/,
		);
	});

	it("verwirft leeres/ungültiges rooms-Array (MVP: explizit, D2)", () => {
		expect(() => validateNextcloudTalkConfig(testConfig({ rooms: [] }))).toThrow(/rooms/);
		expect(() => validateNextcloudTalkConfig(testConfig({ rooms: ["ok", "  "] }))).toThrow(
			/rooms/,
		);
	});

	it("verwirft ungültiges pollMode", () => {
		expect(() =>
			validateNextcloudTalkConfig(
				testConfig({ pollMode: "sometimes" } as NextcloudTalkConfig),
			),
		).toThrow(/pollMode/);
	});

	it("validiert longPollTimeoutSeconds (Ganzzahl in [0, 60])", () => {
		for (const bad of [-1, 61, 2.5]) {
			expect(() =>
				validateNextcloudTalkConfig(testConfig({ longPollTimeoutSeconds: bad })),
			).toThrow(/longPollTimeoutSeconds/);
		}
		for (const ok of [0, 60]) {
			expect(() =>
				validateNextcloudTalkConfig(testConfig({ longPollTimeoutSeconds: ok })),
			).not.toThrow();
		}
	});

	it("validiert Intervalle/Backoff (> 0)", () => {
		for (const bad of [0, -1]) {
			expect(() => validateNextcloudTalkConfig(testConfig({ intervalMs: bad }))).toThrow(
				/intervalMs/,
			);
			expect(() =>
				validateNextcloudTalkConfig(testConfig({ minPollIntervalMs: bad })),
			).toThrow(/minPollIntervalMs/);
			expect(() => validateNextcloudTalkConfig(testConfig({ backoffMaxMs: bad }))).toThrow(
				/backoffMaxMs/,
			);
		}
	});

	it("validiert Ganzzahl-Felder (≥ 1)", () => {
		for (const bad of [0, 1.5]) {
			expect(() =>
				validateNextcloudTalkConfig(testConfig({ maxConcurrentPolls: bad })),
			).toThrow(/maxConcurrentPolls/);
			expect(() =>
				validateNextcloudTalkConfig(testConfig({ circuitThreshold: bad })),
			).toThrow(/circuitThreshold/);
			expect(() =>
				validateNextcloudTalkConfig(testConfig({ maxAttachmentsPerMessage: bad })),
			).toThrow(/maxAttachmentsPerMessage/);
		}
	});
});

// ── 8. Adapter — initialize() (Konzept §7.1, N1) ──────────────────────────────

describe("NextcloudTalkAdapter — initialize()", () => {
	it("validiert Config und prüft Auth früh via listRooms (Muster Telegram /getMe)", async () => {
		const h = makeHarness();
		await h.adapter.initialize();
		expect(h.ocs.listRoomsCalls).toBe(1);
	});

	it("wirft bei Auth-Fehler mit klarer Meldung (N1: Kanal deaktiviert)", async () => {
		const h = makeHarness();
		h.ocs.listRoomsError = new TalkError("AUTH_FAILED", "401 Unauthorized");
		await expect(h.adapter.initialize()).rejects.toThrow(/auth failed/);
	});

	it("wirft bei ungültiger Config, BEVOR der OCS-Client angerufen wird (Fail-Fast)", async () => {
		const h = makeHarness({ baseUrl: "http://nc.local" }); // ohne allowInsecureHttp
		await expect(h.adapter.initialize()).rejects.toThrow(/https/);
		expect(h.ocs.listRoomsCalls).toBe(0);
	});
});

// ── 9. Adapter — handleTalkMessage (PlatformMessage-Mapping, §8) ──────────────

describe("NextcloudTalkAdapter — handleTalkMessage (Mapping §8)", () => {
	it("emittiert publishable Text-Nachricht mit korrektem Mapping", async () => {
		const h = makeHarness();
		await h.adapter.start(callbacksFor(h.emitted)); // Callbacks registrieren (emitMessage)
		await h.adapter.handleTalkMessage(
			talkMessage({ id: 7, token: "room-x", message: "hallo" }),
		);

		expect(h.emitted).toHaveLength(1);
		const m = h.emitted[0];
		expect(m.platform).toBe("nextcloudTalk");
		expect(m.channelId).toBe("room-x"); // Raum-Token als Kanal-Key (§8)
		expect(m.userId).toBe("alice"); // Sender-actorId → Allowlist-kompatibel (§6.4)
		expect(m.content).toBe("hallo");
		expect(m.timestamp).toBe(1_700_000_000 * 1000); // Sekunden → Millisekunden
		expect(m.metadata).toMatchObject({
			talkMessageId: 7,
			actorType: "users",
			actorDisplayName: "Alice",
			roomToken: "room-x",
			isEdit: false,
		});
		expect(m.attachments).toBeUndefined();
	});

	it("setzt userId für Gäste auf den Anzeigenamen (§6.4)", async () => {
		const h = makeHarness();
		await h.adapter.start(callbacksFor(h.emitted));
		await h.adapter.handleTalkMessage(
			talkMessage({ id: 8, actorType: "guests", actorId: "g-1", actorDisplayName: "Gast" }),
		);
		expect(h.emitted[0].userId).toBe("Gast");
	});

	it("markiert editierte Nachrichten (metadata.isEdit)", async () => {
		const h = makeHarness();
		await h.adapter.start(callbacksFor(h.emitted));
		await h.adapter.handleTalkMessage(
			talkMessage({ id: 9, message: "editiert", lastEditTimestamp: 1_700_000_123 }),
		);
		expect(h.emitted[0].metadata?.isEdit).toBe(true);
	});

	it("verwirft eigene Nachrichten — Anti-Loop (D4)", async () => {
		const h = makeHarness();
		await h.adapter.start(callbacksFor(h.emitted));
		await h.adapter.handleTalkMessage(talkMessage({ id: 10, actorId: "bot-gw" }));
		expect(h.emitted).toHaveLength(0);
	});

	it("verwirft System-/Command-Nachrichten (D4)", async () => {
		const h = makeHarness();
		await h.adapter.start(callbacksFor(h.emitted));
		await h.adapter.handleTalkMessage(
			talkMessage({ id: 11, systemMessage: "user_joined", messageType: "system" }),
		);
		await h.adapter.handleTalkMessage(talkMessage({ id: 12, messageType: "command" }));
		expect(h.emitted).toHaveLength(0);
	});

	it("emittiert nichts, wenn weder Text noch Anhänge vorliegen", async () => {
		const h = makeHarness();
		await h.adapter.start(callbacksFor(h.emitted));
		await h.adapter.handleTalkMessage(talkMessage({ id: 13, message: "   " }));
		expect(h.emitted).toHaveLength(0);
	});
});

// ── 10. Adapter — Medien-Inbound (Konzept §7.3/D7) ────────────────────────────

describe("NextcloudTalkAdapter — Medien-Inbound (D7)", () => {
	it("ingestet Datei-Anhänge über den Phase-3-MediaManager", async () => {
		const h = makeHarness();
		await h.adapter.start(callbacksFor(h.emitted));
		await h.adapter.handleTalkMessage(
			talkMessage({ id: 20, message: "{file}", messageParameters: { file: fileObject() } }),
		);

		expect(h.emitted).toHaveLength(1);
		expect(h.emitted[0].content).toBe("[Anhang: report.pdf]");
		expect(h.emitted[0].attachments).toHaveLength(1);

		// Ingest-Request trägt Phase-3-Kontext + Dedup-Key (stabile File-ID).
		const req = h.media.ingestCalls[0];
		expect(req.platform).toBe("nextcloudTalk");
		expect(req.messageId).toBe("20");
		expect(req.channelId).toBe("room-a");
		expect(req.userId).toBe("alice");
		expect(req.fileRef).toBe("file-1");
		expect(req.fileName).toBe("report.pdf");
		expect(req.declaredMime).toBe("application/pdf");
		expect(req.declaredSizeBytes).toBe(1234);
		expect(req.kindHint).toBe("document");

		// Lazy-Download-Closure: WebDAV-Stream via OcsClient.openFileStream(path).
		const stream = await req.fetch();
		expect(stream).toBeInstanceOf(Readable);
		expect(h.ocs.openFileCalls).toEqual(["Inbox/report.pdf"]);
	});

	it("setzt kindHint aus dem MIME-Typ (image/* → image)", async () => {
		const h = makeHarness();
		await h.adapter.start(callbacksFor(h.emitted));
		await h.adapter.handleTalkMessage(
			talkMessage({
				id: 21,
				message: "{file}",
				messageParameters: {
					file: fileObject({ id: "f-img", name: "foto.png", mimetype: "image/png" }),
				},
			}),
		);
		expect(h.media.ingestCalls[0].kindHint).toBe("image");
	});

	it("isoliert Media-Fehler (N5): Nachricht läuft weiter, fehlerhafter Anhang fehlt", async () => {
		const h = makeHarness();
		await h.adapter.start(callbacksFor(h.emitted));
		h.media.script.push(new MediaError("DOWNLOAD_FAILED", "webdav down"));
		await h.adapter.handleTalkMessage(
			talkMessage({
				id: 22,
				message: "Blick {file}",
				messageParameters: { file: fileObject() },
			}),
		);

		expect(h.emitted).toHaveLength(1); // Nachricht trotz Media-Fehler emittiert
		expect(h.emitted[0].content).toBe("Blick [Anhang: report.pdf]");
		expect(h.emitted[0].attachments ?? []).toHaveLength(0);
	});

	it("deckelt Anhänge auf maxAttachmentsPerMessage (D9-Rate-Cap)", async () => {
		const h = makeHarness({ maxAttachmentsPerMessage: 2 });
		await h.adapter.start(callbacksFor(h.emitted));
		await h.adapter.handleTalkMessage(
			talkMessage({
				id: 23,
				message: "{a} {b} {c}",
				messageParameters: {
					a: fileObject({ id: "f1", name: "a.pdf" }),
					b: fileObject({ id: "f2", name: "b.pdf" }),
					c: fileObject({ id: "f3", name: "c.pdf" }),
				},
			}),
		);

		expect(h.media.ingestCalls).toHaveLength(2);
		expect(h.media.ingestCalls.map((r) => r.fileRef)).toEqual(["f1", "f2"]);
		expect(h.emitted[0].attachments).toHaveLength(2);
	});

	it("ignoriert Datei-Objekte ohne id/path (kein Ingest, Text bleibt)", async () => {
		const h = makeHarness();
		await h.adapter.start(callbacksFor(h.emitted));
		await h.adapter.handleTalkMessage(
			talkMessage({
				id: 24,
				message: "ohne pfad {file}",
				messageParameters: { file: fileObject({ id: "", path: undefined }) },
			}),
		);

		expect(h.media.ingestCalls).toHaveLength(0);
		expect(h.emitted).toHaveLength(1);
		expect(h.emitted[0].content).toBe("ohne pfad [Anhang: report.pdf]");
	});
});

// ── 11. Adapter — Outbound (Konzept §7.2) ─────────────────────────────────────

describe("NextcloudTalkAdapter — Outbound (§7.2)", () => {
	it("sendet kurze Nachricht einmal und liefert die messageId", async () => {
		const h = makeHarness();
		const id = await h.adapter.sendMessage("room-a", "hallo");
		expect(h.ocs.sent).toEqual([{ room: "room-a", text: "hallo" }]);
		expect(id).toBe("1000"); // erste Fake-ID aus sendChatMessage
	});

	it("bricht >32k-Nachrichten in Teilnachrichten (N6) und liefert die letzte ID", async () => {
		const h = makeHarness();
		const text = "x".repeat(TALK_MESSAGE_LIMIT + 5_000);
		const id = await h.adapter.sendMessage("room-a", text);

		expect(h.ocs.sent).toHaveLength(2);
		for (const part of h.ocs.sent) {
			expect(part.text.length).toBeLessThanOrEqual(TALK_MESSAGE_LIMIT);
		}
		expect(h.ocs.sent.map((p) => p.text).join("")).toBe(text); // verlustfrei
		expect(id).toBe("1001"); // letzte Teilnachricht
	});

	it("verweigert leeren Content (kein leerer POST an Talk)", async () => {
		const h = makeHarness();
		await expect(h.adapter.sendMessage("room-a", "   ")).rejects.toThrow(/leeren Content/);
		expect(h.ocs.sent).toHaveLength(0);
	});

	it("editMessage parst die messageId und ruft PUT auf", async () => {
		const h = makeHarness();
		await h.adapter.editMessage("room-a", "123", "neu");
		expect(h.ocs.edits).toEqual([{ room: "room-a", id: 123, text: "neu" }]);
	});

	it("editMessage wirft bei ungültiger messageId", async () => {
		const h = makeHarness();
		await expect(h.adapter.editMessage("room-a", "abc", "x")).rejects.toThrow(
			/ungültige messageId/,
		);
		await expect(h.adapter.editMessage("room-a", "0", "x")).rejects.toThrow(
			/ungültige messageId/,
		);
		expect(h.ocs.edits).toHaveLength(0);
	});

	it("deleteMessage parst die messageId und ruft DELETE auf", async () => {
		const h = makeHarness();
		await h.adapter.deleteMessage("room-a", "42");
		expect(h.ocs.deletes).toEqual([{ room: "room-a", id: 42 }]);
	});

	it("setTyping ist ein No-Op (N2: kein REST-Endpoint ohne Signaling)", async () => {
		const h = makeHarness();
		await expect(h.adapter.setTyping("room-a", true)).resolves.toBeUndefined();
		expect(h.ocs.sent).toHaveLength(0);
	});

	it("sendInteractive nutzt den Text-Fallback aus BaseAdapter", async () => {
		const h = makeHarness();
		const res = await h.adapter.sendInteractive("room-a", {
			requestId: "r1",
			method: "confirm",
			title: "Fortfahren?",
		});
		expect(h.ocs.sent).toHaveLength(1);
		expect(h.ocs.sent[0].text).toContain("Fortfahren?");
		expect(res.messageId).toBe("1000");
	});

	it("cleanupInteractive ist ein No-Op (kein natives Interactive-UI im MVP)", async () => {
		const h = makeHarness();
		await expect(h.adapter.cleanupInteractive("room-a", "1")).resolves.toBeUndefined();
	});
});

// ── 12. Adapter — getStatus & Lifecycle (Konzept §7.2/§5.4) ───────────────────

describe("NextcloudTalkAdapter — getStatus & Lifecycle", () => {
	it("vor start(): connected=false, keine Latenz", async () => {
		const h = makeHarness();
		expect(await h.adapter.getStatus()).toEqual({ connected: false });
	});

	it("nach start(): connected=true; Latenz nach erfolgreichem Poll", async () => {
		const h = makeHarness({ minPollIntervalMs: 10 });
		h.ocs.receiveScript.push({ status: 200, messages: [talkMessage({ id: 30 })] });
		await h.adapter.start(callbacksFor(h.emitted));

		expect((await h.adapter.getStatus()).connected).toBe(true);
		await waitFor(() => h.store.sets.length === 1); // Batch verarbeitet → State emittiert
		const status = await h.adapter.getStatus();
		expect(status.connected).toBe(true);
		expect(typeof status.latency).toBe("number");
	});

	it("start() ohne OCS (kein injizierter Client) wirft — initialize() zuerst", async () => {
		const bare = new NextcloudTalkAdapter(testConfig());
		await expect(bare.start(callbacksFor([]))).rejects.toThrow(/initialize/);
	});

	it("doppeltes start() wirft (erst stop() aufrufen)", async () => {
		const h = makeHarness();
		await h.adapter.start(callbacksFor(h.emitted));
		await expect(h.adapter.start(callbacksFor(h.emitted))).rejects.toThrow(/bereits gestartet/);
	});

	it("stop() vor start() ist sicher (idempotent)", async () => {
		const h = makeHarness();
		await expect(h.adapter.stop()).resolves.toBeUndefined();
		expect((await h.adapter.getStatus()).connected).toBe(false);
	});

	it("start() überträgt die Adapter-Config an den Poller (Long-Poll-Parameter)", async () => {
		const h = makeHarness({ longPollTimeoutSeconds: 7, minPollIntervalMs: 10 });
		await h.adapter.start(callbacksFor(h.emitted));
		await waitFor(() => h.ocs.receiveChatCalls.length >= 1);

		expect(h.ocs.receiveChatCalls[0].query).toEqual({
			lookIntoFuture: 1,
			timeout: 7, // aus config.longPollTimeoutSeconds (Config-Mapping)
			lastKnownMessageId: 0, // Warm-Start aus (leerer) Store
			limit: 100, // Poller-Default (D9: ≤ 100)
		});
	});

	it("stop() beendet den Poll (keine weiteren receiveChat-Aufrufe)", async () => {
		const h = makeHarness({ minPollIntervalMs: 10 });
		await h.adapter.start(callbacksFor(h.emitted));
		await waitFor(() => h.ocs.receiveChatCalls.length >= 2);

		await h.adapter.stop();
		expect((await h.adapter.getStatus()).connected).toBe(false);
		const callsAfterStop = h.ocs.receiveChatCalls.length;
		await sleep(50);
		expect(h.ocs.receiveChatCalls.length).toBe(callsAfterStop);
	});

	it("verwendet mit injiziertem Store keine SQLite-DB (kein File in HOME)", async () => {
		const h = makeHarness();
		await h.adapter.start(callbacksFor(h.emitted));
		await waitFor(() => h.ocs.receiveChatCalls.length >= 1);
		await h.adapter.stop();

		// start()/stop() dürfen mit injiziertem Store die globale Singleton-DB
		// weder öffnen noch schließen (Symmetrie-Fix, §5.4).
		const dbPath = join(process.env.HOME ?? "", ".pi", "gateway", "talk_poll_state.db");
		expect(existsSync(dbPath)).toBe(false);
	});
});

// ── 13. Anti-Loop-Integration End-to-End (Konzept §12-Fokus, D4) ──────────────

describe("NextcloudTalkAdapter — Anti-Loop-Integration (D4)", () => {
	it("emittiert aus einem Mixed-Batch nur echte User-Nachrichten", async () => {
		const h = makeHarness({ minPollIntervalMs: 10 });
		h.ocs.receiveScript.push({
			status: 200,
			messages: [
				talkMessage({ id: 40, actorId: "alice", message: "hallo" }),
				// Die eigene Antwort des Bots (derselbe OCS-User!) — darf NICHT
				// erneut als Eingabe verarbeitet werden.
				talkMessage({ id: 41, actorId: "bot-gw", message: "bot-antwort" }),
			],
		});
		await h.adapter.start(callbacksFor(h.emitted));
		await waitFor(() => h.store.sets.length === 1);

		expect(h.emitted.map((m) => m.content)).toEqual(["hallo"]);
		// Der Offset springt über die eigene Nachricht hinweg (kein Re-Delivery).
		expect(h.store.sets[0].id).toBe(41);
	});

	it("Batch NUR aus eigenen Nachrichten → nichts emittiert, Offset trotzdem fort (kein Endlos-Loop)", async () => {
		const h = makeHarness({ minPollIntervalMs: 10 });
		h.ocs.receiveScript.push({
			status: 200,
			messages: [talkMessage({ id: 50, actorId: "bot-gw", message: "bot-antwort" })],
		});
		await h.adapter.start(callbacksFor(h.emitted));
		await waitFor(() => h.store.sets.length === 1);

		expect(h.emitted).toHaveLength(0); // nichts emittiert
		expect(h.store.sets[0].id).toBe(50); // Offset trotzdem fortgeschrieben

		// Der nächste Poll fragt ab Offset 50 → die eigene Antwort kommt nie
		// erneut (der kritische Anti-Loop-Fall aus Konzept §12).
		await waitFor(() => h.ocs.receiveChatCalls.length >= 2);
		expect(h.ocs.receiveChatCalls[1].query.lastKnownMessageId).toBe(50);
	});

	it("zweite Filter-Ebene: eigene Nachricht, die direkt den Adapter erreicht, wird verworfen", async () => {
		const h = makeHarness();
		await h.adapter.start(callbacksFor(h.emitted));

		// Kontrolle: publishable Nachricht wird emittiert (Callback ist aktiv).
		await h.adapter.handleTalkMessage(talkMessage({ id: 60, actorId: "alice", message: "hi" }));
		expect(h.emitted).toHaveLength(1);

		// Eigene Nachricht (derselbe OCS-User) wird verworfen — auch wenn sie
		// den zentralen Adapter-Filter direkt erreicht.
		await h.adapter.handleTalkMessage(
			talkMessage({ id: 61, actorId: "bot-gw", message: "bot" }),
		);
		expect(h.emitted).toHaveLength(1);
	});
});

// ── P2b: autoDiscoverRooms & roomRefreshIntervalMs ───────────────────────────

/** Minimaler TalkRoom für Discovery-Tests. */
function talkRoom(token: string): TalkRoom {
	return { token, type: 3 };
}

describe("P2b — mergeDiscoveredRooms (Pure Helper)", () => {
	it("stellt konfigurierte Räume zuerst und dedupliziert", () => {
		expect(mergeDiscoveredRooms(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
	});

	it("überspringt leere/ungültige Tokens (aus beiden Quellen)", () => {
		expect(
			mergeDiscoveredRooms(["a", ""], ["  ", "b", undefined as unknown as string]),
		).toEqual(["a", "b"]);
	});

	it("liefert nur konfigurierte Räume bei leerer Discovery", () => {
		expect(mergeDiscoveredRooms(["a"], [])).toEqual(["a"]);
	});
});

describe("P2b — Config-Validierung (autoDiscoverRooms / roomRefreshIntervalMs)", () => {
	it("akzeptiert gültige Discovery-Optionen", () => {
		expect(() =>
			validateNextcloudTalkConfig(
				testConfig({ autoDiscoverRooms: true, roomRefreshIntervalMs: 5_000 }),
			),
		).not.toThrow();
	});

	it("verwirft roomRefreshIntervalMs ≤ 0 / nicht-endlich", () => {
		for (const bad of [0, -5, Number.NaN]) {
			expect(
				() => validateNextcloudTalkConfig(testConfig({ roomRefreshIntervalMs: bad })),
				String(bad),
			).toThrow(/roomRefreshIntervalMs/);
		}
	});

	it("verwirft nicht-boolsches autoDiscoverRooms (defensiv, z. B. gemergte Config)", () => {
		expect(() =>
			validateNextcloudTalkConfig(
				testConfig({ autoDiscoverRooms: "yes" as unknown as boolean }),
			),
		).toThrow(/autoDiscoverRooms/);
	});
});

describe("P2b — Auto-Discovery beim Start", () => {
	it("entdeckt Räume via listRooms() und überwacht sie zusätzlich", async () => {
		const h = makeHarness({ autoDiscoverRooms: true });
		h.ocs.rooms = [talkRoom("room-a"), talkRoom("room-d")];
		await h.adapter.initialize();
		await h.adapter.start(callbacksFor(h.emitted));

		// Entdeckter Raum wird gepollt (zusätzlich zum konfigurierten room-a).
		await waitFor(() => h.ocs.receiveChatCalls.some((c) => c.room === "room-d"));
		expect(h.ocs.receiveChatCalls.some((c) => c.room === "room-a")).toBe(true);
		// listRooms: 1× initialize (Auth-Check) + 1× Discovery beim Start.
		expect(h.ocs.listRoomsCalls).toBe(2);
	});

	it("Default (autoDiscoverRooms aus): nur konfigurierte Räume, keine Discovery", async () => {
		const h = makeHarness();
		h.ocs.rooms = [talkRoom("room-a"), talkRoom("room-d")];
		await h.adapter.initialize();
		await h.adapter.start(callbacksFor(h.emitted));

		await waitFor(() => h.ocs.receiveChatCalls.some((c) => c.room === "room-a"));
		await sleep(100);
		expect(h.ocs.receiveChatCalls.some((c) => c.room === "room-d")).toBe(false);
		// Nur der Auth-Check in initialize() hat listRooms aufgerufen.
		expect(h.ocs.listRoomsCalls).toBe(1);
	});

	it("Discovery-Fehler beim Start: Fallback auf konfigurierte Räume, Adapter läuft trotzdem", async () => {
		const h = makeHarness({ autoDiscoverRooms: true });
		h.ocs.rooms = [talkRoom("room-a"), talkRoom("room-d")];
		await h.adapter.initialize();

		// Transienter Discovery-Fehler (Auth-Check war zuvor erfolgreich).
		h.ocs.listRoomsError = new TalkError("HTTP_500", "discovery boom");
		await h.adapter.start(callbacksFor(h.emitted));

		await waitFor(() => h.ocs.receiveChatCalls.some((c) => c.room === "room-a"));
		await sleep(100);
		expect(h.ocs.receiveChatCalls.some((c) => c.room === "room-d")).toBe(false);
		expect((await h.adapter.getStatus()).connected).toBe(true);
	});
});

describe("P2b — Room-Refresh (roomRefreshIntervalMs)", () => {
	it("nimmt neu erscheinende Räume nach dem Refresh-Intervall auf", async () => {
		const h = makeHarness({ autoDiscoverRooms: true, roomRefreshIntervalMs: 25 });
		h.ocs.rooms = [talkRoom("room-a")];
		await h.adapter.initialize();
		await h.adapter.start(callbacksFor(h.emitted));

		// Zwischen zwei Refresh-Zyklen taucht ein neuer Raum auf …
		h.ocs.rooms = [talkRoom("room-a"), talkRoom("room-new")];
		await waitFor(() => h.ocs.receiveChatCalls.some((c) => c.room === "room-new"));
		// … und listRooms wurde periodisch erneut aufgerufen (≥ initialize + start + 1 Refresh).
		expect(h.ocs.listRoomsCalls).toBeGreaterThanOrEqual(3);
	});

	it("bricht bei Refresh-Fehlern nicht ab (altes Raum-Set bleibt aktiv)", async () => {
		const h = makeHarness({ autoDiscoverRooms: true, roomRefreshIntervalMs: 25 });
		h.ocs.rooms = [talkRoom("room-a")];
		await h.adapter.initialize();
		await h.adapter.start(callbacksFor(h.emitted));
		await waitFor(() => h.ocs.receiveChatCalls.some((c) => c.room === "room-a"));

		// Discovery schlägt dauerhaft fehl → Warn-Logs, aber kein Crash.
		h.ocs.listRoomsError = new TalkError("HTTP_503", "unavailable");
		await sleep(100); // > 2 Refresh-Zyklen
		expect((await h.adapter.getStatus()).connected).toBe(true);
		expect(h.ocs.receiveChatCalls.some((c) => c.room === "room-a")).toBe(true);
	});

	it("stop() stoppt den Refresh-Timer (keine listRooms-Aufrufe mehr)", async () => {
		const h = makeHarness({ autoDiscoverRooms: true, roomRefreshIntervalMs: 25 });
		h.ocs.rooms = [talkRoom("room-a")];
		await h.adapter.initialize();
		await h.adapter.start(callbacksFor(h.emitted));
		await waitFor(() => h.ocs.listRoomsCalls >= 2);

		await h.adapter.stop();
		const callsAfterStop = h.ocs.listRoomsCalls;
		await sleep(100); // > 2 Refresh-Zyklen
		expect(h.ocs.listRoomsCalls).toBe(callsAfterStop);
	});

	it("Default-Intervall: roomRefreshIntervalMs unsetzt auf 60 s (Konstante exportiert)", () => {
		expect(DEFAULT_ROOM_REFRESH_INTERVAL_MS).toBe(60_000);
	});
});
