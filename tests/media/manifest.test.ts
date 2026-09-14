/**
 * Unit tests for `src/media/manifest.ts` — attachment manifest rendering and
 * base64 image inlining (concept §12 `tests/media/manifest.test.ts`,
 * §7.3 manifest format, §7.4 degradation).
 *
 * `readAttachmentImage` exercises real `fs/promises` reads against a temp dir,
 * so each test builds its own PNG-under-test file.
 */

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, afterEach, it } from "vitest";

import type { MediaAttachment } from "../../src/media/types.js";
import {
	buildAttachmentManifest,
	formatBytes,
	readAttachmentImage,
	renderAttachmentEntry,
} from "../../src/media/manifest.js";

/** Tiny valid PNG header so `readFile` content is realistic (bytes matter, not content). */
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function imageAttachment(overrides: Partial<MediaAttachment> = {}): MediaAttachment {
	return {
		id: "med_img0000000000000001",
		kind: "image",
		mimeType: "image/png",
		fileName: "shot.png",
		sizeBytes: 128,
		localPath: "/tmp/nonexistent/shot.png",
		source: { platform: "telegram", messageId: "m1", fileRef: "f1" },
		...overrides,
	};
}

function documentAttachment(overrides: Partial<MediaAttachment> = {}): MediaAttachment {
	return {
		id: "med_doc0000000000000001",
		kind: "document",
		mimeType: "application/pdf",
		fileName: "report.pdf",
		sizeBytes: 250_000,
		localPath: "/tmp/nonexistent/report.pdf",
		source: { platform: "telegram", messageId: "m1", fileRef: "f2" },
		...overrides,
	};
}

let scratch = "";
afterEach(() => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
	scratch = "";
});

/** Create a tiny real PNG file in a scratch dir and return its absolute path. */
function writeRealPng(): { localPath: string; content: Buffer } {
	if (!scratch) scratch = mkdtempSync(join(tmpdir(), "pi-manifest-"));
	const content = Buffer.concat([
		PNG_HEAD,
		Buffer.alloc(120, 0x11),
		Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
	]);
	const localPath = join(scratch, "real.png");
	writeFileSync(localPath, content);
	return { localPath, content };
}

// ── buildAttachmentManifest ────────────────────────────────────────────────

describe("buildAttachmentManifest", () => {
	it("returns '' for an empty attachment list", () => {
		expect(buildAttachmentManifest([])).toBe("");
	});

	it("renders singular header for one attachment", () => {
		const text = buildAttachmentManifest([imageAttachment()]);
		expect(text).toContain("Der Nutzer hat 1 Anhang zu dieser Nachricht hinzugefügt:");
	});

	it("renders plural header and per-attachment blocks", () => {
		const text = buildAttachmentManifest([imageAttachment(), documentAttachment()]);
		expect(text).toContain("Der Nutzer hat 2 Anhänge zu dieser Nachricht hinzugefügt:");
		expect(text).toContain("[Anhang 1] shot.png (image, image/png, 128 B)");
		expect(text).toContain("Lokaler Pfad: /tmp/nonexistent/shot.png");
		expect(text).toContain("Das Bild ist dieser Nachricht zusätzlich als Bild beigelegt.");
		expect(text).toContain("[Anhang 2] report.pdf (document, application/pdf, 244 KB)");
		expect(text).toContain(
			"Die Datei liegt lokal; untersuche sie mit deinen Tools (read, bash).",
		);
	});

	it("annotates unavailable images with a warning instead of the beigelegt hint", () => {
		const text = buildAttachmentManifest([imageAttachment()], {
			unavailableImageIds: new Set(["med_img0000000000000001"]),
		});
		expect(text).toContain("⚠️ Datei nicht mehr verfügbar (gelöscht).");
		expect(text).not.toContain("als Bild beigelegt");
	});

	it("points non-inlined (too large) images at the local path", () => {
		const text = buildAttachmentManifest([imageAttachment()], {
			nonInlinedImageIds: new Set(["med_img0000000000000001"]),
		});
		expect(text).toContain("Das Bild ist zu groß zum Inlinen");
		expect(text).toContain("read, bash");
	});
});

describe("renderAttachmentEntry / formatBytes", () => {
	it("formats byte sizes human-readably", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(250_000)).toBe("244 KB");
		expect(formatBytes(1_258_291)).toBe("1.2 MB");
	});

	it("falls back to the id when no filename is set", () => {
		const entry = renderAttachmentEntry(imageAttachment({ fileName: "" }), 1);
		expect(entry).toContain("[Anhang 1] med_img0000000000000001 (image,");
	});
});

// ── readAttachmentImage ────────────────────────────────────────────────────

describe("readAttachmentImage", () => {
	it("returns base64 ImageContent for a readable PNG under the size cap", async () => {
		const { localPath, content } = writeRealPng();
		const att = imageAttachment({ localPath, sizeBytes: content.length });

		const result = await readAttachmentImage(att);
		expect(result).toEqual({
			type: "image",
			data: content.toString("base64"),
			mimeType: "image/png",
		});
	});

	it("returns null for a non-image attachment", async () => {
		expect(await readAttachmentImage(documentAttachment())).toBeNull();
	});

	it("returns null for an image above the size cap (no read attempted)", async () => {
		const { localPath } = writeRealPng();
		const att = imageAttachment({ localPath, sizeBytes: 100_000_000 });
		expect(await readAttachmentImage(att)).toBeNull();
	});

	it("returns null instead of throwing when the file is missing", async () => {
		const att = imageAttachment({ localPath: join(tmpdir(), "definitely-missing-file.png") });
		await expect(readAttachmentImage(att)).resolves.toBeNull();
	});
});
