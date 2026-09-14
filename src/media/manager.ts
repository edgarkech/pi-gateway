/**
 * Phase 3 (File-Attachments) — MediaManager orchestration.
 *
 * Implements concept_phase_3_media.md §6.1 (public API) and §6.4 (sweep
 * interval). The `ingest()` flow follows the exact 8 steps from the concept:
 *
 *   1. Pre-check size   → `declaredSizeBytes` vs `maxFileSizeBytes`
 *   2. Pre-check MIME   → `declaredMime` against the allowlist
 *   3. Dedup check      → registry lookup via (platform, fileRef)
 *   4. Quota check      → totalBytes + newSize vs maxTotalBytes (+ FIFO eviction)
 *   5. Download         → `req.fetch()` with 60 s timeout + 1 retry (2 s backoff)
 *   6. Validation       → magic-byte sniffing via `validateMedia` (S1)
 *   7. Persist          → atomic `.part` → final rename + registry insert
 *   8. Return           → `MediaAttachment`
 *
 * In addition: an in-flight dedup map prevents concurrent duplicate downloads
 * of the same (platform, fileRef), `discard()` deletes immediately, `stats()`
 * reports store usage, and `sweep()` runs the TTL policy.
 *
 * Singleton pattern mirrors sessions/store.ts: `initMediaManager()` returns
 * the process-wide instance; `resetMediaManager()` is test-only.
 */

import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";

import { logger } from "../logger.js";
import { MediaError, type MediaAttachment, type MediaIngestRequest } from "./types.js";
import { DEFAULT_ALLOWED_MIME_TYPES, sanitizeFilename, validateMedia } from "./validate.js";
import { cleanupStaleParts, evictOldestForQuota, pruneRegistry, sweepExpired } from "./cleanup.js";
import {
	count as countRows,
	deleteMedia,
	get as getRow,
	getForDedup,
	getTotalBytes,
	initMediaRegistry,
	insert as insertRow,
	listOldestFirst,
	resetMediaRegistry,
	type MediaRegistryRow,
} from "./registry.js";

// ── Options / config (defaults from concept §10) ───────────────────────────

export interface MediaOptions {
	/** Storage root. Default: `PI_MEDIA_DIR` or `~/.pi/runtime/media`. */
	rootDir?: string;
	/** Max bytes per file. Default: 20_480_000 (Telegram bot limit). */
	maxFileSizeBytes?: number;
	/** Total store quota in bytes. Default: 536_870_912 (512 MB). */
	maxTotalBytes?: number;
	/** Per-file retention in hours. Default: 24. */
	retentionHours?: number;
	/** Periodic sweep interval in minutes. <= 0 disables the timer. Default: 30. */
	sweepIntervalMinutes?: number;
	/**
	 * Stricter MIME allowlist override. When provided (non-empty), the verified
	 * type must additionally appear here. Empty/omitted = built-in defaults.
	 */
	allowedMimeTypes?: readonly string[];
}

interface ResolvedOptions {
	rootDir: string;
	maxFileSizeBytes: number;
	maxTotalBytes: number;
	retentionHours: number;
	sweepIntervalMinutes: number;
	allowedMimeTypes?: readonly string[];
}

const DEFAULT_MAX_FILE = 20_480_000; // Telegram bot limit (§10)
const DEFAULT_MAX_TOTAL = 536_870_912; // 512 MB
const DEFAULT_RETENTION_HOURS = 24;
const DEFAULT_SWEEP_INTERVAL = 30; // minutes

// ── Public API (concept §6.1) ──────────────────────────────────────────────

export interface MediaManager {
	/** Download → validate → persist → register. Throws MediaError on any rejection. */
	ingest(req: MediaIngestRequest): Promise<MediaAttachment>;
	/** Delete file(s) + registry row(s). Idempotent. */
	discard(ids: string[]): Promise<void>;
	/** TTL sweeps for rows past their retention period. */
	sweep(now?: number): Promise<{ deletedFiles: number; freedBytes: number }>;
	/** Store usage (files, bytes, oldest file age). */
	stats(): Promise<{ fileCount: number; totalBytes: number; oldestAt: number | null }>;
}

// ── Singleton state ────────────────────────────────────────────────────────

let instance: MediaManagerImpl | null = null;

/**
 * Initialize the process-wide MediaManager singleton.
 *
 * First call wires the SQLite registry (re-pointed by `PI_MEDIA_DIR`), runs
 * startup consolidation (orphan `.part` cleanup + registry pruning, §6.4) and
 * starts the periodic TTL sweep. Subsequent calls return the existing
 * instance.
 */
export function initMediaManager(mediaConfig?: MediaOptions): MediaManager {
	if (instance) return instance;
	instance = buildMediaManager(mediaConfig ?? {});
	return instance;
}

/** Test-only reset: clears the interval, closes the DB, drops the singleton. */
export function resetMediaManager(): void {
	if (instance) {
		instance.close();
		instance = null;
	}
}

/**
 * Graceful shutdown (daemon lifecycle, S6): run a final TTL sweep so no file
 * outlives the retention window after the process stops, then clear the
 * periodic timer and close the registry DB. Idempotent — safe to call even
 * if the manager was never bootstrapped or already shut down.
 */
export async function shutdownMediaManager(): Promise<void> {
	if (!instance) return;
	try {
		const res = await instance.sweep();
		if (res.deletedFiles > 0) {
			logger.info(
				`[MediaManager] Final shutdown sweep deleted ${res.deletedFiles} files (${res.freedBytes} B)`,
			);
		}
	} catch (err) {
		logger.warn("[MediaManager] Final shutdown sweep failed:", err);
	}
	instance.close();
	instance = null;
}

/** Build the singleton-backed manager with resolved options. */
function buildMediaManager(raw: MediaOptions): MediaManagerImpl {
	const options: ResolvedOptions = {
		rootDir:
			raw.rootDir ||
			process.env.PI_MEDIA_DIR ||
			join(homedirPiDir(), ".pi", "runtime", "media"),
		maxFileSizeBytes: raw.maxFileSizeBytes ?? DEFAULT_MAX_FILE,
		maxTotalBytes: raw.maxTotalBytes ?? DEFAULT_MAX_TOTAL,
		retentionHours: raw.retentionHours ?? DEFAULT_RETENTION_HOURS,
		sweepIntervalMinutes: raw.sweepIntervalMinutes ?? DEFAULT_SWEEP_INTERVAL,
		allowedMimeTypes:
			raw.allowedMimeTypes && raw.allowedMimeTypes.length > 0
				? raw.allowedMimeTypes
				: undefined,
	};

	// Point the SQLite singleton at our storage root (registry.db sits beside
	// the files so metadata and filesystem never diverge).
	initMediaRegistry(options.rootDir);

	// Startup cleanup (§6.4): crash-rest consolidation before serving.
	cleanupStaleParts(options.rootDir, 60 * 60 * 1000).catch((err) =>
		logger.warn("[MediaManager] Startup .part cleanup failed:", err),
	);
	try {
		const pruned = pruneRegistry();
		if (pruned > 0) logger.info(`[MediaManager] Startup pruned ${pruned} orphan rows`);
	} catch (err) {
		logger.warn("[MediaManager] Startup registry prune failed:", err);
	}

	const inflight = new Map<string, Promise<MediaAttachment>>();

	let sweepTimer: ReturnType<typeof setInterval> | null = null;
	if (options.sweepIntervalMinutes > 0) {
		const intervalMs = options.sweepIntervalMinutes * 60 * 1000;
		sweepTimer = setInterval(() => {
			sweepExpired()
				.then((res) => {
					if (res.deletedFiles > 0) {
						logger.info(
							`[MediaManager] Periodic sweep deleted ${res.deletedFiles} files (${res.freedBytes} B)`,
						);
					}
				})
				.catch((err) => logger.warn("[MediaManager] Periodic sweep failed:", err));
		}, intervalMs);
		if (typeof sweepTimer.unref === "function") sweepTimer.unref();
	}

	return new MediaManagerImpl(options, inflight, sweepTimer);
}

function homedirPiDir(): string {
	return process.env.HOME || "";
}

class MediaManagerImpl implements MediaManager {
	readonly #options: ResolvedOptions;
	readonly #inflight: Map<string, Promise<MediaAttachment>>;
	readonly #sweepTimer: ReturnType<typeof setInterval> | null;

	constructor(
		options: ResolvedOptions,
		inflight: Map<string, Promise<MediaAttachment>>,
		sweepTimer: ReturnType<typeof setInterval> | null,
	) {
		this.#options = options;
		this.#inflight = inflight;
		this.#sweepTimer = sweepTimer;
	}

	// ── ingest: the 8-step flow ─────────────────────────────────────────────

	async ingest(req: MediaIngestRequest): Promise<MediaAttachment> {
		logger.info(
			`[MediaManager] ingest start platform=${req.platform} ref=${truncate(req.fileRef)}`,
		);

		// Step 1 — Pre-check declared size (no download yet).
		if (
			req.declaredSizeBytes !== undefined &&
			req.declaredSizeBytes > this.#options.maxFileSizeBytes
		) {
			throw new MediaError(
				"SIZE_EXCEEDED",
				`Declared size ${req.declaredSizeBytes} exceeds max ${this.#options.maxFileSizeBytes}`,
			);
		}

		// Step 2 — Pre-check declared MIME (no download yet).
		// The pre-check is a cheap early-abort, NOT the security anchor: the
		// authoritative check runs AFTER download via magic-byte sniffing
		// (Step 6). Text-*declared* types (e.g. text/x-shellscript, .conf, .py)
		// are admitted up front — if the verified content turns out to be a
		// binary/executable, Step 6 rejects it with UNSUPPORTED_TYPE.
		if (req.declaredMime) {
			const normalized = req.declaredMime.trim().toLowerCase();
			// The pre-check is a cheap early-abort, NOT the security anchor: the
			// authoritative check runs AFTER download via magic-byte sniffing
			// (Step 6). Text-*declared* types, Telegram's generic octet-stream
			// fallback and any *script* type are admitted up front — if the
			// verified content turns out to be a binary/executable, Step 6
			// rejects it with UNSUPPORTED_TYPE.
			const admitForContentCheck =
				this.#isAllowed(normalized) ||
				normalized.startsWith("text/") ||
				normalized === "application/octet-stream" ||
				normalized.includes("script");
			if (!admitForContentCheck) {
				throw new MediaError(
					"UNSUPPORTED_TYPE",
					`Declared type '${req.declaredMime}' is not allowed`,
				);
			}
		}

		// Step 3 — Dedup check against the registry (already-persisted file).
		const cached = getForDedup(req.platform, req.fileRef);
		if (cached) {
			logger.info(`[MediaManager] dedup cache hit for ${cached.id}`);
			return this.#attachmentFromRow(cached);
		}

		// In-flight dedup: reuse a concurrent download of the same fileRef.
		const key = `${req.platform}:${req.fileRef}`;
		const pending = this.#inflight.get(key);
		if (pending) return pending;

		const promise = this.#downloadAndPersist(req);
		this.#inflight.set(key, promise);
		try {
			return await promise;
		} finally {
			this.#inflight.delete(key);
		}
	}

	/** Steps 4–8 of the ingest flow. */
	async #downloadAndPersist(req: MediaIngestRequest): Promise<MediaAttachment> {
		const id = generateMediaId();
		const now = Date.now();

		// Step 4 — Quota check + FIFO eviction to make room for the new file.
		const estimate = req.declaredSizeBytes ?? 0;
		if (getTotalBytes() + estimate > this.#options.maxTotalBytes) {
			// Evict oldest until the retained store can fit `estimate` more bytes.
			const target = this.#options.maxTotalBytes - estimate;
			const evicted = await evictOldestForQuota(target, getTotalBytes());
			if (evicted.deletedFiles > 0) {
				logger.warn(
					`[MediaManager] quota eviction freed ${evicted.freedBytes} B (${evicted.deletedFiles} files)`,
				);
			}
			// Not satisfiable even after clearing (e.g. single file > quota).
			if (getTotalBytes() + estimate > this.#options.maxTotalBytes) {
				throw new MediaError(
					"QUOTA_EXCEEDED",
					`Store quota ${this.#options.maxTotalBytes} B cannot accommodate this file`,
				);
			}
		}

		// Allocate the final path (root/<platform>/<yyyy-mm>/<id><ext>) and a
		// sibling `.part` temp for the atomic rename.
		const ext = extensionForMime(req.declaredMime);
		const finalPath = await this.#allocateFinalPath(req.platform, id, ext);
		const partPath = `${finalPath}.part`;

		// Step 5 — Download with 60 s timeout + 1 retry, streamed into `.part`.
		let actualBytes: number;
		try {
			actualBytes = await this.#downloadToPart(req, partPath, id);
		} catch (err) {
			await rm(partPath, { force: true }).catch(() => undefined);
			if (err instanceof MediaError) throw err;
			throw new MediaError(
				"DOWNLOAD_FAILED",
				err instanceof Error ? err.message : "Download failed",
			);
		}

		// Steps 6–8 with a guard that removes the temp on any rejection.
		try {
			// Step 6 — Validation: magic-byte sniffing via S1 validateMedia.
			if (actualBytes > this.#options.maxFileSizeBytes) {
				throw new MediaError(
					"SIZE_EXCEEDED",
					`Measured size ${actualBytes} exceeds max ${this.#options.maxFileSizeBytes}`,
				);
			}
			const head = await readFileHead(partPath, 32_768);
			const verified = validateMedia(head, req.declaredMime);
			if (this.#allowedOverride() && !this.#allowedOverride()!.has(verified.mimeType)) {
				throw new MediaError(
					"UNSUPPORTED_TYPE",
					`Verified type '${verified.mimeType}' is not allowed by policy`,
				);
			}

			// Step 7 — Persist: atomically move the complete `.part` into place
			// (file 0600, dirs 0700), then register the row.
			await rename(partPath, finalPath);
			await chmod(finalPath, 0o600);

			const fileName = sanitizeFilename(req.fileName ?? "attachment") || "attachment";
			const attachment: MediaAttachment = {
				id,
				kind: verified.kind,
				mimeType: verified.mimeType,
				fileName,
				sizeBytes: actualBytes,
				localPath: finalPath,
				source: {
					platform: req.platform,
					messageId: req.messageId,
					fileRef: req.fileRef,
				},
			};

			this.#insertRegistryRow(
				attachment,
				req.channelId ?? "",
				req.userId ?? "",
				now,
				now + this.#options.retentionHours * 3600 * 1000,
			);

			logger.info(
				`[MediaManager] ingested ${id} kind=${verified.kind} mime=${verified.mimeType} bytes=${actualBytes} → ${finalPath}`,
			);
			// Step 8 — Return the validated attachment.
			return attachment;
		} catch (err) {
			// No half-stored file may remain on any validation/persist failure.
			await rm(partPath, { force: true }).catch(() => undefined);
			if (err instanceof MediaError) throw err;
			throw new MediaError(
				"VALIDATION_FAILED",
				err instanceof Error ? err.message : "Validation failed",
			);
		}
	}

	// ── Discard / sweep / stats ─────────────────────────────────────────────

	async discard(ids: string[]): Promise<void> {
		for (const id of ids) {
			const row = getRow(id);
			if (row) {
				await rm(row.localPath, { force: true }).catch(() => undefined);
			}
			deleteMedia(id);
		}
	}

	async sweep(now?: number): Promise<{ deletedFiles: number; freedBytes: number }> {
		return sweepExpired(now);
	}

	async stats(): Promise<{ fileCount: number; totalBytes: number; oldestAt: number | null }> {
		const oldest = listOldestFirst(1)[0];
		return {
			fileCount: countRows(),
			totalBytes: getTotalBytes(),
			oldestAt: oldest ? oldest.createdAt : null,
		};
	}

	close(): void {
		if (this.#sweepTimer) clearInterval(this.#sweepTimer);
		resetMediaRegistry();
	}

	// ── internal helpers ────────────────────────────────────────────────────

	/** Download the fetch-closure's stream/buffer into a `.part` file. */
	async #downloadToPart(req: MediaIngestRequest, partPath: string, id: string): Promise<number> {
		await mkdir(dirname(partPath), { recursive: true, mode: 0o700 });

		const attempt = async (): Promise<number> => {
			const source = await withTimeout(req.fetch(), 60_000, "TIMEOUT");
			return writeIntoPart(source, partPath, this.#options.maxFileSizeBytes);
		};

		try {
			return await attempt();
		} catch (err) {
			// SIZE_EXCEEDED is decisive (no point re-fetching the whole file);
			// TIMEOUT already consumed the budget — do not compound another 60 s.
			if (err instanceof MediaError && err.code === "SIZE_EXCEEDED") throw err;
			logger.warn(`[MediaManager] download attempt failed for ${id}, retrying...:`, err);
			await sleep(2000);
			return attempt(); // final attempt
		}
	}

	/** Build the absolute final storage path (bucketed by platform + month). */
	async #allocateFinalPath(platform: string, id: string, ext: string): Promise<string> {
		const now = new Date();
		const bucket = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
		const dir = join(this.#options.rootDir, sanitizeSegment(platform), bucket);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		return join(dir, `${id}${ext}`);
	}

	#isAllowed(mime: string): boolean {
		const override = this.#allowedOverride();
		if (override) return override.has(mime);
		return DEFAULT_ALLOWED_MIME_TYPES.includes(mime);
	}

	#allowedOverride(): ReadonlySet<string> | null {
		if (!this.#options.allowedMimeTypes) return null;
		return new Set(this.#options.allowedMimeTypes.map((m) => m.trim().toLowerCase()));
	}

	#insertRegistryRow(
		att: MediaAttachment,
		channelId: string,
		userId: string,
		createdAt: number,
		expiresAt: number,
	): void {
		const row: MediaRegistryRow = {
			id: att.id,
			platform: att.source.platform,
			channelId,
			userId,
			messageId: att.source.messageId,
			fileRef: att.source.fileRef,
			fileName: att.fileName,
			mimeType: att.mimeType,
			kind: att.kind,
			sizeBytes: att.sizeBytes,
			localPath: att.localPath,
			createdAt,
			expiresAt,
		};
		insertRow(row);
	}

	#attachmentFromRow(row: MediaRegistryRow): MediaAttachment {
		return {
			id: row.id,
			kind: row.kind,
			mimeType: row.mimeType,
			fileName: row.fileName,
			sizeBytes: row.sizeBytes,
			localPath: row.localPath,
			source: {
				platform: row.platform,
				messageId: row.messageId,
				fileRef: row.fileRef,
			},
		};
	}
}

// ── Module-level helpers (no instance state) ───────────────────────────────

/** 16 random hex chars prefixed with `med_`. */
function generateMediaId(): string {
	return `med_${randomBytes(8).toString("hex")}`;
}

function truncate(ref: string): string {
	return ref.length > 12 ? `${ref.slice(0, 12)}…` : ref;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Race a promise against a hard deadline; rejects with the given MediaError code. */
async function withTimeout<T>(p: Promise<T>, ms: number, code: "TIMEOUT"): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new MediaError(code, `Operation timed out after ${ms} ms`)),
			ms,
		);
	});
	try {
		return await Promise.race([p, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Stream a fetch result (Readable or Buffer) into a file while counting bytes
 * and aborting as soon as the cap is hit (concept §8 E5).
 */
function writeIntoPart(
	source: Readable | Buffer,
	partPath: string,
	maxBytes: number,
): Promise<number> {
	const out = createWriteStream(partPath, { mode: 0o600 });

	if (Buffer.isBuffer(source)) {
		if (source.length > maxBytes) {
			out.destroy();
			return Promise.reject(
				new MediaError("SIZE_EXCEEDED", `Measured size exceeds cap ${maxBytes}`),
			);
		}
		return new Promise<number>((resolve, reject) => {
			out.on("error", reject);
			out.on("close", () => resolve(source.length));
			out.end(source);
		});
	}

	let bytes = 0;
	return new Promise<number>((resolve, reject) => {
		out.on("error", reject);
		out.on("close", () => resolve(bytes));
		source.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > maxBytes) {
				source.removeAllListeners("data");
				source.destroy();
				out.destroy(
					new MediaError("SIZE_EXCEEDED", `Measured size exceeds cap ${maxBytes}`),
				);
			}
		});
		source.pipe(out);
	});
}

/** Read up to `maxBytes` from the head of a file (for magic-byte sniffing). */
async function readFileHead(path: string, maxBytes: number): Promise<Buffer> {
	const handle = await open(path, "r");
	try {
		const buf = Buffer.alloc(maxBytes);
		const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
		return buf.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

/** Map a (verified or declared) MIME to a storage extension. */
function extensionForMime(mime: string | undefined): string {
	switch ((mime || "").trim().toLowerCase()) {
		case "image/jpeg":
			return ".jpg";
		case "image/png":
			return ".png";
		case "image/gif":
			return ".gif";
		case "image/webp":
			return ".webp";
		case "application/pdf":
			return ".pdf";
		case "application/msword":
			return ".doc";
		case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
			return ".docx";
		case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
			return ".xlsx";
		case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
			return ".pptx";
		case "application/vnd.oasis.opendocument.text":
			return ".odt";
		case "application/zip":
			return ".zip";
		case "application/x-7z-compressed":
			return ".7z";
		case "audio/mpeg":
			return ".mp3";
		case "audio/ogg":
		case "audio/opus":
			return ".ogg";
		case "audio/mp4":
		case "audio/x-m4a":
			return ".m4a";
		case "audio/wav":
			return ".wav";
		case "audio/aac":
			return ".aac";
		case "video/mp4":
			return ".mp4";
		case "video/webm":
			return ".webm";
		case "video/quicktime":
			return ".mov";
		case "video/x-matroska":
			return ".mkv";
		case "text/markdown":
			return ".md";
		case "text/csv":
			return ".csv";
		case "text/html":
			return ".html";
		case "application/json":
			return ".json";
		case "application/xml":
			return ".xml";
		default:
			return "";
	}
}

/** Sanitize a directory segment (platform) against path tricks. */
function sanitizeSegment(segment: string): string {
	return segment.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 32) || "unknown";
}
