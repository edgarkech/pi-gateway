/**
 * Phase 3 (File-Attachments) — media validation.
 *
 * Implements concept_phase_3_media.md §6.3 (security layers 2 + 3):
 * - Magic-byte sniffing of the downloaded file content. The sniffed result
 *   ALWAYS wins over the declared MIME (anti-spoofing, resolution rule 1).
 * - MIME allowlist check on the VERIFIED type (built-in defaults per §10.1;
 *   a config override is wired in later step S6).
 * - File-name sanitization for the metadata column (control chars, path
 *   separators, "..", length cap, NFC normalization).
 *
 * This module is pure: no I/O, no logging, no config access — fully
 * unit-testable without fixtures on disk.
 */

import { MediaError } from "./types.js";
import type { MediaKind } from "./types.js";

/** Result of a successful validation: verified MIME + derived kind. */
export interface ValidatedMedia {
	mimeType: string;
	kind: MediaKind;
}

// ── Built-in MIME allowlist (concept §10.1) ────────────────────────────────

const MIME_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MIME_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MIME_PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const MIME_ODT = "application/vnd.oasis.opendocument.text";

/**
 * Default allowed MIME types, used until the config override (S6) is wired in.
 * Mirrors concept §10.1 (image / document / audio / video groups).
 */
export const DEFAULT_ALLOWED_MIME_TYPES: readonly string[] = [
	// image
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
	// document
	"application/pdf",
	"application/msword",
	MIME_DOCX,
	MIME_XLSX,
	MIME_PPTX,
	"application/zip",
	// ODF: detected by the ZIP sub-detection (mimetype entry, §6.3); added to
	// the defaults because §10.1 omitted it although §6.3 produces it.
	MIME_ODT,
	"application/x-7z-compressed",
	"text/plain",
	"text/markdown",
	"text/csv",
	"text/html",
	// shell scripts / text-based scripts: content-verified as text/plain by
	// step 6 (magic-byte sniffing) after download; the declared type is also
	// admitted by the relaxed pre-check (see manager.ts step 2).
	"text/x-shellscript",
	"application/x-sh",
	"application/json",
	"application/xml",
	// audio
	"audio/mpeg",
	"audio/ogg",
	"audio/opus",
	"audio/mp4",
	"audio/wav",
	"audio/aac",
	"audio/x-m4a",
	// video
	"video/mp4",
	"video/webm",
	"video/quicktime",
	"video/x-matroska",
];

const ALLOWED_MIME_SET: ReadonlySet<string> = new Set(DEFAULT_ALLOWED_MIME_TYPES);

/** Whether a MIME type is on the built-in allowlist (case-insensitive). */
export function isMimeAllowed(mimeType: string): boolean {
	return ALLOWED_MIME_SET.has(mimeType.trim().toLowerCase());
}

/** Derive the media kind from a verified MIME (concept §6.3, resolution rule 4). */
export function deriveKind(mimeType: string): MediaKind {
	const prefix = mimeType.split("/", 1)[0];
	if (prefix === "image") return "image";
	if (prefix === "audio") return "audio";
	if (prefix === "video") return "video";
	return "document";
}

// ── Magic-byte sniffing (concept §6.3, layer 2) ────────────────────────────

/** True when `buf` at `offset` starts with the given byte sequence. */
function startsWith(buf: Buffer, bytes: readonly number[], offset = 0): boolean {
	if (offset + bytes.length > buf.length) return false;
	for (let i = 0; i < bytes.length; i++) {
		if (buf[offset + i] !== bytes[i]) return false;
	}
	return true;
}

/** Read `len` ASCII chars at `offset`; null when the buffer is too short. */
function asciiAt(buf: Buffer, offset: number, len: number): string | null {
	if (offset + len > buf.length) return null;
	return buf.subarray(offset, offset + len).toString("ascii");
}

/**
 * ZIP container sub-detection (concept §6.3): scans the local file headers
 * (`PK\x03\x04`) and inspects entry names to distinguish OOXML/ODF documents
 * from plain archives. Always makes forward progress, even on corrupted
 * size fields, so it cannot loop forever on hostile input.
 */
function sniffZipContainer(buf: Buffer): string {
	const localHeader = [0x50, 0x4b, 0x03, 0x04];
	let offset = 0;
	while (offset + 30 <= buf.length) {
		if (!startsWith(buf, localHeader, offset)) {
			offset += 1;
			continue;
		}
		const compSize = buf.readUInt32LE(offset + 18);
		const nameLen = buf.readUInt16LE(offset + 26);
		const extraLen = buf.readUInt16LE(offset + 28);
		const nameStart = offset + 30;
		if (nameStart + nameLen <= buf.length) {
			const name = buf.subarray(nameStart, nameStart + nameLen).toString("utf8");
			if (name.startsWith("word/")) return MIME_DOCX;
			if (name.startsWith("xl/")) return MIME_XLSX;
			if (name.startsWith("ppt/")) return MIME_PPTX;
			if (name === "mimetype") return MIME_ODT;
		}
		offset = nameStart + nameLen + extraLen + compSize; // > offset, always advances
	}
	return "application/zip";
}

/**
 * `ftyp` brand sub-detection (concept §6.3): the 4-byte major brand at
 * offset 8 distinguishes audio (M4A) from video (MP4/QuickTime).
 */
function sniffFtypBrand(buf: Buffer): string {
	const brand = (asciiAt(buf, 8, 4) ?? "").toLowerCase();
	if (brand === "qt  ") return "video/quicktime";
	if (brand.startsWith("m4a") || brand === "mp4a" || brand === "m4b ") return "audio/mp4";
	return "video/mp4";
}

/**
 * EBML sub-detection (concept §6.3): WebM files carry the DocType string
 * `webm` in the segment header (element 0x4282); Matroska uses `matroska`.
 */
function sniffEbmlDocType(buf: Buffer): string {
	const head = buf.subarray(0, Math.min(buf.length, 1024)).toString("latin1");
	return head.includes("webm") ? "video/webm" : "video/x-matroska";
}

/** Text heuristic (concept §6.3): no NUL byte in the first 8 KB + valid UTF-8. */
function looksLikeText(buf: Buffer): boolean {
	const head = buf.subarray(0, Math.min(buf.length, 8192));
	if (head.includes(0)) return false;
	// Buffer.toString("utf8") never throws; invalid sequences become U+FFFD.
	return !head.toString("utf8").includes("\uFFFD");
}

/**
 * Sniff the real MIME type from magic bytes (first bytes of the file).
 *
 * Returns `null` when no known signature matches and the content does not
 * look like text — the caller then falls back to the declared MIME
 * (concept §6.3, resolution rule 2).
 *
 * Note: beyond the concept table, well-known executable signatures (MZ/PE,
 * ELF) are detected explicitly so that spoofed executables fail with
 * `UNSUPPORTED_TYPE` instead of slipping through the declared-MIME fallback.
 */
export function sniffMimeType(buf: Buffer): string | null {
	if (buf.length === 0) return null;

	// image/jpeg — FF D8 FF
	if (startsWith(buf, [0xff, 0xd8, 0xff])) return "image/jpeg";
	// image/png — 89 50 4E 47 0D 0A 1A 0A
	if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
	// image/gif — 47 49 46 38 ("GIF8")
	if (startsWith(buf, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
	// application/pdf — 25 50 44 46 ("%PDF")
	if (startsWith(buf, [0x25, 0x50, 0x44, 0x46])) return "application/pdf";

	// RIFF family: form type at offset 8 distinguishes WEBP from WAVE
	if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && buf.length >= 12) {
		const form = asciiAt(buf, 8, 4);
		if (form === "WEBP") return "image/webp";
		if (form === "WAVE") return "audio/wav";
	}

	// ZIP container (PK\x03\x04) → OOXML/ODF sub-detection, else application/zip
	if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) return sniffZipContainer(buf);

	// audio/ogg — 4F 67 67 53 ("OggS")
	if (startsWith(buf, [0x4f, 0x67, 0x67, 0x53])) return "audio/ogg";

	// audio/mpeg — ID3 tag or MPEG frame sync (FF Ex)
	if (startsWith(buf, [0x49, 0x44, 0x33])) return "audio/mpeg";
	if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return "audio/mpeg";

	// video/mp4 / audio/mp4 — "ftyp" at offset 4, major brand decides
	if (buf.length >= 12 && startsWith(buf, [0x66, 0x74, 0x79, 0x70], 4)) {
		return sniffFtypBrand(buf);
	}

	// video/webm / video/x-matroska — EBML header 1A 45 DF A3
	if (startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3])) return sniffEbmlDocType(buf);

	// Safety net beyond the concept table: known executable containers.
	// Neither is on the allowlist → validateMedia() rejects with UNSUPPORTED_TYPE.
	if (buf.length >= 64 && startsWith(buf, [0x4d, 0x5a])) return "application/x-dosexec"; // MZ/PE
	if (startsWith(buf, [0x7f, 0x45, 0x4c, 0x46])) return "application/x-elf"; // ELF

	// Text heuristic → text/plain (a declared text/* type is kept by validateMedia)
	if (looksLikeText(buf)) return "text/plain";

	return null;
}

// ── Validation entry point (concept §6.3, resolution rules 1–4) ────────────

/**
 * Validate a downloaded media buffer against the allowlist.
 *
 * Resolution rules:
 * 1. A sniffed signature always wins over the declared MIME (anti-spoofing).
 *    The VERIFIED type must be on the allowlist, otherwise `UNSUPPORTED_TYPE`.
 * 2. Sniff ambiguous (no signature hit): the declared MIME is used when it is
 *    on the allowlist; otherwise `VALIDATION_FAILED`.
 * 3. Text heuristic: content that only sniffs as generic `text/plain` keeps a
 *    declared `text/*` type when one is allowed (concept §6.3, last table row).
 * 4. Kind is derived from the verified MIME (`image/*` → image, `audio/*` →
 *    audio, `video/*` → video, anything else → document).
 *
 * A mismatch between an allowed declared and an allowed sniffed type is not an
 * error — the sniffed type wins; the caller (MediaManager, S3) logs a warning.
 *
 * @throws {MediaError} with code `UNSUPPORTED_TYPE` or `VALIDATION_FAILED`.
 */
export function validateMedia(buffer: Buffer, declaredMime?: string): ValidatedMedia {
	if (!Buffer.isBuffer(buffer)) {
		throw new TypeError("validateMedia() expects a Buffer");
	}

	const declared = declaredMime?.trim().toLowerCase();
	const sniffed = sniffMimeType(buffer);

	if (sniffed !== null) {
		// Text heuristic: keep a declared text/* type for generic text content.
		if (sniffed === "text/plain" && declared?.startsWith("text/") && isMimeAllowed(declared)) {
			return { mimeType: declared, kind: deriveKind(declared) };
		}
		if (!isMimeAllowed(sniffed)) {
			throw new MediaError(
				"UNSUPPORTED_TYPE",
				`Verified file type '${sniffed}' is not allowed`,
			);
		}
		return { mimeType: sniffed, kind: deriveKind(sniffed) };
	}

	// Sniff ambiguous → fall back to the declared MIME when it is allowed.
	if (declared && isMimeAllowed(declared)) {
		return { mimeType: declared, kind: deriveKind(declared) };
	}

	throw new MediaError(
		"VALIDATION_FAILED",
		`Could not verify file type (no known signature, declared '${declared ?? "<none>"}' not allowed)`,
	);
}

// ── File-name sanitization (concept §6.3, layer 3) ─────────────────────────

/**
 * Sanitize a user-controlled file name for the metadata column.
 *
 * The storage path is generated independently (`med_<16hex><ext>`, concept
 * §6.2); this only protects logs/manifests/registry from control-char and
 * traversal injection. Rules: NFC normalization; strip C0/C1 control chars,
 * `/`, `\` and `..`; trim; cap length at 128 code points (surrogate-safe).
 */
export function sanitizeFilename(name: string): string {
	// 1. Unicode normalization (NFC) — prevents decomposed lookalike forms.
	let out = name.normalize("NFC");
	// 2. Strip control characters (C0 + C1) and path separators.
	// eslint-disable-next-line no-control-regex -- intentional: we match control chars
	out = out.replace(/[\u0000-\u001f\u007f-\u009f/\\]/g, "");
	// 3. Remove parent-directory sequences (defense in depth — after step 2 no
	//    real traversal is possible, but ".." is meaningless metadata anyway).
	out = out.replace(/\.\./g, "");
	// 4. Trim surrounding whitespace.
	out = out.trim();
	// 5. Cap length at 128 code points (Array.from keeps surrogate pairs intact;
	//    slicing cannot create new ".." sequences, so no re-run of step 3).
	const chars = Array.from(out);
	if (chars.length > 128) {
		out = chars.slice(0, 128).join("");
	}
	return out;
}
