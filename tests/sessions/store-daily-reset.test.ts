/**
 * Unit tests for the daily-reset fix (docs/jsonl-session-labeling.md §3.5):
 *
 * The former reset check compared the hour-of-day of `last_activity` against
 * the current hour — but `last_activity` is refreshed on EVERY message, which
 * made the daily reset (resetPolicy=both, daily 01:00) practically
 * unreachable for active sessions (empirically belegt 2026-09-20: rows
 * unchanged since 17.09, stale `pi_session_file`, fresh `last_activity`).
 *
 * Fix: the reset boundary references `created_at` — a session resets on the
 * first message after the most recent dailyHour boundary crossed since the
 * session was created. Idle fallback (24h) unchanged.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	crossedDailyBoundary,
	getOrCreateSession,
	getSession,
	initSessionStore,
	resetSessionStore,
} from "../../src/sessions/store.js";
import { freshSessionStore } from "../helpers.js";

beforeEach(() => freshSessionStore());
afterEach(() => {
	resetSessionStore();
	vi.useRealTimers();
});

describe("crossedDailyBoundary (pure boundary math, deterministic dates)", () => {
	it("true when a boundary lies strictly between from and now", () => {
		// Created 19.09 10:00, now 20.09 08:00 → boundary 20.09 01:00 crossed.
		expect(crossedDailyBoundary(ts(19, 10), ts(20, 8), 1)).toBe(true);
	});

	it("false when created after the most recent boundary (same day)", () => {
		// Created 20.09 08:00, now 20.09 10:00 → no boundary crossed since.
		expect(crossedDailyBoundary(ts(20, 8), ts(20, 10), 1)).toBe(false);
	});

	it("false when created exactly at the boundary (strictly-between semantics)", () => {
		// Created exactly at 01:00 → must not reset on the same day.
		expect(crossedDailyBoundary(ts(20, 1), ts(20, 2), 1)).toBe(false);
	});

	it("true across multiple days (the 17.09 → 20.09 real-world case)", () => {
		expect(crossedDailyBoundary(ts(17, 14), ts(20, 11), 1)).toBe(true);
	});

	it("true when the boundary hour is crossed within the same day (created 00:30)", () => {
		// Created 20.09 00:30, now 20.09 02:00 → boundary 01:00 crossed.
		expect(crossedDailyBoundary(ts(20, 0, 30), ts(20, 2), 1)).toBe(true);
	});

	it("works for other dailyHour values", () => {
		// dailyHour=6: created 20.09 07:00 (after 06:00), now 21.09 08:00 → crossed.
		expect(crossedDailyBoundary(ts(20, 7), ts(21, 8), 6)).toBe(true);
		// created 20.09 05:00 (before 06:00), now 20.09 08:00 → crossed.
		expect(crossedDailyBoundary(ts(20, 5), ts(20, 8), 6)).toBe(true);
		// created 20.09 06:00 exactly, now 20.09 08:00 → not crossed.
		expect(crossedDailyBoundary(ts(20, 6), ts(20, 8), 6)).toBe(false);
	});
});

describe("daily reset via getOrCreateSession (fix §3.5)", () => {
	it("resets a session when a boundary crossed since creation (created_at reference)", () => {
		vi.useFakeTimers();
		vi.setSystemTime(at(19, 14));
		const s = getOrCreateSession("nextcloud", "room-daily", "u", {
			resetPolicy: "both",
			dailyHour: 1,
			idleMinutes: 1440,
		});

		// Next day, after the 01:00 boundary (idle timeout NOT reached).
		vi.setSystemTime(at(20, 11));
		const fresh = getOrCreateSession("nextcloud", "room-daily", "u", {
			resetPolicy: "both",
			dailyHour: 1,
			idleMinutes: 1440,
		});
		expect(fresh.id).not.toBe(s.id);
		expect(getSession(s.id)).toBeNull();
	});

	it("resets an ACTIVE session (fresh last_activity) — the §1.2.6 bug case", () => {
		vi.useFakeTimers();
		vi.setSystemTime(at(19, 14));
		const s = getOrCreateSession("nextcloud", "room-active", "u", {
			resetPolicy: "both",
			dailyHour: 1,
			idleMinutes: 1440,
		});

		// Session stays active all evening — last_activity refreshed per message.
		vi.setSystemTime(at(19, 20));
		getOrCreateSession("nextcloud", "room-active", "u");
		expect(getSession(s.id)).not.toBeNull();

		// Next morning after the 01:00 boundary: last_activity is only ~15h old
		// (idle fallback NOT reached), but the daily boundary crossed → reset.
		// The former implementation compared the hour-of-day of last_activity
		// and would have kept the row alive indefinitely.
		vi.setSystemTime(at(20, 11));
		const fresh = getOrCreateSession("nextcloud", "room-active", "u", {
			resetPolicy: "both",
			dailyHour: 1,
			idleMinutes: 1440,
		});
		expect(fresh.id).not.toBe(s.id);
		expect(getSession(s.id)).toBeNull();
	});

	it("does not reset a session created after today's boundary (same day)", () => {
		vi.useFakeTimers();
		vi.setSystemTime(at(20, 8));
		const s = getOrCreateSession("nextcloud", "room-same-day", "u", {
			resetPolicy: "both",
			dailyHour: 1,
			idleMinutes: 1440,
		});

		vi.setSystemTime(at(20, 10));
		const again = getOrCreateSession("nextcloud", "room-same-day", "u", {
			resetPolicy: "both",
			dailyHour: 1,
			idleMinutes: 1440,
		});
		expect(again.id).toBe(s.id);
		expect(getSession(s.id)).not.toBeNull();
	});

	it("drops the pi_session_file mapping when the daily reset deletes the row", () => {
		vi.useFakeTimers();
		vi.setSystemTime(at(19, 14));
		const s = getOrCreateSession("nextcloud", "room-mapping", "u", {
			resetPolicy: "both",
			dailyHour: 1,
			idleMinutes: 1440,
		});
		initSessionStore()
			.prepare("UPDATE sessions SET pi_session_file = ? WHERE id = ?")
			.run("2026-09-19T14-00-00-abc.jsonl", s.id);

		vi.setSystemTime(at(20, 11));
		const fresh = getOrCreateSession("nextcloud", "room-mapping", "u", {
			resetPolicy: "both",
			dailyHour: 1,
			idleMinutes: 1440,
		});
		expect(fresh.id).not.toBe(s.id);
		expect(fresh.piSessionFile).toBeUndefined();
	});
});

/** Local-time timestamp for day-of-month `day` (of the current month), hour, minute. */
function ts(day: number, hour: number, minute = 0): number {
	const d = new Date();
	d.setDate(day);
	d.setHours(hour, minute, 0, 0);
	return d.getTime();
}

/** Date object for day/hour/minute of the current month (local time) for fake timers. */
function at(day: number, hour: number): Date {
	const d = new Date();
	d.setDate(day);
	d.setHours(hour, 0, 0, 0);
	return d;
}
