/**
 * Phase 3 (File-Attachments) — SQLite media registry.
 *
 * Implements concept_phase_3_media.md §6.2 (storage layout + registry schema).
 *
 * Design follows `src/sessions/store.ts` exactly:
 * - process-wide `better-sqlite3` singleton,
 * - WAL journal mode,
 * - Env-Override of the storage root (`PI_MEDIA_DIR`) so tests never touch
 *   production data,
 * - `resetMediaRegistry()` test-only helper for per-file / per-block isolation.
 *
 * The singleton owns the `media_files` table with the UNIQUE `(platform,
 * file_ref)` dedup key and a `created_at` index for FIFO quota-eviction. This
 * module performs NO filesystem I/O — it only persists and reads rows. All
 * actual file deletion is coordinated by `cleanup.ts` / `manager.ts`.
 */

import Database from "better-sqlite3";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

import { logger } from "../logger.js";
import type { MediaKind } from "./types.js";

// ── Row shape ──────────────────────────────────────────────────────────────

/**
 * A row in the `media_files` table — mirrors the schema one-to-one
 * (snake_case DB columns are mapped to camelCase here).
 */
export interface MediaRegistryRow {
	/** Stable ID ("med_<16hex>") — also the primary key. */
	id: string;
	platform: string;
	channelId: string;
	userId: string;
	/** Plattform-Meldungs-ID. */
	messageId: string;
	/** Opake Plattform-Referenz — the dedup key (with platform). */
	fileRef: string;
	/** Sanitized original file name (metadata only, NOT the storage path). */
	fileName: string;
	/** VERIFIED MIME type (sniffing wins over declared). */
	mimeType: string;
	kind: MediaKind;
	sizeBytes: number;
	/** Absolute local path inside the media store. */
	localPath: string;
	/** Epoch ms at insertion. */
	createdAt: number;
	/** created_at + retentionHours — the TTL boundary for sweep(). */
	expiresAt: number;
}

interface MediaRowDb {
	id: string;
	platform: string;
	channel_id: string;
	user_id: string;
	message_id: string;
	file_ref: string;
	file_name: string;
	mime_type: string;
	kind: string;
	size_bytes: number;
	local_path: string;
	created_at: number;
	expires_at: number;
}

/** Resolve the media store root from env (test pattern like `GATEWAY_DB_DIR`). */
export function resolveMediaRoot(): string {
	return process.env.PI_MEDIA_DIR || join(process.env.HOME || "", ".pi", "runtime", "media");
}

let db: Database.Database | null = null;

/**
 * Initialize the media registry database.
 *
 * The database file lives at `<rootDir>/registry.db` (concept §6.2: the db
 * sits NEXT to the media files so one `rm -rf` cleans up everything). The
 * path is fixed ONLY ONCE per process; subsequent calls return the existing
 * singleton. Use `resetMediaRegistry()` (tests only) to re-point.
 *
 * @param rootDir Entry dir inside which `registry.db` is created. Defaults to
 *                `PI_MEDIA_DIR` or `~/.pi/runtime/media`.
 */
export function initMediaRegistry(rootDir?: string): Database.Database {
	if (db) return db;

	const mediaRoot = rootDir || resolveMediaRoot();
	if (!existsSync(mediaRoot)) {
		mkdirSync(mediaRoot, { recursive: true, mode: 0o700 });
	}

	db = new Database(join(mediaRoot, "registry.db"));
	db.exec("PRAGMA journal_mode = WAL;");

	// Exact schema from concept §6.2.
	db.exec(`
    CREATE TABLE IF NOT EXISTS media_files (
      id            TEXT PRIMARY KEY,
      platform      TEXT NOT NULL,
      channel_id    TEXT NOT NULL,
      user_id       TEXT NOT NULL,
      message_id    TEXT NOT NULL,
      file_ref      TEXT NOT NULL,
      file_name     TEXT NOT NULL,
      mime_type     TEXT NOT NULL,
      kind          TEXT NOT NULL,
      size_bytes    INTEGER NOT NULL,
      local_path    TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      expires_at    INTEGER NOT NULL,
      UNIQUE (platform, file_ref)
    )
  `);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_media_expires ON media_files (expires_at)`);
	// FIFO quota-eviction walks oldest-first by created_at.
	db.exec(`CREATE INDEX IF NOT EXISTS idx_media_created ON media_files (created_at)`);

	logger.info("[MediaRegistry] Database initialized at", join(mediaRoot, "registry.db"));
	return db;
}

/**
 * Close and reset the in-memory singleton (test-only helper, mirrors
 * `resetSessionStore()`). Never call in production.
 */
export function resetMediaRegistry(): void {
	if (db) {
		try {
			db.close();
		} catch (err) {
			logger.warn("[MediaRegistry] Error closing test DB:", err);
		}
		db = null;
	}
}

// ── Row conversion helpers ─────────────────────────────────────────────────

function rowToRegistryRow(row: MediaRowDb): MediaRegistryRow {
	return {
		id: row.id,
		platform: row.platform,
		channelId: row.channel_id,
		userId: row.user_id,
		messageId: row.message_id,
		fileRef: row.file_ref,
		fileName: row.file_name,
		mimeType: row.mime_type,
		kind: row.kind as MediaKind,
		sizeBytes: row.size_bytes,
		localPath: row.local_path,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
	};
}

// ── CRUD (surface specified in the S2 brief) ───────────────────────────────

/** Persist a new media row. Throws on UNIQUE (platform,file_ref) violation. */
export function insert(file: MediaRegistryRow): void {
	const database = initMediaRegistry();
	database
		.prepare(
			`
    INSERT INTO media_files (
      id, platform, channel_id, user_id, message_id, file_ref, file_name,
      mime_type, kind, size_bytes, local_path, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
		)
		.run(
			file.id,
			file.platform,
			file.channelId,
			file.userId,
			file.messageId,
			file.fileRef,
			file.fileName,
			file.mimeType,
			file.kind,
			file.sizeBytes,
			file.localPath,
			file.createdAt,
			file.expiresAt,
		);
}

/** Look up a single row by its stable media id. */
export function get(id: string): MediaRegistryRow | null {
	const database = initMediaRegistry();
	const row = database.prepare("SELECT * FROM media_files WHERE id = ?").get(id) as
		MediaRowDb | undefined;
	return row ? rowToRegistryRow(row) : null;
}

/** Dedup lookup: an ACTIVE row for (platform, fileRef) returns it, else null. */
export function getForDedup(platform: string, fileRef: string): MediaRegistryRow | null {
	const database = initMediaRegistry();
	const row = database
		.prepare("SELECT * FROM media_files WHERE platform = ? AND file_ref = ?")
		.get(platform, fileRef) as MediaRowDb | undefined;
	return row ? rowToRegistryRow(row) : null;
}

/** Delete a row by id. Returns whether a row was actually removed. */
export function deleteMedia(id: string): boolean {
	const database = initMediaRegistry();
	return database.prepare("DELETE FROM media_files WHERE id = ?").run(id).changes > 0;
}

/**
 * All rows whose TTL has passed (`expires_at < now`). Used by the TTL sweep;
 * includes fully-mapped rows so the caller can delete the physical files.
 */
export function getExpired(now: number = Date.now()): MediaRegistryRow[] {
	const database = initMediaRegistry();
	const rows = database
		.prepare("SELECT * FROM media_files WHERE expires_at < ?")
		.all(now) as MediaRowDb[];
	return rows.map(rowToRegistryRow);
}

// ── Quota / stats helpers (used by cleanup.ts and manager.ts) ──────────────

/** Total number of registered files. */
export function count(): number {
	const database = initMediaRegistry();
	const row = database.prepare("SELECT COUNT(*) AS n FROM media_files").get() as {
		n: number;
	};
	return row.n;
}

/** Total size in bytes of all registered files. */
export function getTotalBytes(): number {
	const database = initMediaRegistry();
	const row = database
		.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS total FROM media_files")
		.get() as { total: number };
	return row.total;
}

/** Oldest `limit` files first (FIFO order) — drives quota-eviction. */
export function listOldestFirst(limit?: number): MediaRegistryRow[] {
	const database = initMediaRegistry();
	const query = limit
		? "SELECT * FROM media_files ORDER BY created_at ASC LIMIT ?"
		: "SELECT * FROM media_files ORDER BY created_at ASC";
	const rows = (
		limit ? database.prepare(query).all(limit) : database.prepare(query).all()
	) as MediaRowDb[];
	return rows.map(rowToRegistryRow);
}

/** Delete rows whose physical file no longer exists (crash-rest consolidation). */
export function pruneMissingFiles(existsFn: (localPath: string) => boolean): MediaRegistryRow[] {
	const database = initMediaRegistry();
	const all = database.prepare("SELECT * FROM media_files").all() as MediaRowDb[];
	const missing = all.filter((row) => !existsFn(row.local_path)).map(rowToRegistryRow);
	const del = database.prepare("DELETE FROM media_files WHERE id = ?");
	for (const row of missing) {
		del.run(row.id);
	}
	return missing;
}
