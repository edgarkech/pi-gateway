/**
 * Nextcloud Talk — Polling-Wasserstand-Store (Phase 4 S2).
 *
 * Persistiert den Last-Seen-Wasserstand (`lastKnownMessageId`) pro Raum in
 * SQLite, damit der Poller nach einem Restart exakt dort weitermacht, wo er
 * aufgehört hat (Warm-Start, at-least-once — Konzept D3 / §5.2). Der
 * Wasserstand wird erst NACH erfolgreicher Batch-Verarbeitung persistiert,
 * daher wird bei einem Crash nichts übersprungen.
 *
 * Muster wie `src/sessions/store.ts`: better-sqlite3, process-weites
 * Singleton, WAL-Modus, Env-Override für Tests.
 */

import Database from "better-sqlite3";
import { join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync } from "fs";
import { logger } from "../../logger.js";

// ── Database path resolution ────────────────────────────────────
//
// Test Isolation:
// The module owns a process-wide singleton `db`. To prevent tests from
// corrupting production data (or each other), the database root directory
// can be overridden — either via the `GATEWAY_TALK_STATE_DIR` environment
// variable or programmatically through `initTalkStateStore(dir?)` /
// `resetTalkStateStore()`.

/** Resolve the directory that holds the Talk poll-state database file. */
function resolveTalkStateDir(): string {
	return process.env.GATEWAY_TALK_STATE_DIR || join(homedir(), ".pi", "gateway");
}

let db: Database.Database | null = null;

/**
 * Initialize the Talk poll-state database.
 *
 * Resolves the database directory from (in priority order):
 *   1. the optional `dir` argument (programmatic override — used by tests),
 *   2. the `GATEWAY_TALK_STATE_DIR` environment variable,
 *   3. the default `~/.pi/gateway` directory.
 *
 * The database path is only fixed ONCE per process. Subsequent calls return
 * the existing singleton. Use `shutdownTalkStateStore()` (daemon stop) or
 * `resetTalkStateStore()` (tests only) to release the handle.
 */
export function initTalkStateStore(dir?: string): Database.Database {
	if (db) return db;

	const stateDir = dir || resolveTalkStateDir();
	if (!existsSync(stateDir)) {
		mkdirSync(stateDir, { recursive: true });
	}

	db = new Database(join(stateDir, "talk_poll_state.db"));
	db.exec("PRAGMA journal_mode = WAL;");

	// Wasserstand pro Raum (Konzept §5.2 / D3). `last_polled_at` und
	// `consecutive_errors` sind für den Poller (S3: Status/Circuit-Breaker)
	// reserviert und werden von diesem gepflegt.
	db.exec(`
    CREATE TABLE IF NOT EXISTS talk_state (
      room_token       TEXT PRIMARY KEY,
      last_known_msg_id INTEGER NOT NULL DEFAULT 0,
      last_polled_at   INTEGER,
      consecutive_errors INTEGER DEFAULT 0,
      updated_at       INTEGER
    )
  `);

	logger.info("[TalkStateStore] Database initialized");
	return db;
}

/**
 * Close the database and release the singleton (daemon shutdown).
 *
 * Production counterpart of `resetTalkStateStore()`: call this from the
 * daemon's stop path so the WAL is checkpointed and the file handle is
 * released cleanly. Safe to call when the store was never initialized.
 */
export function shutdownTalkStateStore(): void {
	if (!db) return;
	try {
		db.close();
	} catch (err) {
		logger.warn("[TalkStateStore] Error closing database on shutdown:", err);
	}
	db = null;
	logger.info("[TalkStateStore] Database closed");
}

/**
 * Close and reset the in-memory singleton (test-only helper).
 *
 * Closes the underlying connection and clears the reference so the next
 * `initTalkStateStore(...)` call creates a brand-new database. Never call
 * this in production — production relies on a single long-lived handle and
 * uses `shutdownTalkStateStore()` instead.
 */
export function resetTalkStateStore(): void {
	if (!db) return;
	try {
		db.close();
	} catch (err) {
		logger.warn("[TalkStateStore] Error closing test DB:", err);
	}
	db = null;
}

/**
 * Get the persisted last-known message ID for a room.
 *
 * Returns 0 when the room has no stored state yet — the poller then starts
 * from the beginning of the room's history (Konzept §5.2 Trade-off).
 */
export function getLastKnownMessageId(roomToken: string): number {
	const database = initTalkStateStore();
	const row = database
		.prepare("SELECT last_known_msg_id FROM talk_state WHERE room_token = ?")
		.get(roomToken) as { last_known_msg_id: number } | undefined;
	return row ? row.last_known_msg_id : 0;
}

/**
 * Upsert the last-known message ID for a room.
 *
 * The poller calls this only AFTER a batch was fully and successfully
 * processed (at-least-once semantics — Konzept §5.2). High-frequency call:
 * intentionally unlogged.
 */
export function setLastKnownMessageId(roomToken: string, lastKnownMessageId: number): void {
	const database = initTalkStateStore();
	database
		.prepare(
			`
    INSERT INTO talk_state (room_token, last_known_msg_id, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(room_token) DO UPDATE SET
      last_known_msg_id = excluded.last_known_msg_id,
      updated_at = excluded.updated_at
  `,
		)
		.run(roomToken, lastKnownMessageId, Date.now());
}

/**
 * Load all stored watermarks at once (Warm-Start — Konzept §5.2).
 *
 * The poller reads this once at daemon start and continues each room from
 * its persisted offset: no reprocessing of already answered messages, no
 * skipping.
 */
export function getAllStates(): Record<string, number> {
	const database = initTalkStateStore();
	const rows = database
		.prepare("SELECT room_token, last_known_msg_id FROM talk_state")
		.all() as Array<{ room_token: string; last_known_msg_id: number }>;

	const states: Record<string, number> = {};
	for (const row of rows) {
		states[row.room_token] = row.last_known_msg_id;
	}
	return states;
}

/**
 * Remove stored state for rooms that are no longer configured
 * (Room-Refresh — Konzept §5.2). Returns the number of deleted rows.
 */
export function pruneRooms(roomTokens: string[]): number {
	if (roomTokens.length === 0) return 0;

	const database = initTalkStateStore();
	const placeholders = roomTokens.map(() => "?").join(", ");
	const result = database
		.prepare(`DELETE FROM talk_state WHERE room_token IN (${placeholders})`)
		.run(...roomTokens);

	if (result.changes > 0) {
		logger.info(`[TalkStateStore] Pruned ${result.changes} room state(s)`);
	}
	return result.changes;
}
