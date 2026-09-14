/**
 * Unit tests for `src/sessions/store.ts` — session CRUD, reset/expiration logic,
 * and background-session handling.
 *
 * Isolation: `resetSessionStore()` (test helper) re-points the store to a fresh
 * ephemeral database via the `GATEWAY_DB_DIR` variable already set by setup.ts.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
	cleanupStaleSessions,
	createBackgroundSession,
	deleteSession,
	generateSessionId,
	getOrCreateSession,
	getPendingBackgroundResults,
	getSession,
	initSessionStore,
	listActiveChannels,
	listSessions,
	resetSessionStore,
	touchSession,
} from "../../src/sessions/store.js";
import { freshSessionStore } from "../helpers.js";

describe("session store singleton", () => {
	beforeEach(() => freshSessionStore());
	afterEach(() => resetSessionStore());

	it("initializes a singleton Database", () => {
		const db = initSessionStore();
		expect(db).toBeTruthy();
		expect(initSessionStore()).toBe(db);
	});

	it("generateSessionId produces unique prefixed ids", () => {
		const a = generateSessionId();
		const b = generateSessionId();
		expect(a).toMatch(/^sess-/);
		expect(a).not.toBe(b);
	});
});

describe("session creation and retrieval", () => {
	beforeEach(() => freshSessionStore());
	afterEach(() => resetSessionStore());

	it("creates and retrieves a session", () => {
		const session = getOrCreateSession("discord", "chan-1", "user-1");
		expect(session.id).toMatch(/^sess-/);
		expect(session.platform).toBe("discord");
		expect(session.channelId).toBe("chan-1");
		expect(session.userId).toBe("user-1");
		expect(session.isBackground).toBe(false);

		const fetched = getSession(session.id);
		expect(fetched).toEqual(session);
	});

	it("reuses an existing active session for the same channel", () => {
		const first = getOrCreateSession("telegram", "chat-9", "u9");
		const second = getOrCreateSession("telegram", "chat-9", "u9");
		expect(second.id).toBe(first.id); // no duplicate session
	});

	it("creates a distinct session for a different channel on the same platform", () => {
		const a = getOrCreateSession("slack", "c-a", "u");
		const b = getOrCreateSession("slack", "c-b", "u");
		expect(a.id).not.toBe(b.id);
	});

	it("lists sessions and can filter by platform", () => {
		getOrCreateSession("discord", "d1", "u");
		getOrCreateSession("discord", "d2", "u");
		getOrCreateSession("telegram", "t1", "u");

		expect(listSessions()).toHaveLength(3);
		expect(listSessions("discord")).toHaveLength(2);
		expect(listSessions("whatsapp")).toHaveLength(0);
	});

	it("returns null for an unknown session id", () => {
		expect(getSession("does-not-exist")).toBeNull();
	});

	it("deletes a session", () => {
		const s = getOrCreateSession("web", "chanX", "u");
		deleteSession(s.id);
		expect(getSession(s.id)).toBeNull();
	});
});

describe("session updates and touch", () => {
	beforeEach(() => freshSessionStore());
	afterEach(() => resetSessionStore());

	it("touchSession updates lastActivity", async () => {
		const s = getOrCreateSession("discord", "chan", "u");
		const original = s.lastActivity;

		// Workaround: simulate passage of time by writing an earlier last_activity.
		const db = initSessionStore();
		const earlier = original - 5000;
		db.prepare("UPDATE sessions SET last_activity = ? WHERE id = ?").run(earlier, s.id);

		touchSession(s.id);
		const updated = getSession(s.id);
		expect(updated).toBeTruthy();
		expect(updated!.lastActivity).toBeGreaterThan(earlier);
	});

	it("reusing an active session refreshes its lastActivity", () => {
		const s = getOrCreateSession("telegram", "ch", "u");
		const db = initSessionStore();
		db.prepare("UPDATE sessions SET last_activity = ? WHERE id = ?").run(
			Date.now() - 20000,
			s.id,
		);

		// Reuse — should bump last_activity, not create a new session.
		const before = Date.now();
		const gained = getOrCreateSession("telegram", "ch", "u");
		expect(gained.id).toBe(s.id);
		expect(gained.lastActivity).toBeGreaterThanOrEqual(before - 1);
	});
});

describe("session expiration / reset logic", () => {
	beforeEach(() => freshSessionStore());
	afterEach(() => resetSessionStore());

	it("resets an idle session once idleMinutes have passed", () => {
		const db = initSessionStore();
		const s = getOrCreateSession("discord", "ch", "u", {
			resetPolicy: "idle",
			idleMinutes: 1,
		});

		// Stale activity older than the 1-minute idle window.
		const stale = Date.now() - 1000 * 60 * 2;
		db.prepare("UPDATE sessions SET last_activity = ? WHERE id = ?").run(stale, s.id);

		// Next access must produce a brand-new session (old one reset).
		const fresh = getOrCreateSession("discord", "ch", "u", {
			resetPolicy: "idle",
			idleMinutes: 1,
		});
		expect(fresh.id).not.toBe(s.id);
		expect(getSession(s.id)).toBeNull(); // old session removed
	});

	it("keeps a session when still within the idle window", () => {
		const db = initSessionStore();
		const s = getOrCreateSession("discord", "ch", "u", {
			resetPolicy: "idle",
			idleMinutes: 30,
		});

		// Only 1 minute old — well within the 30-minute window.
		db.prepare("UPDATE sessions SET last_activity = ? WHERE id = ?").run(
			Date.now() - 1000 * 60,
			s.id,
		);
		const again = getOrCreateSession("discord", "ch", "u", {
			resetPolicy: "idle",
			idleMinutes: 30,
		});
		expect(again.id).toBe(s.id);
	});

	it("applies custom session config on creation", () => {
		const s = getOrCreateSession("telegram", "ch", "u", {
			resetPolicy: "daily",
			dailyHour: 6,
			idleMinutes: 90,
		});
		expect(s.resetPolicy).toBe("daily");
		expect(s.dailyHour).toBe(6);
		expect(s.idleMinutes).toBe(90);
	});
});

describe("background sessions", () => {
	beforeEach(() => freshSessionStore());
	afterEach(() => resetSessionStore());

	it("creates a background session linked to a parent", () => {
		const parent = getOrCreateSession("discord", "ch", "u");
		const bg = createBackgroundSession("discord", "ch", "u", parent.id);

		expect(bg.isBackground).toBe(true);
		expect(bg.parentSessionId).toBe(parent.id);
		expect(getSession(bg.id)?.isBackground).toBe(true);
	});

	it("lists pending background results", () => {
		const parent = getOrCreateSession("discord", "ch", "u");
		createBackgroundSession("discord", "ch", "u", parent.id);
		const pending = getPendingBackgroundResults();
		expect(pending).toHaveLength(1);
		expect(pending[0].isBackground).toBe(true);
	});

	it("excludes foreground sessions from background results and listSessions", () => {
		const parent = getOrCreateSession("discord", "ch", "u");
		createBackgroundSession("discord", "ch", "u", parent.id);

		expect(listSessions()).toHaveLength(1); // only the foreground session
		expect(getPendingBackgroundResults()).toHaveLength(1);
	});
});

describe("listActiveChannels and stale cleanup", () => {
	beforeEach(() => freshSessionStore());
	afterEach(() => resetSessionStore());

	it("listActiveChannels returns distinct foreground channels", () => {
		getOrCreateSession("discord", "ch-1", "u");
		getOrCreateSession("discord", "ch-1", "v"); // same channel, distinct user
		getOrCreateSession("telegram", "tg-1", "u");

		const channels = listActiveChannels();
		expect(channels).toHaveLength(2);
		expect(channels).toContainEqual({ platform: "discord", channelId: "ch-1" });
		expect(channels).toContainEqual({ platform: "telegram", channelId: "tg-1" });
	});

	it("cleanupStaleSessions removes sessions older than 7 days", () => {
		const db = initSessionStore();
		const fresh = getOrCreateSession("discord", "fresh", "u");
		const stale = getOrCreateSession("discord", "stale", "u");

		// Mark the second as 8 days old.
		db.prepare("UPDATE sessions SET last_activity = ? WHERE id = ?").run(
			Date.now() - 8 * 24 * 60 * 60 * 1000,
			stale.id,
		);

		const removed = cleanupStaleSessions();
		expect(removed).toBe(1);
		expect(getSession(stale.id)).toBeNull();
		expect(getSession(fresh.id)).not.toBeNull();
	});
});
