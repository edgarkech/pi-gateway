/**
 * Phase 3 (File-Attachments) — media type definitions.
 *
 * Source: concept_phase_3_media.md §5.1.
 *
 * Design rules:
 * - `MediaAttachment` is plain, serializable data (no functions/closures) so
 *   that `PlatformMessage` stays loggable/serializable.
 * - `MediaIngestRequest` carries exactly one non-serializable component
 *   (`fetch`) and deliberately keeps it in the adapter context
 *   (platform-specific download).
 */

import type { Readable } from "node:stream";

/** Kategorien, die der Agent verarbeiten soll. */
export type MediaKind = "image" | "document" | "audio" | "video";

/**
 * Validierter, lokal gespeicherter Anhang.
 * Plain-Data (serialisierbar) — bewusst OHNE Funktionen/Closures,
 * damit PlatformMessage loggbar/serialisierbar bleibt.
 */
export interface MediaAttachment {
	/** Stabile ID, z. B. "med_3fa85f6405e9c1d2" (16 hex chars) */
	id: string;
	kind: MediaKind;
	/** Verifizierter MIME-Typ (Magic-Byte-Sniffing schlägt deklarierten Typ) */
	mimeType: string;
	/** Originaldateiname, sanitized — nur Metadaten, NICHT für den Speicherpfad */
	fileName: string;
	sizeBytes: number;
	/** Absoluter lokaler Pfad im Media-Store */
	localPath: string;
	/** Provenienz — für Dedup und (theoretisches) Re-Download */
	source: {
		platform: string; // "telegram" | "discord" | …
		messageId: string; // Plattform-Meldungs-ID
		fileRef: string; // opake Plattform-Referenz (z. B. Telegram file_id)
	};
}

/**
 * Ingest-Anfrage vom Adapter an den MediaManager.
 * `fetch` ist die einzige nicht-serialisierbare Komponente und bleibt
 * bewusst im Adapter-Kontext (plattform-spezifischer Download).
 */
export interface MediaIngestRequest {
	platform: string;
	messageId: string;
	/** Opake, stabile Plattform-Referenz (Dedup-Key) */
	fileRef: string;
	/**
	 * Channel-/User-Kontext. Optional: die Registry-Spalten `channel_id` /
	 * `user_id` sind NOT NULL (Schema §6.2), daher werden fehlende Werte als
	 * leere Strings registriert — Adapter mit diesen Infos sollten sie setzen.
	 */
	channelId?: string;
	userId?: string;
	fileName?: string;
	/** Deklarierter MIME — UNVERTRAUENSWÜRDIG, wird verifiziert */
	declaredMime?: string;
	/** Deklarierte Größe — UNVERTRAUENSWÜRDIG, wird beim Streamen verifiziert */
	declaredSizeBytes?: number;
	kindHint?: MediaKind;
	/** Lazy-Download-Funktion des Adapters (Stream bevorzugt) */
	fetch: () => Promise<Readable | Buffer>;
}

/** Pi-RPC ImageContent (Format lt. pi docs/rpc.md, v0.84.2) */
export interface ImageContent {
	type: "image";
	data: string; // base64
	mimeType: string;
}

/** Strukturierte Fehler mit stabilem Code für Adapter-UX und Tests. */
export class MediaError extends Error {
	constructor(
		public readonly code:
			| "UNSUPPORTED_TYPE" // MIME/Signatur nicht erlaubt
			| "SIZE_EXCEEDED" // > maxFileSizeBytes (deklariert oder gemessen)
			| "DOWNLOAD_FAILED" // Netzwerk/HTTP-Fehler (nach Retry)
			| "VALIDATION_FAILED" // Sniffing unklar / Inkonsistenz
			| "QUOTA_EXCEEDED" // Speicher-Quota nicht erfüllbar
			| "TIMEOUT", // Download-Timeout
		message: string,
	) {
		super(message);
		this.name = "MediaError";
	}
}
