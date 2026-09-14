/**
 * Phase 3 (S5) — Telegram adapter media integration tests.
 *
 * Covers (concept §12 `tests/adapters/telegram-media.test.ts`):
 *   1. `extractTelegramMedia` — photo→highest-res, document/audio/video/
 *      animation/voice → single candidate, empty message → [].
 *   2. `mediaErrorToUserMessage` — MediaError codes map to German chat texts
 *      (§8 E1–E8).
 *   3. `handleUpdate` ingest flow — media-only (empty content + attachments),
 *      text+media, E9 all-failed + no text → no emit, partial-failure degrade.
 *   4. `downloadFile` — getFile + file download via stubbed `fetch`.
 *
 * The MediaManager is stubbed via `runtime.media` (a mock manager), so the
 * adapter never touches the real SQLite store or the network for ingest tests.
 * `downloadFile` is exercised in isolation with a short-circuited `fetch`.
 */

import { Readable } from "node:stream";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { TelegramAdapter } from "../../src/adapters/telegram.js";
import { extractTelegramMedia, mediaErrorToUserMessage } from "../../src/adapters/telegram.js";
import type { PlatformMessage } from "../../src/adapters/base.js";
import { MediaError, type MediaAttachment, type MediaManager } from "../../src/media/types.js";
import { runtime } from "../../src/state.js";

// ── Shared fakes ──────────────────────────────────────────────────────────

/** A fixed, realistic MediaAttachment used as the ingest result. */
function attachment(overrides: Partial<MediaAttachment> = {}): MediaAttachment {
	return {
		id: "med_3fa85f6405e9c1d2",
		kind: "image",
		mimeType: "image/png",
		fileName: "shot.png",
		sizeBytes: 512,
		localPath: "/scratch/telegram/2026-08/med_3fa85f6405e9c1d2.png",
		source: { platform: "telegram", messageId: "501", fileRef: "file_abc123" },
		...overrides,
	};
}

/**
 * A stub `MediaManager` whose `ingest` behaviour the test controls. Satisfies
 * the full `MediaManager` interface so the adapter compiles and the type
 * contract is verified.
 */
function mockManager(
	ingestImpl: (req: {
		fileRef: string;
		kindHint: string;
		declaredMime?: string;
		declaredSizeBytes?: number;
		fileName?: string;
		fetch: () => unknown;
	}) => Promise<MediaAttachment>,
): MediaManager {
	return {
		ingest: ingestImpl as MediaManager["ingest"],
		discard: vi.fn(async () => {}),
		sweep: vi.fn(async () => ({ deletedFiles: 0, freedBytes: 0 })),
		stats: vi.fn(async () => ({ fileCount: 0, totalBytes: 0, oldestAt: null })),
	};
}

/** Attach an onMessage spy to the adapter without starting network loops. */
function withSpy(adapter: { callbacks: unknown }): ReturnType<typeof vi.fn> {
	const onMessage = vi.fn(async () => {});
	(adapter as { callbacks: unknown }).callbacks = { onMessage };
	return onMessage;
}

/** Base Docker-compatible telegram update builder. */
function messageUpdate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		update_id: 1,
		message: {
			message_id: 501,
			from: { id: 300, username: "bob" },
			chat: { id: 300, type: "private" },
			date: 1_700_000_000,
			...overrides,
		},
	};
}

beforeEach(() => {
	runtime.media = null;
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	runtime.media = null;
});

// ── 1. extractTelegramMedia ───────────────────────────────────────────────

describe("extractTelegramMedia — media field extraction (§9.1/§9.2)", () => {
	it("chooses the highest-resolution photo size from photo[]", () => {
		const candidates = extractTelegramMedia(
			messageUpdate({
				photo: [
					{ file_id: "small", width: 200, height: 100, file_size: 4000 },
					{ file_id: "big", width: 800, height: 400, file_size: 20_000 },
					{ file_id: "huge", width: 1600, height: 800, file_size: 90_000 },
				],
			}).message as never,
		);

		expect(candidates).toHaveLength(1);
		expect(candidates[0].fileId).toBe("huge");
		expect(candidates[0].kind).toBe("image");
		expect(candidates[0].size).toBe(90_000);
	});

	it("uses file_size as a tie-breaker when two photos share the same area", () => {
		const candidates = extractTelegramMedia(
			messageUpdate({
				photo: [
					{ file_id: "a", width: 100, height: 100, file_size: 1000 },
					{ file_id: "b", width: 200, height: 50, file_size: 5000 }, // same area (10000)
				],
			}).message as never,
		);

		expect(candidates).toHaveLength(1);
		expect(candidates[0].fileId).toBe("b");
	});

	it("extracts document metadata", () => {
		const candidates = extractTelegramMedia(
			messageUpdate({
				document: {
					file_id: "doc_1",
					file_name: "report.pdf",
					mime_type: "application/pdf",
					file_size: 250_000,
				},
			}).message as never,
		);

		expect(candidates).toHaveLength(1);
		expect(candidates[0]).toMatchObject({
			fileId: "doc_1",
			fileName: "report.pdf",
			mime: "application/pdf",
			size: 250_000,
			kind: "document",
		});
	});

	it("maps audio and voice to kind=audio", () => {
		const audio = extractTelegramMedia(
			messageUpdate({
				audio: { file_id: "aud_1", mime_type: "audio/mpeg" },
			}).message as never,
		);
		expect(audio).toHaveLength(1);
		expect(audio[0].kind).toBe("audio");

		const voice = extractTelegramMedia(
			messageUpdate({
				voice: { file_id: "voi_1", mime_type: "audio/ogg" },
			}).message as never,
		);
		expect(voice).toHaveLength(1);
		expect(voice[0].kind).toBe("audio");
	});

	it("maps video to kind=video and animation to kind=image", () => {
		const video = extractTelegramMedia(
			messageUpdate({ video: { file_id: "vid_1" } }).message as never,
		);
		expect(video[0].kind).toBe("video");

		const animation = extractTelegramMedia(
			messageUpdate({ animation: { file_id: "anim_1" } }).message as never,
		);
		expect(animation[0].kind).toBe("image");
	});

	it("returns an empty array for a message without media fields", () => {
		const textOnly = extractTelegramMedia(
			messageUpdate({ text: "just text" }).message as never,
		);
		expect(textOnly).toEqual([]);
	});
});

// ── 2. mediaErrorToUserMessage (§8) ───────────────────────────────────────

describe("mediaErrorToUserMessage — German chat feedback (§8 E1–E8)", () => {
	const cand = {
		fileId: "f",
		fileName: "bad.exe",
		mime: "application/octet-stream",
		kind: "document" as const,
	};

	it("maps SIZE_EXCEEDED", () => {
		expect(mediaErrorToUserMessage(new MediaError("SIZE_EXCEEDED", "x"), cand)).toContain(
			"zu groß",
		);
	});
	it("maps UNSUPPORTED_TYPE", () => {
		expect(mediaErrorToUserMessage(new MediaError("UNSUPPORTED_TYPE", "x"), cand)).toContain(
			"nicht unterstützt",
		);
	});
	it("maps DOWNLOAD_FAILED", () => {
		expect(mediaErrorToUserMessage(new MediaError("DOWNLOAD_FAILED", "x"), cand)).toContain(
			"Download",
		);
	});
	it("maps QUOTA_EXCEEDED", () => {
		expect(mediaErrorToUserMessage(new MediaError("QUOTA_EXCEEDED", "x"), cand)).toContain(
			"Speicher voll",
		);
	});
	it("falls back generically for non-MediaError values", () => {
		expect(mediaErrorToUserMessage(new Error("boom"), cand)).toContain("verarbeitet");
	});
});

// ── 3. handleUpdate ingest flow (§9.2) ────────────────────────────────────

describe("handleUpdate — media ingest flow (§9.2)", () => {
	function newAdapter(): TelegramAdapter {
		return new TelegramAdapter({ enabled: true, platform: "telegram", token: "bot:tok" });
	}

	it("emits a media-only message with empty content and one attachment", async () => {
		const adapter = newAdapter();
		const onMessage = withSpy(adapter);
		const ingest = vi.fn(async () => attachment());
		runtime.media = mockManager(ingest);

		await adapter.handleWebhookUpdate(
			messageUpdate({
				photo: [{ file_id: "file_abc123", width: 640, height: 480 }],
			}) as never,
		);

		// The adapter must hand the manager the platform + fileRef + fetch closure.
		expect(ingest).toHaveBeenCalledTimes(1);
		const req = ingest.mock.calls[0][0];
		expect(req.platform).toBe("telegram");
		expect(req.messageId).toBe("501");
		expect(req.fileRef).toBe("file_abc123");
		expect(req.kindHint).toBe("image");
		expect(req.channelId).toBe("300");
		expect(req.userId).toBe("300");
		expect(typeof req.fetch).toBe("function");

		expect(onMessage).toHaveBeenCalledTimes(1);
		const msg = onMessage.mock.calls[0][0] as PlatformMessage;
		expect(msg.content).toBe(""); // media-only → empty content
		expect(msg.attachments).toHaveLength(1);
		expect(msg.attachments![0].id).toBe("med_3fa85f6405e9c1d2");
	});

	it("keeps the caption/text and appends attachments for text+media", async () => {
		const adapter = newAdapter();
		const onMessage = withSpy(adapter);
		runtime.media = mockManager(vi.fn(async () => attachment()));

		await adapter.handleWebhookUpdate(
			messageUpdate({
				caption: "check this out",
				document: { file_id: "doc_1", file_name: "report.pdf" },
			}) as never,
		);

		const msg = onMessage.mock.calls[0][0] as PlatformMessage;
		expect(msg.content).toBe("check this out");
		expect(msg.attachments).toHaveLength(1);
	});

	it("limits ingestion to maxAttachmentsPerMessage", async () => {
		const adapter = newAdapter();
		const onMessage = withSpy(adapter);
		const ingest = vi.fn(async () => attachment());
		runtime.media = mockManager(ingest);

		// 6 documents → only 4 (default) ingested.
		await adapter.handleWebhookUpdate(
			messageUpdate({
				caption: "many files",
				document: { file_id: "d1" },
				audio: { file_id: "a1" },
				video: { file_id: "v1" },
				animation: { file_id: "g1" },
				voice: { file_id: "vc1" },
				photo: [{ file_id: "p1", width: 100, height: 100 }],
			}) as never,
		);

		expect(ingest).toHaveBeenCalledTimes(4);
		expect(onMessage).toHaveBeenCalledTimes(1);
	});

	it("E9 — all media fails + no text → reports errors but does not emit", async () => {
		const adapter = newAdapter();
		const onMessage = withSpy(adapter);
		const sendSpy = vi.spyOn(adapter, "sendMessage").mockResolvedValue("0");
		runtime.media = mockManager(
			vi.fn(async () => {
				throw new MediaError("DOWNLOAD_FAILED", "nope");
			}),
		);

		await adapter.handleWebhookUpdate(
			messageUpdate({ document: { file_id: "f", file_name: "x.pdf" } }) as never,
		);

		expect(onMessage).not.toHaveBeenCalled();
		// The per-attachment failure is surfaced as a user text message (§8).
		expect(sendSpy).toHaveBeenCalledTimes(1);
		expect(sendSpy.mock.calls[0][1]).toContain("Download");
	});

	it("E10 — partial failure emits the surviving attachment and reports the error", async () => {
		const adapter = newAdapter();
		const onMessage = withSpy(adapter);
		const sendSpy = vi.spyOn(adapter, "sendMessage").mockResolvedValue("0");
		const ok = attachment();
		let call = 0;
		runtime.media = mockManager(
			vi.fn(async () => {
				call += 1;
				if (call === 1) throw new MediaError("UNSUPPORTED_TYPE", "bad");
				return ok;
			}),
		);

		await adapter.handleWebhookUpdate(
			messageUpdate({
				caption: "one good one bad",
				document: { file_id: "bad" }, // fails
				audio: { file_id: "good" }, // succeeds
			}) as never,
		);

		expect(sendSpy).toHaveBeenCalledTimes(1);
		expect(sendSpy.mock.calls[0][1]).toContain("nicht unterstützt");

		expect(onMessage).toHaveBeenCalledTimes(1);
		const msg = onMessage.mock.calls[0][0] as PlatformMessage;
		expect(msg.content).toBe("one good one bad");
		expect(msg.attachments).toHaveLength(1);
	});

	it("text-only messages have no attachments and behave like before", async () => {
		const adapter = newAdapter();
		const onMessage = withSpy(adapter);
		const ingest = vi.fn();
		runtime.media = mockManager(ingest);

		await adapter.handleWebhookUpdate(messageUpdate({ text: "hello" }) as never);

		expect(ingest).not.toHaveBeenCalled();
		const msg = onMessage.mock.calls[0][0] as PlatformMessage;
		expect(msg.content).toBe("hello");
		expect(msg.attachments).toBeUndefined();
	});
});

// ── 4. downloadFile (§9.3) ────────────────────────────────────────────────

describe("downloadFile — /getFile + file stream (§9.3)", () => {
	function newAdapter(): TelegramAdapter {
		return new TelegramAdapter({ enabled: true, platform: "telegram", token: "12345:tok" });
	}

	it("resolves file_path via getFile and streams the file bytes", async () => {
		// First fetch call = /getFile (returns JSON), second = the file download
		// (returns a web ReadableStream that Readable.fromWeb consumes).
		const fileContent = Buffer.from("PNG-DATA");
		const fileStream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(fileContent));
				controller.close();
			},
		});
		const getFileResponse = {
			ok: true,
			json: async () => ({ ok: true, result: { file_path: "photos/pic.png" } }),
		};
		const dlResponse = { ok: true, body: fileStream };

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (String(url).includes("/getFile")) return getFileResponse;
				expect(String(url)).toBe(
					"https://api.telegram.org/file/bot12345:tok/photos/pic.png",
				);
				return dlResponse;
			}),
		);

		const adapter = newAdapter();
		const stream = await (
			adapter as unknown as { downloadFile: (id: string) => Promise<Readable> }
		).downloadFile("file_abc");

		const chunks: Buffer[] = [];
		for await (const chunk of stream) chunks.push(Buffer.from(chunk));
		expect(Buffer.concat(chunks)).toEqual(fileContent);
	});

	it("throws DOWNLOAD_FAILED when getFile reports not-ok", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, json: async () => ({ ok: false }) })),
		);
		const adapter = newAdapter();
		const download = (
			adapter as unknown as {
				downloadFile: (id: string) => Promise<Readable>;
			}
		).downloadFile;

		await expect(download("x")).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
	});

	it("throws DOWNLOAD_FAILED on file HTTP error status", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (String(url).includes("/getFile")) {
					return {
						ok: true,
						json: async () => ({ ok: true, result: { file_path: "p.bin" } }),
					};
				}
				return { ok: false, status: 404, body: null };
			}),
		);
		const adapter = newAdapter();
		const download = (
			adapter as unknown as {
				downloadFile: (id: string) => Promise<Readable>;
			}
		).downloadFile;

		await expect(download("x")).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
	});
});
