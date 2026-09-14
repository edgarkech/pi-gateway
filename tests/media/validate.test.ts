/**
 * Unit tests for `src/media/validate.ts` — magic-byte sniffing, MIME
 * resolution rules (declared vs sniffed) and file-name sanitization.
 *
 * All fixtures are in-memory Buffers with the relevant magic bytes; no files
 * on disk and no network involved (concept §12: "Puffer-Fixtures, keine
 * Netzwerk").
 */

import { describe, expect, it } from "vitest";
import { MediaError } from "../../src/media/types.js";
import {
	DEFAULT_ALLOWED_MIME_TYPES,
	deriveKind,
	isMimeAllowed,
	sanitizeFilename,
	sniffMimeType,
	validateMedia,
} from "../../src/media/validate.js";

// ── Buffer fixtures (magic bytes + padding) ────────────────────────────────

/** Minimal JPEG: SOI + APP0 marker start. */
function jpegFixture(): Buffer {
	return Buffer.concat([
		Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
		Buffer.alloc(32, 0xab),
	]);
}

/** Minimal PNG: 8-byte signature + IHDR-like padding. */
function pngFixture(): Buffer {
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		Buffer.alloc(24, 0x11),
	]);
}

/** GIF89a header + padding. */
function gifFixture(): Buffer {
	return Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(16, 0x22)]);
}

/** RIFF container with WEBP form type at offset 8. */
function webpFixture(): Buffer {
	return Buffer.concat([
		Buffer.from("RIFF"),
		Buffer.from([0x24, 0x00, 0x00, 0x00]),
		Buffer.from("WEBP"),
		Buffer.alloc(16, 0x33),
	]);
}

/** PDF header + minimal body. */
function pdfFixture(): Buffer {
	return Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n%%EOF\n");
}

/** MP3 with ID3v2 tag header. */
function mp3Id3Fixture(): Buffer {
	return Buffer.concat([
		Buffer.from("ID3"),
		Buffer.from([0x04, 0x00, 0x00]),
		Buffer.alloc(16, 0x44),
	]);
}

/** MP3 with bare MPEG frame sync (FF Ex). */
function mp3FrameSyncFixture(): Buffer {
	return Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(16, 0x55)]);
}

/** OggS capture pattern + version byte. */
function oggFixture(): Buffer {
	return Buffer.concat([Buffer.from("OggS"), Buffer.from([0x02, 0x00]), Buffer.alloc(16, 0x66)]);
}

/** ISO-BMFF `ftyp` box with a configurable major brand (offset 8). */
function ftypFixture(brand: string): Buffer {
	return Buffer.concat([
		Buffer.from([0x00, 0x00, 0x00, 0x18]),
		Buffer.from("ftyp"),
		Buffer.from(brand),
		Buffer.alloc(16, 0x77),
	]);
}

/** EBML container with a DocType string (webm / matroska). */
function ebmlFixture(docType: string): Buffer {
	return Buffer.concat([
		Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
		Buffer.alloc(8, 0x01),
		Buffer.from(docType),
		Buffer.alloc(16, 0x88),
	]);
}

/** RIFF container with WAVE form type at offset 8. */
function wavFixture(): Buffer {
	return Buffer.concat([
		Buffer.from("RIFF"),
		Buffer.from([0x24, 0x00, 0x00, 0x00]),
		Buffer.from("WAVE"),
		Buffer.alloc(16, 0x99),
	]);
}

/** MZ/PE executable header (NOT on the allowlist). */
function mzExecutableFixture(): Buffer {
	return Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(64, 0xaa)]);
}

/**
 * Unknown binary: no known signature, not text (lone UTF-8 continuation
 * bytes → invalid, no NUL). Deliberately avoids FF E0–FF so it does not
 * match the loose MPEG frame-sync pattern (concept §6.3: "FF Ex/Fx").
 */
function unknownBinaryFixture(): Buffer {
	return Buffer.from([0x01, 0x82, 0x83, 0x84, 0x85, 0x86]);
}

/** Minimal ZIP with one local file header per entry name (empty data). */
function zipFixture(entries: string[]): Buffer {
	const parts: Buffer[] = [];
	for (const name of entries) {
		const nameBuf = Buffer.from(name, "utf8");
		const header = Buffer.alloc(30);
		header.writeUInt32LE(0x04034b50, 0); // PK\x03\x04
		header.writeUInt16LE(20, 4); // version needed to extract
		header.writeUInt16LE(nameBuf.length, 26); // file name length
		parts.push(header, nameBuf);
	}
	return Buffer.concat(parts);
}

/** Assert that `fn` throws a MediaError with the given stable code. */
function expectMediaError(fn: () => unknown, code: string): void {
	let thrown: unknown;
	try {
		fn();
	} catch (err) {
		thrown = err;
	}
	expect(thrown).toBeInstanceOf(MediaError);
	expect((thrown as MediaError).code).toBe(code);
	expect((thrown as MediaError).name).toBe("MediaError");
}

// ── Magic-byte sniffing (concept §6.3) ─────────────────────────────────────

describe("validateMedia — magic-byte sniffing", () => {
	it("detects image/jpeg from the FFD8FF signature", () => {
		expect(validateMedia(jpegFixture())).toEqual({ mimeType: "image/jpeg", kind: "image" });
	});

	it("detects image/png from the 8-byte signature", () => {
		expect(validateMedia(pngFixture())).toEqual({ mimeType: "image/png", kind: "image" });
	});

	it("detects image/gif from the GIF8 signature", () => {
		expect(validateMedia(gifFixture())).toEqual({ mimeType: "image/gif", kind: "image" });
	});

	it("detects image/webp (RIFF container + WEBP form)", () => {
		expect(validateMedia(webpFixture())).toEqual({ mimeType: "image/webp", kind: "image" });
	});

	it("detects application/pdf from the %PDF signature", () => {
		expect(validateMedia(pdfFixture())).toEqual({
			mimeType: "application/pdf",
			kind: "document",
		});
	});

	it("detects audio/mpeg via ID3 tag", () => {
		expect(validateMedia(mp3Id3Fixture())).toEqual({ mimeType: "audio/mpeg", kind: "audio" });
	});

	it("detects audio/mpeg via MPEG frame sync (FF Ex)", () => {
		expect(validateMedia(mp3FrameSyncFixture())).toEqual({
			mimeType: "audio/mpeg",
			kind: "audio",
		});
	});

	it("detects audio/ogg from the OggS capture pattern", () => {
		expect(validateMedia(oggFixture())).toEqual({ mimeType: "audio/ogg", kind: "audio" });
	});

	it("detects video/mp4 from the ftyp box (isom brand)", () => {
		expect(validateMedia(ftypFixture("isom"))).toEqual({
			mimeType: "video/mp4",
			kind: "video",
		});
	});

	it("distinguishes audio/mp4 from video/mp4 by ftyp brand (M4A)", () => {
		expect(validateMedia(ftypFixture("M4A "))).toEqual({
			mimeType: "audio/mp4",
			kind: "audio",
		});
	});

	it("detects video/webm from the EBML header + DocType", () => {
		expect(validateMedia(ebmlFixture("webm"))).toEqual({
			mimeType: "video/webm",
			kind: "video",
		});
	});

	it("distinguishes video/x-matroska by DocType", () => {
		expect(validateMedia(ebmlFixture("matroska"))).toEqual({
			mimeType: "video/x-matroska",
			kind: "video",
		});
	});

	it("detects audio/wav (RIFF container + WAVE form)", () => {
		expect(validateMedia(wavFixture())).toEqual({ mimeType: "audio/wav", kind: "audio" });
	});

	it("distinguishes OOXML/ODF documents inside ZIP containers", () => {
		const docx = validateMedia(zipFixture(["[Content_Types].xml", "word/document.xml"]));
		expect(docx.mimeType).toBe(
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		);
		expect(docx.kind).toBe("document");

		const xlsx = validateMedia(zipFixture(["[Content_Types].xml", "xl/workbook.xml"]));
		expect(xlsx.mimeType).toBe(
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		);

		const pptx = validateMedia(zipFixture(["[Content_Types].xml", "ppt/presentation.xml"]));
		expect(pptx.mimeType).toBe(
			"application/vnd.openxmlformats-officedocument.presentationml.presentation",
		);

		const odt = validateMedia(zipFixture(["mimetype", "content.xml"]));
		expect(odt.mimeType).toBe("application/vnd.oasis.opendocument.text");
	});

	it("falls back to application/zip for plain archives", () => {
		expect(validateMedia(zipFixture(["readme.txt", "data.bin"]))).toEqual({
			mimeType: "application/zip",
			kind: "document",
		});
	});

	it("classifies plain text as text/plain (no NUL, valid UTF-8)", () => {
		expect(validateMedia(Buffer.from("hello world\n"))).toEqual({
			mimeType: "text/plain",
			kind: "document",
		});
	});

	it("returns null from sniffMimeType for unknown binary content", () => {
		expect(sniffMimeType(unknownBinaryFixture())).toBeNull();
	});
});

// ── Resolution rules: declared vs sniffed (concept §6.3) ───────────────────

describe("validateMedia — resolution rules", () => {
	it("sniffed type wins over a conflicting declared MIME (anti-spoofing)", () => {
		// A JPEG masquerading as a PDF must come out as image/jpeg.
		expect(validateMedia(jpegFixture(), "application/pdf")).toEqual({
			mimeType: "image/jpeg",
			kind: "image",
		});
	});

	it("keeps a declared text/* type when content only sniffs as text/plain", () => {
		expect(validateMedia(Buffer.from("# Title\nsome markdown\n"), "text/markdown")).toEqual({
			mimeType: "text/markdown",
			kind: "document",
		});
	});

	it("rejects a non-text declared MIME for plain text content (sniff wins)", () => {
		expect(validateMedia(Buffer.from("just some text\n"), "application/pdf")).toEqual({
			mimeType: "text/plain",
			kind: "document",
		});
	});

	it("uses the declared MIME when sniffing is ambiguous and it is allowed", () => {
		expect(validateMedia(unknownBinaryFixture(), "application/zip")).toEqual({
			mimeType: "application/zip",
			kind: "document",
		});
	});

	it("normalizes a case-variant declared MIME", () => {
		expect(validateMedia(unknownBinaryFixture(), "TEXT/CSV")).toEqual({
			mimeType: "text/csv",
			kind: "document",
		});
	});

	it("throws VALIDATION_FAILED for unknown binary without an allowed declared type", () => {
		expectMediaError(() => validateMedia(unknownBinaryFixture()), "VALIDATION_FAILED");
		expectMediaError(
			() => validateMedia(unknownBinaryFixture(), "application/x-msdownload"),
			"VALIDATION_FAILED",
		);
	});

	it("throws UNSUPPORTED_TYPE when the verified signature is not allowed (executables)", () => {
		expectMediaError(() => validateMedia(mzExecutableFixture()), "UNSUPPORTED_TYPE");
		// Even a spoofed declared MIME cannot rescue an executable.
		expectMediaError(
			() => validateMedia(mzExecutableFixture(), "application/pdf"),
			"UNSUPPORTED_TYPE",
		);
	});

	it("throws a TypeError for non-Buffer input", () => {
		expect(() => validateMedia("not a buffer" as unknown as Buffer)).toThrowError(TypeError);
	});
});

// ── Helpers: deriveKind / isMimeAllowed ────────────────────────────────────

describe("deriveKind / isMimeAllowed", () => {
	it("maps MIME prefixes to kinds (image/audio/video, else document)", () => {
		expect(deriveKind("image/png")).toBe("image");
		expect(deriveKind("audio/ogg")).toBe("audio");
		expect(deriveKind("video/webm")).toBe("video");
		expect(deriveKind("application/pdf")).toBe("document");
		expect(deriveKind("text/plain")).toBe("document");
	});

	it("allowlist contains the built-in defaults and rejects foreign types", () => {
		for (const mime of DEFAULT_ALLOWED_MIME_TYPES) {
			expect(isMimeAllowed(mime)).toBe(true);
		}
		expect(isMimeAllowed("application/x-msdownload")).toBe(false);
		expect(isMimeAllowed("IMAGE/PNG")).toBe(true); // case-insensitive
	});

	it("allows shell-script MIME types and verifies the content", () => {
		expect(isMimeAllowed("text/x-shellscript")).toBe(true);
		expect(isMimeAllowed("application/x-sh")).toBe(true);
		// declared text/* type is kept (resolution rule 3) once allowlisted
		const v = validateMedia(
			Buffer.from("#!/bin/bash\necho hi\n", "utf8"),
			"text/x-shellscript",
		);
		expect(v.mimeType).toBe("text/x-shellscript");
		expect(v.kind).toBe("document");
	});
});

// ── File-name sanitization (concept §6.3, layer 3) ─────────────────────────

describe("sanitizeFilename", () => {
	it("keeps a plain file name unchanged", () => {
		expect(sanitizeFilename("report.pdf")).toBe("report.pdf");
	});

	it("removes path traversal sequences and separators", () => {
		expect(sanitizeFilename("../../etc/passwd")).toBe("etcpasswd");
		// ".." is stripped, ".exe" (single dot) survives.
		expect(sanitizeFilename("..\\..\\windows\\system32\\cmd.exe")).toBe(
			"windowssystem32cmd.exe",
		);
	});

	it("strips C0/C1 control characters", () => {
		expect(sanitizeFilename("file\u0000\u001b[31m.txt")).toBe("file[31m.txt");
	});

	it("applies NFC normalization (decomposed → composed)", () => {
		expect(sanitizeFilename("cafe\u0301.txt")).toBe("caf\u00e9.txt");
	});

	it("caps the length at 128 characters", () => {
		expect(sanitizeFilename(`a${"b".repeat(200)}.pdf`).length).toBe(128);
	});

	it("does not split surrogate pairs when truncating", () => {
		const name = "📷".repeat(130) + ".png"; // 134 code points
		const out = sanitizeFilename(name);
		expect(Array.from(out).length).toBe(128);
		expect(out.endsWith("📷")).toBe(true);
	});

	it("returns an empty string for names made only of stripped characters", () => {
		expect(sanitizeFilename("///\u0000..")).toBe("");
	});
});
