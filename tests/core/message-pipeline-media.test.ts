/**
 * Unit tests for the Phase 3 image/media pipeline integration — the exported
 * `assemblePromptWithAttachments` helper in `src/core/message-pipeline.ts`
 * (concept §7.1 step 4 / §7.3, §12 `tests/core/pipeline-media.test.ts`).
 *
 * This is the pure, deterministic core of the prompt-building logic that
 * `onMessage` delegates to; it composes the policy guard + attachment manifest
 * + user content and inlines images as base64. Real `fs/promises` reads are
 * exercised against scratch temp files.
 */

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, afterEach, it } from "vitest";

import type { MediaAttachment } from "../../src/media/types.js";
import { assemblePromptWithAttachments } from "../../src/core/message-pipeline.js";
import { buildAttachmentManifest } from "../../src/media/manifest.js";

const GUARD = "!!! SYSTEM DIRECTIVE !!!";

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function imageAttachment(overrides: Partial<MediaAttachment> = {}): MediaAttachment {
	return {
		id: "med_img0000000000000002",
		kind: "image",
		mimeType: "image/png",
		fileName: "shot.png",
		sizeBytes: 128,
		localPath: "/tmp/nonexistent/default.png",
		source: { platform: "telegram", messageId: "m1", fileRef: "f1" },
		...overrides,
	};
}

function documentAttachment(overrides: Partial<MediaAttachment> = {}): MediaAttachment {
	return {
		id: "med_doc0000000000000002",
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

function writeRealPng(): { localPath: string; content: Buffer } {
	if (!scratch) scratch = mkdtempSync(join(tmpdir(), "pi-pipeline-media-"));
	const content = Buffer.concat([
		PNG_HEAD,
		Buffer.alloc(120, 0x11),
		Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
	]);
	const localPath = join(scratch, "real.png");
	writeFileSync(localPath, content);
	return { localPath, content };
}

describe("assemblePromptWithAttachments — no attachments (backward compat)", () => {
	it("produces the legacy `guard\\n\\ncontent` string with empty images", async () => {
		const { promptText, images } = await assemblePromptWithAttachments({
			guard: GUARD,
			content: "hello",
			attachments: undefined,
		});
		expect(promptText).toBe(`${GUARD}\n\nhello`);
		expect(images).toEqual([]);
	});

	it("also mirrors the legacy behaviour for an empty attachment array", async () => {
		const { promptText } = await assemblePromptWithAttachments({
			guard: GUARD,
			content: "hello",
			attachments: [],
		});
		expect(promptText).toBe(`${GUARD}\n\nhello`);
	});
});

describe("assemblePromptWithAttachments — text + media", () => {
	it("builds manifest, inlines a readable image, keeps the user text", async () => {
		const { localPath, content } = writeRealPng();
		const img = imageAttachment({ localPath, sizeBytes: content.length });
		const doc = documentAttachment();

		const { promptText, images } = await assemblePromptWithAttachments({
			guard: GUARD,
			content: "Check this out",
			attachments: [img, doc],
		});

		// Manifest sits between guard and content, per §7.3.
		expect(promptText.startsWith(`${GUARD}\n\n`)).toBe(true);
		expect(promptText.endsWith(`\n\nCheck this out`)).toBe(true);
		expect(promptText).toContain("Der Nutzer hat 2 Anhänge zu dieser Nachricht hinzugefügt:");
		expect(promptText).toContain(
			"Das Bild ist dieser Nachricht zusätzlich als Bild beigelegt.",
		);
		expect(promptText).toContain("Die Datei liegt lokal; untersuche sie mit deinen Tools");

		expect(images).toHaveLength(1);
		expect(images[0]).toEqual({
			type: "image",
			data: content.toString("base64"),
			mimeType: "image/png",
		});
	});
});

describe("assemblePromptWithAttachments — media-only message", () => {
	it("replaces empty content with the placeholder text", async () => {
		const { localPath, content } = writeRealPng();
		const img = imageAttachment({ localPath, sizeBytes: content.length });

		const { promptText, images } = await assemblePromptWithAttachments({
			guard: GUARD,
			content: "",
			attachments: [img],
		});

		expect(promptText).toContain("(Der Nutzer hat keine Textnachricht gesendet, nur Anhänge.)");
		expect(images).toHaveLength(1);
	});
});

describe("assemblePromptWithAttachments — robustness (§7.4)", () => {
	it("annotates an unreadable image in the manifest and excludes it from images[]", async () => {
		const img = imageAttachment({ localPath: join(tmpdir(), "gone-forever.png") });
		const { promptText, images } = await assemblePromptWithAttachments({
			guard: GUARD,
			content: "hello",
			attachments: [img],
		});

		expect(images).toEqual([]);
		expect(promptText).toContain("⚠️ Datei nicht mehr verfügbar (gelöscht).");
		// And the user text still reaches the agent — nothing crashed.
		expect(promptText.endsWith(`\n\nhello`)).toBe(true);
	});

	it("does not inline oversized images but keeps a truthful path hint", async () => {
		const img = imageAttachment({
			localPath: join(tmpdir(), "huge-but-missing.png"),
			sizeBytes: 50_000_000,
		});
		const { promptText, images } = await assemblePromptWithAttachments({
			guard: GUARD,
			content: "hello",
			attachments: [img],
		});

		expect(images).toEqual([]);
		// Oversized → not inlined, and NOT flagged as missing (it's a size decision).
		expect(promptText).toContain("Das Bild ist zu groß zum Inlinen");
		expect(promptText).not.toContain("nicht mehr verfügbar");
	});

	it("recovers when one of several attachments is unreadable", async () => {
		const { localPath, content } = writeRealPng();
		const good = imageAttachment({ localPath, sizeBytes: content.length });
		const bad = imageAttachment({
			id: "med_img0000000000000003",
			fileName: "broken.png",
			localPath: join(tmpdir(), "broken.png"),
		});

		const { promptText, images } = await assemblePromptWithAttachments({
			guard: GUARD,
			content: "two images",
			attachments: [good, bad],
		});

		// The readable one is still inlined; the broken one is flagged, not fatal.
		expect(images).toHaveLength(1);
		expect(promptText).toContain("⚠️ Datei nicht mehr verfügbar (gelöscht).");
		expect(promptText).toContain("als Bild beigelegt");
	});
});

describe("assemblePromptWithAttachments — maxImageBytes override", () => {
	it("respects a caller-provided lower cap", async () => {
		const { localPath, content } = writeRealPng();
		const img = imageAttachment({ localPath, sizeBytes: content.length });

		const { images } = await assemblePromptWithAttachments({
			guard: GUARD,
			content: "tiny cap",
			attachments: [img],
			maxImageBytes: 4, // way below the PNG size → not inlined
		});

		expect(images).toEqual([]);
	});
});

describe("assemblePromptWithAttachments — output equals buildAttachmentManifest composition", () => {
	it("promptText embeds the same manifest a direct call would produce", async () => {
		const doc = documentAttachment();
		const { promptText } = await assemblePromptWithAttachments({
			guard: GUARD,
			content: "doc only",
			attachments: [doc],
		});

		const manifest = buildAttachmentManifest([doc]);
		expect(promptText).toBe(`${GUARD}\n\n${manifest}\n\ndoc only`);
	});
});
