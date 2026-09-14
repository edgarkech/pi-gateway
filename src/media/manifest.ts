/**
 * Phase 3 (File-Attachments) — Attachment Manifest & base64 image inlining.
 *
 * Concept reference: concept_phase_3_media.md §7.3 (manifest), §7.1 step 4 /
 * §7.2 (images base64), §7.4 (degradation when a file disappears).
 *
 * `buildAttachmentManifest` is a pure, deterministic string builder: given a
 * validated list of `MediaAttachment`s it renders the agent-facing manifest
 * that gets prepended to the prompt (after the policy guard), so the model
 * knows where each file lives locally.
 *
 * `readAttachmentImage` is the async (`fs/promises`) companion that converts a
 * stored image into the pi-RPC `ImageContent` payload. It returns `null` —
 * never throws — when the file cannot be read, so a single bad attachment
 * degrades gracefully instead of crashing the pipeline (§7.4).
 *
 * The pipeline (core/message-pipeline.ts) coordinates the two: it decides
 * which images get inlined, marks unreadable/large ones so the manifest lines
 * carry an accurate hint, and assembles the final prompt text.
 */

import { readFile } from "node:fs/promises";

import type { ImageContent, MediaAttachment } from "./types.js";

/** Default cap for inlining an image as base64 into the RPC prompt (5 MB, §10).
 *  Forward-compatible: S6 (config) will make this overridable via
 *  `runtime.config.media.maxImageBytes`. */
export const DEFAULT_MAX_IMAGE_BYTES = 5_242_880;

/** Options accepted by `buildAttachmentManifest`. */
export interface ManifestOptions {
	/**
	 * IDs of image attachments whose file could not be read (e.g. swept between
	 * ingest and prompt, §7.4). These manifest lines get a ⚠️ warning instead of
	 * the plain "beigelegt" hint, and the attachment is excluded from `images[]`.
	 */
	unavailableImageIds?: ReadonlySet<string>;
	/**
	 * IDs of image attachments that exist but are too large to inline as base64
	 * (`sizeBytes > maxImageBytes`). Their manifest line points the agent at the
	 * local path instead of claiming the image is beigelegt.
	 */
	nonInlinedImageIds?: ReadonlySet<string>;
}

/** Human-readable byte size ("1.2 MB", "245 KB", "512 B"). */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "? B";
	if (bytes < 1024) return `${Math.round(bytes)} B`;
	const kb = bytes / 1024;
	if (kb < 1024) return `${Math.round(kb)} KB`;
	return `${round1(kb / 1024)} MB`;
}

function round1(n: number): string {
	const rounded = Math.round(n * 10) / 10;
	return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

const KIND_LABEL: Record<MediaAttachment["kind"], string> = {
	image: "image",
	document: "document",
	audio: "audio",
	video: "video",
};

/**
 * Assistant-facing hint per attachment. The hint must be truthful about whether
 * the image is actually bundled as base64 (beigelegt), only referenced by path
 * (too large to inline), or no longer readable (⚠️ gelöscht / missing).
 */
function hintForAttachment(
	att: MediaAttachment,
	unavailable: boolean,
	nonInlined: boolean,
): string {
	if (unavailable) {
		return "⚠️ Datei nicht mehr verfügbar (gelöscht).";
	}
	switch (att.kind) {
		case "image":
			if (nonInlined) {
				return "Das Bild ist zu groß zum Inlinen; der Pfad oben ist die Quelle — untersuche es bei Bedarf mit deinen Tools (read, bash).";
			}
			return "Das Bild ist dieser Nachricht zusätzlich als Bild beigelegt.";
		default:
			return "Die Datei liegt lokal; untersuche sie mit deinen Tools (read, bash).";
	}
}

/** Render a single manifest entry (exported for focused unit tests). */
export function renderAttachmentEntry(
	att: MediaAttachment,
	index: number,
	unavailable = false,
	nonInlined = false,
): string {
	const size = formatBytes(att.sizeBytes);
	const line = `[Anhang ${index}] ${att.fileName || att.id} (${KIND_LABEL[att.kind]}, ${att.mimeType}, ${size})`;
	return [
		line,
		`Lokaler Pfad: ${att.localPath}`,
		`Hinweis: ${hintForAttachment(att, unavailable, nonInlined)}`,
	].join("\n");
}

/**
 * Build the agent-facing attachment manifest (concept §7.3).
 *
 * Returns "" for an empty attachment list (or when all IDs are unavailable),
 * so callers can drop the manifest block entirely.
 */
export function buildAttachmentManifest(
	attachments: readonly MediaAttachment[],
	options: ManifestOptions = {},
): string {
	if (attachments.length === 0) return "";

	const unavailable = options.unavailableImageIds ?? new Set<string>();
	const nonInlined = options.nonInlinedImageIds ?? new Set<string>();

	const header =
		attachments.length === 1
			? "Der Nutzer hat 1 Anhang zu dieser Nachricht hinzugefügt:"
			: `Der Nutzer hat ${attachments.length} Anhänge zu dieser Nachricht hinzugefügt:`;

	const blocks = attachments.map((att, i) =>
		renderAttachmentEntry(att, i + 1, unavailable.has(att.id), nonInlined.has(att.id)),
	);

	return [header, ...blocks].join("\n\n");
}

/**
 * Read a stored image attachment and convert it to the pi-RPC `ImageContent`
 * payload (base64). Returns `null` — never throws — when the attachment is not
 * an image, larger than `maxImageBytes`, or the file cannot be read.
 */
export async function readAttachmentImage(
	att: MediaAttachment,
	maxImageBytes: number = DEFAULT_MAX_IMAGE_BYTES,
): Promise<ImageContent | null> {
	if (att.kind !== "image" || att.sizeBytes > maxImageBytes) return null;
	try {
		const buf = await readFile(att.localPath);
		return { type: "image", data: buf.toString("base64"), mimeType: att.mimeType };
	} catch {
		return null;
	}
}
