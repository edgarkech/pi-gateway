/**
 * Phase 4 (S7) — E2E-Harness für den Nextcloud-Talk-Adapter gegen die REALE
 * Instanz (`docs/phase4-e2e.md`).
 *
 * Verantwortlichkeiten:
 * - **Env-Lade-Logik:** liest `docs/nextcloud-test.env` (dotenv-Format,
 *   manuell geparst — kein dotenv-Dependency) und priorisiert bereits gesetzte
 *   `GATEWAY_NEXTCLOUD_*`-Variablen aus der Prozessumgebung. Secrets werden
 *   nie geloggt, nur in Request-Headern verwendet.
 * - **Isolierte Adapter-Konfiguration:** baut `NextcloudTalkConfig`-Objekte
 *   (long-poll, realistischer 30s-Poll-Timeout) ohne die laufende
 *   `~/.pi/gateway/config.json` anzufassen.
 * - **Agent-Call-Mock:** `AgentCallTracker` ist der Spy auf die
 *   Callback-Antwortfunktion (`AdapterCallbacks.onMessage`) — exakt der Punkt,
 *   an dem das Gateway den pi-Agenten rufen würde. Kein echter Agent-Call.
 * - **Reale OCS/WebDAV-Helfer:** alle Funktionen hier stellen echte Requests
 *   an die Instanz (keine Fake-OCS-Näherung — Soll-Szene ist die echte
 *   Instanz): Chat-Poll, Chat-Delete, WebDAV MKCOL/PUT/DELETE, Datei-Share in
 *   den Room (`files_sharing` shareType=10, `talkMetaData` als JSON-String).
 * - **NC 33-Kompatibilität:** `E2EOcsClient` — auf der Zielinstanz (Nextcloud
 *   33.0.5, verifiziert 2026-08-25) existiert `/room` nur unter `api/v4` und
 *   `/chat` nur unter `api/v1`. Der produktive `OcsClient` nutzt v1 für beides
 *   → `listRooms()` würde mit HTTP 404/998 fehlschlagen. Die Subklasse
 *   überschreibt daher NUR `listRooms()` (Auth-Präflight des Adapters) auf
 *   v4; alle anderen Calls laufen unverändert über den echten `OcsClient`.
 *   ⚠️ Follow-up: `OcsClient` selbst sollte API-Versionen pro Endpoint
 *   verhandeln (Capability-/Version-Fallback) — siehe E2E-Report.
 *
 * Ein-Konto-Besonderheit (nur bot-user verfügbar):
 * - Szenarien 1–3 laufen mit **synthetischer Selbstfilter-Identität**
 *   (`config.userId ≠ bot-user`, injizierter `E2EOcsClient` authentifiziert als
 *   bot-user) — so werden bot-users Test-Nachrichten als externer User-Input durch
 *   die echte Pipeline behandelt (wie in Produktion ein echter User).
 * - Szenarien 4–5 laufen mit **echter Identität** (`config.userId = bot-user`) —
 *   der Anti-Loop-Selbstfilter greift exakt wie im Betrieb.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { OcsClient, TalkError } from "../../../src/adapters/nextcloud/ocs.js";
import type { OcsResponse, TalkRoom } from "../../../src/adapters/nextcloud/talk-types.js";
import type { NextcloudTalkConfig } from "../../../src/adapters/nextcloud-talk.js";
import type { PlatformMessage } from "../../../src/adapters/base.js";

// ── Credentials / Env ─────────────────────────────────────────────────────────

/** Zugangsdaten der Test-Instanz (aus `docs/nextcloud-test.env`, git-ignoriert). */
export interface E2eCreds {
	baseUrl: string;
	userId: string;
	appToken: string;
	room: string;
}

/** Pfad zur Env-Datei (relativ zu diesem File → Projekt-`docs/`). */
const ENV_FILE = new URL("../../../docs/nextcloud-test.env", import.meta.url);

/**
 * Lädt die E2E-Credentials. Priorität: `process.env.GATEWAY_NEXTCLOUD_*` >
 * `docs/nextcloud-test.env`. Liefert `null`, wenn die Datei fehlt oder ein
 * Feld leer ist → der Test-Runner skippt die Suite sauber (kein Fail ohne
 * Credentials).
 */
export function loadE2eEnv(): E2eCreds | null {
	let fileValues: Record<string, string> = {};
	try {
		const raw = readFileSync(fileURLToPath(ENV_FILE), "utf8");
		for (const line of raw.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (trimmed === "" || trimmed.startsWith("#")) continue;
			const eq = trimmed.indexOf("=");
			if (eq <= 0) continue;
			const key = trimmed.slice(0, eq).trim();
			let value = trimmed.slice(eq + 1).trim();
			// Optionale Anführungszeichen stripfen.
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1);
			}
			fileValues[key] = value;
		}
	} catch {
		return null; // Datei nicht lesbar → Suite wird gescippt
	}

	const pick = (key: string): string => process.env[key] ?? fileValues[key] ?? "";
	const creds: E2eCreds = {
		baseUrl: pick("GATEWAY_NEXTCLOUD_BASE_URL"),
		userId: pick("GATEWAY_NEXTCLOUD_USER_ID"),
		appToken: pick("GATEWAY_NEXTCLOUD_APP_TOKEN"),
		room: pick("GATEWAY_NEXTCLOUD_ROOM"),
	};
	if (!creds.baseUrl || !creds.userId || !creds.appToken || !creds.room) return null;
	return creds;
}

/** Basic-Auth-Header (log-sicher: Token wird nie in URLs/Logs geschrieben). */
export function basicAuthHeader(userId: string, appToken: string): string {
	return `Basic ${Buffer.from(`${userId}:${appToken}`).toString("base64")}`;
}

// ── OCS-Client mit NC 33-Kompatibilität (nur listRooms → v4) ─────────────────

/** Room-Objekt der v4-API (superset des S1-Typs: enthält die numerische `id`). */
export type TalkRoomV4 = TalkRoom & { id: number };

/**
 * `OcsClient` mit NC 33-Kompatibilität für `listRooms()` (siehe Header).
 * Alle übrigen Methoden (Chat-Poll/Send, WebDAV-Stream) sind unverändert die
 * echten `OcsClient`-Implementierungen.
 */
export class E2EOcsClient extends OcsClient {
	private readonly e2e: E2eCreds;

	constructor(e2e: E2eCreds) {
		super({ baseUrl: e2e.baseUrl, userId: e2e.userId, appToken: e2e.appToken });
		this.e2e = e2e;
	}

	/**
	 * `GET /ocs/v2.php/apps/spreed/api/v4/room` — dieselbe Semantik wie
	 * `OcsClient.listRooms()`, aber auf der von NC 33 unterstützten
	 * API-Version (v1 liefert dort HTTP 404 + OCS-998).
	 */
	override async listRooms(opts?: { modifiedSince?: number }): Promise<TalkRoom[]> {
		const url = new URL(
			`${this.e2e.baseUrl.replace(/\/+$/, "")}/ocs/v2.php/apps/spreed/api/v4/room`,
		);
		if (opts?.modifiedSince !== undefined) {
			url.searchParams.set("modifiedSince", String(opts.modifiedSince));
		}

		let res: Response;
		try {
			res = await fetch(url, {
				method: "GET",
				headers: {
					Authorization: basicAuthHeader(this.e2e.userId, this.e2e.appToken),
					"OCS-APIRequest": "true",
					Accept: "application/json",
				},
				signal: AbortSignal.timeout(30_000),
			});
		} catch (err) {
			throw new TalkError(
				err instanceof DOMException && err.name === "TimeoutError" ? "TIMEOUT" : "NETWORK",
				`listRooms(v4) network error: ${(err as Error).message}`,
			);
		}

		if (res.status === 401 || res.status === 403) {
			throw new TalkError("AUTH_FAILED", `Authentication failed (HTTP ${res.status})`);
		}
		if (!res.ok) {
			throw new TalkError(
				`HTTP_${res.status}` as TalkError["code"],
				`listRooms(v4) failed (HTTP ${res.status})`,
			);
		}

		let parsed: OcsResponse<TalkRoomV4[]>;
		try {
			parsed = JSON.parse(await res.text()) as OcsResponse<TalkRoomV4[]>;
		} catch {
			throw new TalkError("INVALID_RESPONSE", "Invalid JSON in room list response");
		}
		// NC 33 v4-Antworten nutzen `statuscode: 200` für OK (v1 nutzt 100).
		const sc = parsed?.ocs?.meta?.statuscode;
		if (sc !== 100 && sc !== 200) {
			throw new TalkError(
				"INVALID_RESPONSE",
				`OCS error (statuscode ${String(sc)}): ${parsed?.ocs?.meta?.message ?? ""}`,
			);
		}
		return Array.isArray(parsed.ocs.data) ? parsed.ocs.data : [];
	}
}

// ── Adapter-Config-Bau ────────────────────────────────────────────────────────

/** Synthetische Identität für Szenarien 1–3 (Ein-Konto-Instanz, siehe Header). */
export const SYNTHETIC_SELF_FILTER_USER = "e2e-external-user";

/**
 * Baut die Adapter-Config für einen E2E-Lauf. `selfFilterUserId` steuert den
 * Anti-Loop-Selbstfilter (`config.userId`): Szenarien 1–3 synthetisch (bot-user-
 * Nachrichten = externer Input), Szenarien 4–5 die echte Bot-Identität.
 */
export function buildConfig(creds: E2eCreds, selfFilterUserId: string): NextcloudTalkConfig {
	return {
		enabled: true,
		platform: "nextcloudTalk",
		baseUrl: creds.baseUrl,
		userId: selfFilterUserId,
		appToken: creds.appToken,
		rooms: [creds.room],
		// Reale Long-Poll-Parameter (phase4-e2e.md: Long-Poll ~30s);
		// minPollIntervalMs klein gehalten, damit der Test zügig bleibt.
		pollMode: "long-poll",
		longPollTimeoutSeconds: 30,
		minPollIntervalMs: 500,
	};
}

// ── Agent-Call-Mock (Spy auf die Callback-Antwortfunktion) ───────────────────

/**
 * Mock für den pi-Agent-Call: sammelt alle `PlatformMessage`s, die der Adapter
 * in die Pipeline emittiert hätte. Im Gateway würde hier `onMessage` den
 * Agenten aufrufen — im E2E bleibt der Call deterministisch und zählbar.
 */
export class AgentCallTracker {
	readonly calls: PlatformMessage[] = [];

	/** `AdapterCallbacks.onMessage`-Spy. */
	onMessage = async (message: PlatformMessage): Promise<void> => {
		this.calls.push(message);
	};

	/** Wartet bis eine Call-Condition erfüllt ist (Polling, netzwerk-tolerant). */
	async waitForCall(
		predicate: (call: PlatformMessage) => boolean,
		label: string,
		timeoutMs = 60_000,
	): Promise<PlatformMessage> {
		await waitFor(() => this.calls.some(predicate), label, timeoutMs);
		return this.calls.find(predicate)!;
	}

	/** Anzahl der Calls, deren Content einen Marker enthält. */
	countCallsWithMarker(marker: string): number {
		return this.calls.filter((c) => typeof c.content === "string" && c.content.includes(marker))
			.length;
	}
}

// ── Generic Helpers ───────────────────────────────────────────────────────────

/**
 * Wartet (Polling mit echtem Timer) bis `cond()` wahr ist. Robust gegen
 * Netzwerk-Latenz der realen Instanz — aber KEIN Fake: die Bedingung wird
 * immer gegen den echten Zustand geprüft.
 */
export async function waitFor(
	cond: () => boolean | Promise<boolean>,
	label: string,
	timeoutMs = 60_000,
	intervalMs = 500,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await cond()) return;
		if (Date.now() >= deadline) {
			throw new Error(`waitFor: Timeout nach ${timeoutMs} ms — "${label}" nicht erfüllt`);
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}

/** Frisches Temp-Dir für isolierte State-/Media-Daten (nie `~/.pi`). */
export function makeTmpDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** 1×1-Pixel-PNG (70 Bytes, gültige Magic Bytes) für das Media-Szenario. */
export const TINY_PNG: Buffer = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);

// ── Reale WebDAV-Helfer (Media-Setup/Cleanup) ────────────────────────────────

/** DAV-Basis-URL für den Bot-User. */
function davUrl(creds: E2eCreds, relPath: string): string {
	return `${creds.baseUrl.replace(/\/+$/, "")}/remote.php/dav/files/${encodeURIComponent(
		creds.userId,
	)}/${relPath.replace(/^\/+/, "")}`;
}

async function davRequest(
	creds: E2eCreds,
	method: string,
	relPath: string,
	body?: Buffer,
	contentType?: string,
): Promise<void> {
	const res = await fetch(davUrl(creds, relPath), {
		method,
		headers: {
			Authorization: basicAuthHeader(creds.userId, creds.appToken),
			...(body !== undefined && contentType ? { "Content-Type": contentType } : {}),
		},
		body: body !== undefined ? new Uint8Array(body) : undefined,
		signal: AbortSignal.timeout(30_000),
	});
	if (!res.ok) {
		throw new Error(`WebDAV ${method} ${relPath} fehlgeschlagen (HTTP ${res.status})`);
	}
	await res.body?.cancel().catch(() => undefined);
}

/** `MKCOL` — Parent-Verzeichnis anlegen (WebDAV-PUT verlangt existierende Eltern). */
export function davMkcol(creds: E2eCreds, dirPath: string): Promise<void> {
	return davRequest(creds, "MKCOL", dirPath.endsWith("/") ? dirPath : `${dirPath}/`);
}

/** `PUT` — Datei in den Bot-User-Space hochladen. */
export function davPut(
	creds: E2eCreds,
	relPath: string,
	body: Buffer,
	contentType: string,
): Promise<void> {
	return davRequest(creds, "PUT", relPath, body, contentType);
}

/** `DELETE` — Datei ODER Verzeichnis entfernen (Cleanup). */
export function davDelete(creds: E2eCreds, relPath: string): Promise<void> {
	return davRequest(creds, "DELETE", relPath.endsWith("/") ? relPath : `${relPath}/`);
}

// ── Reale OCS-Helfer (Share/Cleanup) ─────────────────────────────────────────

/**
 * Robuste OCS-Hüllen-Validierung — exakt dieselbe Regel wie der produktive
 * `OcsClient` (`src/adapters/nextcloud/ocs.ts`, `assertOcsOk`): eine Antwort
 * gilt als erfolgreich, wenn
 * - (a) `ocs.meta.statuscode === 100` — klassischer OCS-Erfolgswert, ODER
 * - (b) HTTP-2xx UND `ocs.meta.status !== "failure"` (case-insensitive).
 *
 * Hintergrund: die `files_sharing`-API der Zielinstanz (NC 33, verifiziert
 * 2026-08-25) antwortet bei erfolgreichem Share mit **HTTP 200 +
 * `statuscode: 200`, `status: "ok"`** — eine starre `statuscode === 100`-
 * Prüfung würde jeden erfolgreichen Share als Fehler werfen (S3-Media-Szenario
 * war dadurch defakt deaktiviert).
 *
 * Fehlende Hülle (`ocs.meta` fehlt) ⇒ Fehler; andernfalls Fehler mit
 * HTTP-Status + OCS-Fehlermeldung.
 */
function assertOcsOk(res: Response, parsed: OcsResponse<unknown> | null): void {
	const meta = parsed?.ocs?.meta;
	if (!meta) {
		throw new Error(
			`shareFileToRoom fehlgeschlagen (HTTP ${res.status}): fehlende OCS-Hülle (ocs.meta)`,
		);
	}
	const okByStatuscode = meta.statuscode === 100;
	const okByHttpStatus = res.ok && String(meta.status ?? "").toLowerCase() !== "failure";
	if (!okByStatuscode && !okByHttpStatus) {
		throw new Error(
			`shareFileToRoom fehlgeschlagen (HTTP ${res.status}, ` +
				`OCS statuscode ${String(meta.statuscode)}, status ${String(meta.status ?? "n/a")}): ` +
				`${meta.message ?? ""}`,
		);
	}
}

/**
 * Teilt eine Datei des Bot-Users in den Talk-Room (verifiziert gegen NC 33,
 * spreed docs/chat.md "Share a file to the chat"):
 * `POST /ocs/v2.php/apps/files_sharing/api/v1/shares` mit `shareType: 10`,
 * `shareWith` = **Room-Token** und `talkMetaData` als **JSON-String**.
 * Erzeugt eine echte Chat-Nachricht mit `file`-Rich-Object (inkl. `path`) —
 * genau der Inbound, den der Adapter per Long-Poll abholt.
 */
export async function shareFileToRoom(
	creds: E2eCreds,
	roomToken: string,
	filePath: string,
	caption?: string,
): Promise<void> {
	const body: Record<string, string | number> = {
		path: filePath.startsWith("/") ? filePath : `/${filePath}`,
		shareType: 10,
		shareWith: roomToken,
	};
	if (caption !== undefined) {
		body.talkMetaData = JSON.stringify({ caption });
	}

	const res = await fetch(
		`${creds.baseUrl.replace(/\/+$/, "")}/ocs/v2.php/apps/files_sharing/api/v1/shares`,
		{
			method: "POST",
			headers: {
				Authorization: basicAuthHeader(creds.userId, creds.appToken),
				"OCS-APIRequest": "true",
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		},
	);

	let parsed: OcsResponse<{ id?: number }> | null = null;
	try {
		parsed = JSON.parse(await res.text()) as OcsResponse<{ id?: number }>;
	} catch {
		/* unten über die OCS-Hüllen-Prüfung gemeldet (fehlende Hülle ⇒ Fehler) */
	}
	assertOcsOk(res, parsed);
}

/** Löscht alle Shares für einen Pfad (Best-Effort-Cleanup). */
export async function deleteSharesByPath(creds: E2eCreds, filePath: string): Promise<void> {
	const listUrl =
		`${creds.baseUrl.replace(/\/+$/, "")}/ocs/v2.php/apps/files_sharing/api/v1/shares` +
		`?path=${encodeURIComponent(filePath)}`;
	const listRes = await fetch(listUrl, {
		method: "GET",
		headers: {
			Authorization: basicAuthHeader(creds.userId, creds.appToken),
			"OCS-APIRequest": "true",
			Accept: "application/json",
		},
		signal: AbortSignal.timeout(30_000),
	});
	if (!listRes.ok) return;
	const parsed = (await listRes.json()) as OcsResponse<Array<{ id: number }>>;
	const shares = Array.isArray(parsed?.ocs?.data) ? parsed.ocs.data : [];
	for (const share of shares) {
		await fetch(
			`${creds.baseUrl.replace(/\/+$/, "")}/ocs/v2.php/apps/files_sharing/api/v1/shares/${share.id}`,
			{
				method: "DELETE",
				headers: {
					Authorization: basicAuthHeader(creds.userId, creds.appToken),
					"OCS-APIRequest": "true",
					Accept: "application/json",
				},
				signal: AbortSignal.timeout(30_000),
			},
		).catch(() => undefined);
	}
}

// ── Wasserstand-Helfer (Store, isoliertes GATEWAY_TALK_STATE_DIR) ────────────

/**
 * Setzt den Wasserstand eines Raums auf die aktuell letzte Nachrichten-ID
 * ("Baseline"): verhindert, dass der Poller beim Start die komplette Room-
 * History replayt (in Produktion akzeptierter Trade-off, Konzept §5.2 — im
 * E2E wollen wir deterministisch nur NEUE Nachrichten sehen).
 */
export async function baselineWatermark(
	ocs: OcsClient,
	roomToken: string,
	setLastKnownMessageId: (room: string, id: number) => void,
): Promise<number> {
	const res = await ocs.receiveChat(roomToken, { lookIntoFuture: 0, limit: 1 });
	let latest = 0;
	for (const m of res.messages) latest = Math.max(latest, Number(m.id) || 0);
	if (Number.isFinite(res.xChatLastGiven)) {
		latest = Math.max(latest, res.xChatLastGiven as number);
	}
	setLastKnownMessageId(roomToken, latest);
	return latest;
}

/**
 * Liefert alle Nachrichten mit `id > sinceId` (reales Chat-Poll, limit 100).
 *
 * ⚠️ NC-33-Semantik (verifiziert 2026-08-25): `lastKnownMessageId` mit
 * `lookIntoFuture=0` liefert eine **Historie-Seite VOR** dem Cursor (ids <
 * Cursor, neueste zuerst) — NICHT die Nachrichten danach. Neue Nachrichten
 * kommen nur per Long-Poll (`lookIntoFuture=1`). Deshalb holt der Helper die
 * letzten 100 Nachrichten OHNE Cursor und filtert clientseitig `id > sinceId`
 * (für die ruhige E2E-Instanz deterministisch ausreichend).
 */
export async function listMessagesSince(ocs: OcsClient, roomToken: string, sinceId: number) {
	const res = await ocs.receiveChat(roomToken, { lookIntoFuture: 0, limit: 100 });
	return res.messages.filter((m) => Number(m.id) > sinceId);
}

/** Existenzcheck für Env-Datei (für Diagnose-Meldungen). */
export function e2eEnvFileExists(): boolean {
	try {
		return existsSync(fileURLToPath(ENV_FILE));
	} catch {
		return false;
	}
}
