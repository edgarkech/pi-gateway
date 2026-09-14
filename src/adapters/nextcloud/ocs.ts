/**
 * Nextcloud Talk — OCS-Client (Phase 4 S1).
 *
 * Source: concept_phase_4_nextcloud.md §6.1 (Schnittstelle) + §6.3 (Security)
 * + §7 (verifizierte OCS-Endpoints). §12 (Teststrategie).
 *
 * Security-Regeln (D8):
 * - Basic-Auth wird pro Request inline aus user:appToken gebaut; das Token
 *   wird NIE geloggt und NIE in URL/Query gesetzt.
 * - `baseUrl` wird gegen `https://` validiert (oder explizit erlaubtes
 *   `http://` mit `allowInsecureHttp: true`).
 * - OCS-Antworten werden robust validiert: Erfolg bei (a) `ocs.meta.statuscode === 100`
 *   ODER (b) HTTP-2xx + `ocs.meta.status !== "failure"` — reale Instanzen
 *   (z. B. NC v4/Proxys) senden HTTP 200 mit `statuscode: 200`.
 */

import { Readable } from "node:stream";

import type { OcsResponse, TalkChatMessage, TalkRoom } from "./talk-types.js";
import { logger } from "../../logger.js";

/** Konzept §6.1 — OcsClientOptions. */
export interface OcsClientOptions {
	/** z. B. "https://nextcloud.local" (ohne trailing slash). */
	baseUrl: string;
	/** Nextcloud-Login/Username (auch Basis für den WebDAV-Pfad). */
	userId: string;
	/** App-Passwort/App-Token (NICHT das Hauptpasswort). */
	appToken: string;
	/** Nur http:// im LAN — default false. */
	allowInsecureHttp?: boolean;
	/** HTTP-Timeout auf Request-Ebene — default 60_000 ms. */
	timeoutMs?: number;
}

/**
 * Stabile Fehlercodes (Konzept §6.1, analog `MediaError` aus Phase 3):
 * `HTTP_<code>` ist dynamisch (z. B. HTTP_500), die anderen fix.
 */
export type TalkErrorCode =
	| "AUTH_FAILED"
	| "ROOM_NOT_FOUND"
	| "NETWORK"
	| "TIMEOUT"
	| "INVALID_RESPONSE"
	| `HTTP_${number}`;

/**
 * Strukturierter Fehler mit stabilem Code.
 * Nützlich für die statemachine/Circuit-Breaker-Logik im Poller (§11).
 */
export class TalkError extends Error {
	constructor(
		public readonly code: TalkErrorCode,
		message: string,
	) {
		super(message);
		this.name = "TalkError";
	}
}

/** @internal Name für einen HTTP-Fehlercode. */
function httpErrorCode(status: number): TalkErrorCode {
	return `HTTP_${status}` as TalkErrorCode;
}

/**
 * Robuste OCS-Hüllen-Validierung. Eine Antwort gilt als erfolgreich, wenn:
 * - (a) `ocs.meta.statuscode === 100` — klassischer OCS-Erfolgswert, ODER
 * - (b) HTTP-2xx UND `ocs.meta.status !== "failure"` (case-insensitive) —
 *   reale Instanzen senden HTTP 200 mit `statuscode: 200` (z. B. NC v4)
 *   oder andere nicht-100-Statuscodes bei erfolgreichem Aufruf.
 *
 * Fehlende Hülle (`ocs.meta` fehlt) ⇒ `INVALID_RESPONSE`; andernfalls
 * `HTTP_<status>` mit der OCS-Fehlermeldung.
 */
function assertOcsOk(res: Response, parsed: OcsResponse<unknown>): void {
	const meta = parsed?.ocs?.meta;
	if (!meta) {
		throw new TalkError(
			"INVALID_RESPONSE",
			`Missing OCS envelope (ocs.meta) in response (HTTP ${res.status})`,
		);
	}

	const okByStatuscode = meta.statuscode === 100;
	const okByHttpStatus = res.ok && String(meta.status ?? "").toLowerCase() !== "failure";
	if (!okByStatuscode && !okByHttpStatus) {
		throw new TalkError(
			httpErrorCode(res.status),
			`OCS error (statuscode ${String(meta.statuscode)}, status ${String(meta.status ?? "n/a")}): ${meta.message ?? ""}`,
		);
	}
}

/** @internal Ergebnis eines erfolgreichen OCS-Requests (geparst). */
interface OcsResult<T> {
	status: number;
	headers: Headers;
	data: T;
}

const OCS_BASE = "/ocs/v2.php/apps/spreed/api/v1";
// NC 33: der /room-Endpoint ist nur noch in API v4 verfuegbar (v1–v3 -> 404),
// waehrend /chat weiterhin v1 nutzt. -> Pro-Endpoint-Versionierung (S7-Folge).
const OCS_BASE_ROOM_V4 = "/ocs/v2.php/apps/spreed/api/v4";
const DAV_BASE = "/remote.php/dav/files";

export class OcsClient {
	private readonly baseUrl: string;
	private readonly userId: string;
	private readonly appToken: string;
	private readonly timeoutMs: number;

	constructor(opts: OcsClientOptions) {
		if ((opts.baseUrl ?? "").trim() === "") {
			throw new TalkError("INVALID_RESPONSE", "OcsClient: baseUrl darf nicht leer sein");
		}
		const url = new URL(opts.baseUrl);
		const protocol = url.protocol.toLowerCase();
		if (protocol !== "https:" && !(opts.allowInsecureHttp && protocol === "http:")) {
			throw new TalkError(
				"INVALID_RESPONSE",
				`OcsClient: baseUrl muss https:// sein${opts.allowInsecureHttp ? " (oder http:// via allowInsecureHttp)" : ""}, erhalten: ${url.protocol}`,
			);
		}

		this.baseUrl = opts.baseUrl.replace(/\/+$/, ""); // trailing slash entfernen
		this.userId = opts.userId;
		this.appToken = opts.appToken;
		this.timeoutMs = opts.timeoutMs ?? 60_000;
	}

	/**
	 * Kerntransport. Baut Basic-Auth + OCS-Header, stellt den Request, prüft
	 * HTTP-Status und validiert die OCS-Hülle robust (siehe `assertOcsOk`).
	 * Wirft `TalkError` bei Netzwerk/Timeout/Auth/HTTP-/Invalid-OCS.
	 */
	private async request<T>(
		method: string,
		path: string,
		opts: {
			params?: Record<string, string | number | boolean | undefined>;
			body?: unknown;
		} = {},
	): Promise<OcsResult<T>> {
		const url = this.buildUrl(path, opts.params);

		const headers: Record<string, string> = {
			Authorization: this.basicAuthHeader(),
			"OCS-APIRequest": "true",
			Accept: "application/json",
		};
		if (opts.body !== undefined) {
			headers["Content-Type"] = "application/json";
		}

		let res: Response;
		try {
			res = await fetch(url, {
				method,
				headers,
				body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (err) {
			throw this.wrapNetworkError(err);
		}

		if (res.status === 401 || res.status === 403) {
			logger.error(`[OcsClient] Auth failed (HTTP ${res.status})`, this.hostOnly());
			throw new TalkError("AUTH_FAILED", `Authentication failed (HTTP ${res.status})`);
		}

		if (!res.ok) {
			if (res.status === 404) {
				throw new TalkError("ROOM_NOT_FOUND", `Resource not found (HTTP 404)`);
			}
			throw new TalkError(httpErrorCode(res.status), `Request failed (HTTP ${res.status})`);
		}

		let body: string;
		try {
			body = await res.text();
		} catch (err) {
			throw new TalkError(
				"NETWORK",
				`Failed to read response body: ${(err as Error).message || err}`,
			);
		}

		let parsed: OcsResponse<T>;
		try {
			parsed = JSON.parse(body) as OcsResponse<T>;
		} catch {
			logger.warn(`[OcsClient] Invalid JSON from ${this.hostOnly()} (HTTP ${res.status})`);
			throw new TalkError(
				"INVALID_RESPONSE",
				`Invalid JSON in OCS response (HTTP ${res.status})`,
			);
		}

		// OCS-Hülle robust validieren (100 ODER 2xx + status ≠ failure).
		assertOcsOk(res, parsed);

		return { status: res.status, headers: res.headers, data: parsed.ocs.data };
	}

	// ── Talk (spreed) API ────────────────────────────────────────────────

	/** GET /room — alle für den Bot-User verfügbaren Räume (NC 33: nur v4). */
	async listRooms(opts?: { modifiedSince?: number }): Promise<TalkRoom[]> {
		const res = await this.request<TalkRoom[]>("GET", `${OCS_BASE_ROOM_V4}/room`, {
			params:
				opts?.modifiedSince !== undefined
					? { modifiedSince: opts.modifiedSince }
					: undefined,
		});
		return Array.isArray(res.data) ? res.data : [];
	}

	/**
	 * GET /chat/{token} — Long-Poll-Endpoint (§7).
	 * - `lookIntoFuture=1` + `timeout` hält die Verbindung offen; HTTP 304
	 *   bedeutet "nichts Neues".
	 * - Der nächste Offset steht im Response-Header `X-Chat-Last-Given`
	 *   (Fallback: max der Nachrichten-IDs).
	 */
	async receiveChat(
		room: string,
		q: {
			lookIntoFuture?: 0 | 1;
			limit?: number;
			lastKnownMessageId?: number;
			timeout?: number;
			setReadMarker?: 0 | 1;
		},
	): Promise<{
		status: number;
		messages: TalkChatMessage[];
		xChatLastGiven?: number;
	}> {
		const params: Record<string, string | number | boolean | undefined> = {
			lookIntoFuture: q.lookIntoFuture ?? 0,
			setReadMarker: q.setReadMarker ?? 0,
		};
		if (q.limit !== undefined) params.limit = q.limit;
		if (q.lastKnownMessageId !== undefined) params.lastKnownMessageId = q.lastKnownMessageId;
		if (q.timeout !== undefined) params.timeout = q.timeout;

		let res: Response;
		try {
			const url = this.buildUrl(`${OCS_BASE}/chat/${room}`, params);
			res = await fetch(url, {
				method: "GET",
				headers: {
					Authorization: this.basicAuthHeader(),
					"OCS-APIRequest": "true",
					Accept: "application/json",
				},
				signal: AbortSignal.timeout(this.timeoutMs + 15_000), // Long-Poll darf Timeout übersteigen
			});
		} catch (err) {
			throw this.wrapNetworkError(err);
		}

		// 304 = nichts Neues (Long-Poll abgelaufen ohne neue Nachricht).
		if (res.status === 304) {
			return { status: 304, messages: [] };
		}

		if (res.status === 401 || res.status === 403) {
			throw new TalkError("AUTH_FAILED", `Authentication failed (HTTP ${res.status})`);
		}
		if (res.status === 404) {
			throw new TalkError("ROOM_NOT_FOUND", `Room not found (HTTP 404)`);
		}
		if (!res.ok) {
			throw new TalkError(httpErrorCode(res.status), `Chat poll failed (HTTP ${res.status})`);
		}

		let body: string;
		try {
			body = await res.text();
		} catch (err) {
			throw new TalkError(
				"NETWORK",
				`Failed to read response body: ${(err as Error).message || err}`,
			);
		}

		let parsed: OcsResponse<TalkChatMessage[]>;
		try {
			parsed = JSON.parse(body) as OcsResponse<TalkChatMessage[]>;
		} catch {
			throw new TalkError("INVALID_RESPONSE", `Invalid JSON in chat poll response`);
		}

		// OCS-Hülle robust validieren (100 ODER 2xx + status ≠ failure).
		assertOcsOk(res, parsed);

		const messages = Array.isArray(parsed.ocs.data) ? parsed.ocs.data : [];
		const header = res.headers.get("X-Chat-Last-Given");
		const xChatLastGiven = header !== null && header !== "" ? Number(header) : undefined;
		const fallbackLast =
			messages.length > 0 ? Math.max(...messages.map((m) => Number(m.id))) : undefined;

		return {
			status: res.status,
			messages,
			xChatLastGiven: xChatLastGiven ?? fallbackLast,
		};
	}

	/** POST /chat/{token} — Nachricht senden; liefert die neue Nachricht. */
	async sendChatMessage(room: string, text: string): Promise<TalkChatMessage> {
		const res = await this.request<TalkChatMessage>("POST", `${OCS_BASE}/chat/${room}`, {
			body: { message: text },
		});
		return res.data;
	}

	/** PUT /chat/{token}/{messageId} — eigene Nachricht editieren (< 24 h). */
	async editChatMessage(room: string, messageId: number, text: string): Promise<void> {
		await this.request<TalkChatMessage>("PUT", `${OCS_BASE}/chat/${room}/${messageId}`, {
			body: { message: text },
		});
	}

	/** DELETE /chat/{token}/{messageId} — eigene Nachricht löschen. */
	async deleteChatMessage(room: string, messageId: number): Promise<void> {
		await this.request<TalkChatMessage>("DELETE", `${OCS_BASE}/chat/${room}/${messageId}`);
	}

	/**
	 * POST /chat/{token}/read — setzt den ReadMarker des Raums auf `messageId`
	 * (NC-API-Body: `{ lastReadMessageId }`). Damit wird der Ungelesen-Zähler
	 * der Nextcloud-Instanz zurückgesetzt (P2a).
	 *
	 * OCS-Erfolgs-Semantik wie bei allen Endpoints (S7/§12): Erfolg bei
	 * `statuscode === 100` ODER HTTP-2xx + `meta.status !== "failure"` —
	 * wird zentral in `assertOcsOk` geprüft (reale Instanzen senden
	 * HTTP 200 mit `statuscode: 200`).
	 *
	 * @throws {TalkError} `INVALID_RESPONSE`, wenn `messageId` keine positive
	 *         Ganzzahl ist (kein gültiger Wasserstand → Marker nicht setzen).
	 */
	async setReadMarker(room: string, messageId: number): Promise<void> {
		if (!Number.isInteger(messageId) || messageId <= 0) {
			throw new TalkError(
				"INVALID_RESPONSE",
				`setReadMarker: messageId muss eine positive Ganzzahl sein, erhalten ${String(messageId)}`,
			);
		}
		await this.request<unknown>("POST", `${OCS_BASE}/chat/${room}/read`, {
			body: { lastReadMessageId: messageId },
		});
	}

	/** @deprecated Alias für {@link OcsClient.setReadMarker} (bestehende Nutzungsmuster). */
	async markRoomRead(room: string, lastRead: number): Promise<void> {
		await this.setReadMarker(room, lastRead);
	}

	// ── WebDAV (Datei-Download für Media-Ingest, D7) ────────────────────

	/**
	 * GET remote.php/dav/files/{userId}/{userPath} — streamt die Datei als
	 * Node-Readable für den `MediaManager.ingest()`-fetch-Closure (§7.3).
	 */
	async openFileStream(userPath: string): Promise<Readable> {
		const davPath = `${DAV_BASE}/${encodeURIComponent(this.userId)}/${userPath.replace(/^\/+/, "")}`;
		let res: Response;
		try {
			res = await fetch(`${this.baseUrl}${davPath}`, {
				method: "GET",
				headers: {
					Authorization: this.basicAuthHeader(),
					"OCS-APIRequest": "true",
					Accept: "*/*",
				},
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (err) {
			throw new TalkError(
				err instanceof DOMException && err.name === "TimeoutError" ? "TIMEOUT" : "NETWORK",
				`WebDAV download failed: ${(err as Error).message || err}`,
			);
		}

		if (res.status === 401 || res.status === 403) {
			throw new TalkError("AUTH_FAILED", `WebDAV auth failed (HTTP ${res.status})`);
		}
		if (res.status === 404) {
			throw new TalkError("ROOM_NOT_FOUND", `File not found (HTTP 404)`);
		}
		if (!res.ok || !res.body) {
			throw new TalkError(
				httpErrorCode(res.status),
				`WebDAV download failed (HTTP ${res.status})`,
			);
		}

		// Node ≥ 20: web ReadableStream → Node Readable.
		return Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
	}

	// ── Private Hilfsfunktionen ─────────────────────────────────────────

	/** Basic-Auth-Header: user:appToken → base64. */
	private basicAuthHeader(): string {
		return `Basic ${Buffer.from(`${this.userId}:${this.appToken}`).toString("base64")}`;
	}

	/** URL bauen, ohne Secrets. Query-Params dürfen nie das Token enthalten. */
	private buildUrl(
		path: string,
		params?: Record<string, string | number | boolean | undefined>,
	): string {
		const url = `${this.baseUrl}${path}`;
		if (!params) return url;
		const qp = new URLSearchParams();
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined) qp.set(key, String(value));
		}
		const qs = qp.toString();
		return qs ? `${url}?${qs}` : url;
	}

	/** Netzwerk-/Timeout-Fehler normalisieren (N3). */
	private wrapNetworkError(err: unknown): TalkError {
		if (err instanceof DOMException && err.name === "TimeoutError") {
			return new TalkError("TIMEOUT", `Request timed out after ${this.timeoutMs} ms`);
		}
		return new TalkError("NETWORK", `Network error: ${(err as Error).message || err}`);
	}

	/** Log-sicherer Host (ohne Credentials, ohne Pfad/Query). */
	private hostOnly(): string {
		try {
			return new URL(this.baseUrl).host;
		} catch {
			return "<invalid-baseUrl>";
		}
	}
}
