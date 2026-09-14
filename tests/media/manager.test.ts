/**
 * Integration tests for `src/media/manager.ts` — the MediaManager orchestration
 * singleton (concept §12: `tests/media/manager.test.ts`).
 *
 * Each test calls `freshManager()` to isolate against its own ephemeral temp
 * directory (via `resetMediaManager()`), so no registry rows or files leak
 * between tests. Downloads are served by in-memory fetch closures (Buffers /
 * streams), never real network.
 *
 * Coverage: happy path, declared pre-checks (size/MIME), dedup (registry-hit +
 * in-flight), quota eviction, spoof validation, failed downloads, discard, and
 * TTL sweep.
 */

import { existsSync, readdirSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { expect, it, afterEach } from "vitest";

import { MediaError, type MediaIngestRequest } from "../../src/media/types.js";
import {
	initMediaManager,
	resetMediaManager,
	type MediaManager,
	type MediaOptions,
} from "../../src/media/manager.js";
import { getMediaRow } from "../../src/media/index.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Minimal PNG payload (magic bytes + padding). */
function pngBytes(size = 128): Buffer {
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		Buffer.alloc(size - 8, 0x11),
	]);
}

/** Assert a promise rejects with a specific stable MediaError code. */
async function expectMediaError(promise: Promise<unknown>, code: string): Promise<void> {
	try {
		await promise;
	} catch (err) {
		expect(err).toBeInstanceOf(MediaError);
		expect((err as MediaError).code).toBe(code);
		return;
	}
	throw new Error(`expected MediaError ${code}, but the promise resolved`);
}

// ── Shared scratch lifecycle ────────────────────────────────────────────────

let dirCounter = 0;
let currentRoot = "";

/** Reset the singleton and point it at a brand-new temp root. */
function freshManager(options?: MediaOptions): MediaManager {
	resetMediaManager();
	dirCounter += 1;
	currentRoot = mkdtempSync(join(tmpdir(), `pi-media-man-${dirCounter}-`));
	return initMediaManager({ rootDir: currentRoot, sweepIntervalMinutes: 0, ...options });
}

/** Build a valid ingest request for a PNG buffer (override per test). */
function pngRequest(overrides: Partial<MediaIngestRequest> = {}): MediaIngestRequest {
	return {
		platform: "telegram",
		messageId: "msg-1",
		fileRef: "file-1",
		fileName: "shot.png",
		declaredMime: "image/png",
		declaredSizeBytes: 128,
		kindHint: "image",
		fetch: async () => pngBytes(),
		...overrides,
	};
}

/** Small shell-script fixture (Shebang + commands) used for script-type tests. */
function shellScriptBytes(): Buffer {
	return Buffer.from(
		"#!/bin/bash\n# zfs backup\nset -euo pipefail\nsudo zfs snapshot pool@now\n",
		"utf8",
	);
}

/** Walk the store and return any leftover `.part` temp files. */
function findPartFiles(root: string): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		if (!existsSync(dir)) return;
		for (const dirent of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, dirent.name);
			if (dirent.isDirectory()) walk(full);
			else if (dirent.name.endsWith(".part")) found.push(full);
		}
	};
	walk(root);
	return found;
}

// Tear down the most recent scratch directory after each test.
afterEach(() => {
	resetMediaManager();
	if (currentRoot) rmSync(currentRoot, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("MediaManager — happy path", () => {
	it("ingests a PNG, persists the file and registers a row", async () => {
		const manager = freshManager();
		const att = await manager.ingest(pngRequest());

		expect(att.id).toMatch(/^med_[0-9a-f]{16}$/);
		expect(att.kind).toBe("image");
		expect(att.mimeType).toBe("image/png");
		expect(att.sizeBytes).toBe(128);
		expect(att.localPath).toMatch(/\/telegram\/\d{4}-\d{2}\/med_[0-9a-f]{16}\.png$/);
		expect(existsSync(att.localPath)).toBe(true);

		const row = getMediaRow(att.id);
		expect(row).not.toBeNull();
		expect(row!.fileRef).toBe("file-1");
		expect(row!.fileName).toBe("shot.png");
		expect(row!.expiresAt - row!.createdAt).toBe(24 * 3600 * 1000);
	});

	it("handles a stream-based fetch (Readable) end-to-end", async () => {
		const manager = freshManager();
		const att = await manager.ingest(
			pngRequest({ fetch: async () => Readable.from([pngBytes()]) }),
		);
		expect(att.kind).toBe("image");
		expect(readFileSync(att.localPath).equals(pngBytes())).toBe(true);
	});

	it("stats() reflects the stored file", async () => {
		const manager = freshManager();
		await manager.ingest(pngRequest());
		const stats = await manager.stats();
		expect(stats.fileCount).toBe(1);
		expect(stats.totalBytes).toBe(128);
		expect(stats.oldestAt).toBeTypeOf("number");
	});
});

describe("MediaManager — declared pre-checks", () => {
	it("rejects a declared size above the cap before any download", async () => {
		const manager = freshManager({ maxFileSizeBytes: 100 });
		let fetchCalled = 0;
		await expectMediaError(
			manager.ingest(
				pngRequest({
					declaredSizeBytes: 1000,
					fetch: async () => {
						fetchCalled++;
						return pngBytes();
					},
				}),
			),
			"SIZE_EXCEEDED",
		);
		expect(fetchCalled).toBe(0);
	});

	it("rejects a declared MIME not on the allowlist before any download", async () => {
		const manager = freshManager();
		let fetchCalled = 0;
		await expectMediaError(
			manager.ingest(
				pngRequest({
					declaredMime: "application/x-msdownload",
					fetch: async () => {
						fetchCalled++;
						return pngBytes();
					},
				}),
			),
			"UNSUPPORTED_TYPE",
		);
		expect(fetchCalled).toBe(0);
	});

	it("accepts a declared text/x-shellscript MIME — content verification decides (no early abort)", async () => {
		const manager = freshManager();
		let fetchCalled = 0;
		const att = await manager.ingest(
			pngRequest({
				fileName: "zfs_backup.sh",
				declaredMime: "text/x-shellscript",
				kindHint: "document",
				fetch: async () => {
					fetchCalled++;
					return shellScriptBytes();
				},
			}),
		);
		expect(fetchCalled).toBe(1);
		expect(att.mimeType).toBe("text/x-shellscript"); // declared text/* kept (rule 3)
		expect(att.kind).toBe("document");
	});

	it("accepts a declared application/x-sh MIME (now on the allowlist) with text content", async () => {
		const manager = freshManager();
		let fetchCalled = 0;
		const att = await manager.ingest(
			pngRequest({
				fileName: "zfs_backup_extended.sh",
				declaredMime: "application/x-sh",
				kindHint: "document",
				fetch: async () => {
					fetchCalled++;
					return shellScriptBytes();
				},
			}),
		);
		expect(fetchCalled).toBe(1);
		expect(att.mimeType).toBe("text/plain");
		expect(att.kind).toBe("document");
	});

	it("accepts Telegram's generic octet-stream fallback when the content is a text script", async () => {
		const manager = freshManager();
		let fetchCalled = 0;
		const att = await manager.ingest(
			pngRequest({
				fileName: "zfs_backup_extended.sh",
				declaredMime: "application/octet-stream",
				kindHint: "document",
				fetch: async () => {
					fetchCalled++;
					return shellScriptBytes();
				},
			}),
		);
		expect(fetchCalled).toBe(1);
		expect(att.mimeType).toBe("text/plain"); // sniffed (declared is generic)
		expect(att.kind).toBe("document");
	});
});

describe("MediaManager — dedup", () => {
	it("returns the existing attachment on a registry cache hit (no re-download)", async () => {
		const manager = freshManager();
		let fetchCount = 0;
		const req = pngRequest({
			fetch: async () => {
				fetchCount++;
				return pngBytes();
			},
		});

		const first = await manager.ingest(req);
		const second = await manager.ingest({ ...req, messageId: "msg-2" });

		expect(fetchCount).toBe(1);
		expect(second.id).toBe(first.id);
		expect(second.localPath).toBe(first.localPath);
	});

	it("collapses concurrent ingests of the same fileRef via the in-flight map", async () => {
		const manager = freshManager();
		let fetchCount = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const req = pngRequest({
			fetch: async () => {
				fetchCount++;
				await gate;
				return pngBytes();
			},
		});

		const p1 = manager.ingest(req);
		const p2 = manager.ingest(req); // in-flight dedup → shares p1's promise

		// Both fetches are gated; ensure only one download kicks off.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(fetchCount).toBe(1);

		release(); // unblock the shared download
		const [a, b] = await Promise.all([p1, p2]);
		expect(fetchCount).toBe(1);
		expect(a.id).toBe(b.id);
	});
});

describe("MediaManager — quota eviction", () => {
	it("evicts the oldest file FIFO to make room for a new one", async () => {
		const manager = freshManager({ maxTotalBytes: 250 });
		// A: 128 B stored (128 ≤ 250). B: 128 + 128 = 256 > 250 → evict A.
		const a = await manager.ingest(pngRequest({ fileRef: "file-a" }));
		const b = await manager.ingest(pngRequest({ fileRef: "file-b" }));

		expect(existsSync(a.localPath)).toBe(false);
		expect(existsSync(b.localPath)).toBe(true);
		expect(await manager.stats()).toMatchObject({ fileCount: 1, totalBytes: 128 });
	});

	it("throws QUOTA_EXCEEDED when a single file cannot fit the store", async () => {
		const manager = freshManager({ maxTotalBytes: 100 });
		await expectMediaError(
			manager.ingest(pngRequest({ declaredSizeBytes: 128 })),
			"QUOTA_EXCEEDED",
		);
	});
});

describe("MediaManager — validation & failed download", () => {
	it("rejects spoofed content (declared png, actual executable) and leaves nothing behind", async () => {
		const manager = freshManager();
		const exe = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(128, 0xaa)]);
		await expectMediaError(
			manager.ingest(pngRequest({ fetch: async () => exe, declaredMime: "image/png" })),
			"UNSUPPORTED_TYPE",
		);
		expect(await manager.stats()).toMatchObject({ fileCount: 0 });
		expect(findPartFiles(currentRoot)).toHaveLength(0);
	});

	it("throws DOWNLOAD_FAILED after a fetch rejection and cleans up", async () => {
		const manager = freshManager();
		let attempts = 0;
		await expectMediaError(
			manager.ingest(
				pngRequest({
					fetch: async () => {
						attempts++;
						throw new Error("network down");
					},
				}),
			),
			"DOWNLOAD_FAILED",
		);
		expect(attempts).toBe(2); // 1 retry after a 2 s backoff
		expect(findPartFiles(currentRoot)).toHaveLength(0);
	});
});

describe("MediaManager — discard", () => {
	it("deletes the file and the registry row, idempotently", async () => {
		const manager = freshManager();
		const att = await manager.ingest(pngRequest());

		await manager.discard([att.id, "does-not-exist"]); // unknown id is a no-op
		expect(existsSync(att.localPath)).toBe(false);
		expect(getMediaRow(att.id)).toBeNull();
		expect(await manager.stats()).toMatchObject({ fileCount: 0 });
	});
});

describe("MediaManager — TTL sweep", () => {
	it("sweep() removes expired files (registry + filesystem)", async () => {
		const manager = freshManager({ retentionHours: 1 });
		const att = await manager.ingest(pngRequest());
		expect(existsSync(att.localPath)).toBe(true);

		// expires_at = createdAt + 1 h; inject now far enough in the future.
		const res = await manager.sweep(Date.now() + 2 * 3600 * 1000);
		expect(res.deletedFiles).toBe(1);
		expect(res.freedBytes).toBe(128);
		expect(existsSync(att.localPath)).toBe(false);
		expect(getMediaRow(att.id)).toBeNull();
	});
});
