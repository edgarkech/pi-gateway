/**
 * Unit tests for the Session-per-Room store mapping (docs/session-per-room.md
 * §4) — `pi_session_file` column, additive migration on pre-existing
 * databases, and the reset interaction (row deleted → mapping gone → fresh
 * pi session on the next message).
 */

import Database from "better-sqlite3";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";

import { beforeEach, afterEach, describe, expect, it } from "vitest";

import {
	getOrCreateSession,
	initSessionStore,
	resetSessionStore,
	setPiSessionFile,
} from "../../src/sessions/store.js";
import { freshSessionStore } from "../helpers.js";

beforeEach(() => freshSessionStore());
afterEach(() => resetSessionStore());

describe("pi_session_file mapping (session-per-room §4)", () => {
	it("creates sessions without a mapping and accepts setPiSessionFile", () => {
		const session = getOrCreateSession("nextcloud", "room-1", "user-1");
		expect(session.piSessionFile).toBeUndefined();

		setPiSessionFile(session.id, "2026-09-18T10-00-00-abc.jsonl");

		const refreshed = getOrCreateSession("nextcloud", "room-1", "user-1");
		expect(refreshed.id).toBe(session.id);
		expect(refreshed.piSessionFile).toBe("2026-09-18T10-00-00-abc.jsonl");
	});

	it("persists the mapping across independent lookups (get by platform/channel)", () => {
		const s1 = getOrCreateSession("telegram", "chat-9", "user-9");
		setPiSessionFile(s1.id, "mapped-file.jsonl");

		const s2 = getOrCreateSession("telegram", "chat-9", "user-9");
		expect(s2.id).toBe(s1.id);
		expect(s2.piSessionFile).toBe("mapped-file.jsonl");
	});

	it("drops the mapping when the row is reset (daily/idle) — next message gets a fresh pi session", () => {
		const s1 = getOrCreateSession("nextcloud", "room-reset", "user-1");
		setPiSessionFile(s1.id, "old-file.jsonl");

		// Age the session deterministically beyond the idle timeout (1440 min).
		const db = initSessionStore();
		db.prepare("UPDATE sessions SET last_activity = ? WHERE id = ?").run(
			Date.now() - 25 * 60 * 60 * 1000, // 25 h ago > 24 h idle timeout
			s1.id,
		);

		// Next message: getOrCreateSession detects the idle timeout, deletes the
		// row and creates a fresh session — piSessionFile must be undefined.
		const s2 = getOrCreateSession("nextcloud", "room-reset", "user-1");
		expect(s2.id).not.toBe(s1.id);
		expect(s2.piSessionFile).toBeUndefined();
	});

	it("migrates a pre-existing database without the column (additive ALTER TABLE)", () => {
		// Build a legacy database with the pre-per-room schema.
		const dir = mkdtempSync(join(tmpdir(), "gateway-legacy-"));
		try {
			const legacy = new Database(join(dir, "gateway-sessions.db"));
			legacy.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          platform TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          reset_policy TEXT NOT NULL DEFAULT 'idle',
          daily_hour INTEGER NOT NULL DEFAULT 4,
          idle_minutes INTEGER NOT NULL DEFAULT 1440,
          last_activity INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          is_background INTEGER NOT NULL DEFAULT 0,
          parent_session_id TEXT
        )
      `);
			legacy
				.prepare(
					`INSERT INTO sessions (id, platform, channel_id, user_id, reset_policy, daily_hour, idle_minutes, last_activity, created_at, is_background)
         VALUES ('legacy-1', 'nextcloud', 'room-legacy', 'user-1', 'idle', 4, 1440, ?, ?, 0)`,
				)
				.run(Date.now(), Date.now());
			legacy.close();

			// Point the store at the legacy dir — init must add the column
			// idempotently without losing the existing row. Reset first: the
			// singleton is already initialized from the beforeEach hook.
			resetSessionStore();
			const db = initSessionStore(dir);
			const cols = db.pragma("table_info(sessions)") as Array<{ name: string }>;
			expect(cols.some((c) => c.name === "pi_session_file")).toBe(true);

			const row = db.prepare("SELECT * FROM sessions WHERE id = 'legacy-1'").get() as {
				id: string;
				pi_session_file: string | null;
			};
			expect(row.id).toBe("legacy-1");
			expect(row.pi_session_file).toBeNull();

			// Mapping can now be written for the migrated row.
			setPiSessionFile("legacy-1", "migrated.jsonl");
			const updated = db
				.prepare("SELECT pi_session_file FROM sessions WHERE id = 'legacy-1'")
				.get() as { pi_session_file: string };
			expect(updated.pi_session_file).toBe("migrated.jsonl");
		} finally {
			resetSessionStore();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
