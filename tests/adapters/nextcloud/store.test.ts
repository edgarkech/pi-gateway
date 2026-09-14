/**
 * Unit tests for `src/adapters/nextcloud/store.ts` — Phase 4 S2.
 *
 * Covers (concept §12, line 610 — `talk_state` CRUD, Warm-Start-Load,
 * Room-Prune):
 *   1. CRUD — get of unknown room → 0, set (insert), set again (update),
 *      per-room independence.
 *   2. Warm-Start-Load — after a full re-init with a FRESH database
 *      connection all stored watermarks are still readable.
 *   3. Room-Prune — tokens that left the configuration are removed,
 *      remaining rooms keep their state.
 *
 * Isolation: every test gets a brand-new temp directory (dir argument of
 * `initTalkStateStore`) or the `GATEWAY_TALK_STATE_DIR` env var; the module
 * singleton is closed between tests via `resetTalkStateStore()`.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getAllStates,
	getLastKnownMessageId,
	initTalkStateStore,
	pruneRooms,
	resetTalkStateStore,
	setLastKnownMessageId,
	shutdownTalkStateStore,
} from "../../../src/adapters/nextcloud/store.js";

let tmpDir = "";

/** Fresh temp dir + re-init of the store singleton against it. */
function freshTalkStateStore(): void {
	resetTalkStateStore();
	tmpDir = mkdtempSync(join(tmpdir(), "pi-talk-state-"));
	initTalkStateStore(tmpDir);
}

beforeEach(() => {
	freshTalkStateStore();
});

afterEach(() => {
	resetTalkStateStore();
	if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	tmpDir = "";
});

// ── 1. Singleton & init ────────────────────────────────────────────────────

describe("talk state store singleton", () => {
	it("initializes a singleton Database (same instance on repeated calls)", () => {
		const first = initTalkStateStore();
		expect(first).toBeTruthy();
		expect(initTalkStateStore()).toBe(first);
	});

	it("creates the database file inside the given directory", () => {
		initTalkStateStore();
		expect(existsSync(join(tmpDir, "talk_poll_state.db"))).toBe(true);
	});

	it("honours GATEWAY_TALK_STATE_DIR when no dir argument is passed", () => {
		const envDir = mkdtempSync(join(tmpdir(), "pi-talk-state-env-"));
		try {
			process.env.GATEWAY_TALK_STATE_DIR = envDir;
			resetTalkStateStore();
			initTalkStateStore(); // no dir argument → env var must win

			expect(existsSync(join(envDir, "talk_poll_state.db"))).toBe(true);
			setLastKnownMessageId("env-room", 7);
			expect(getLastKnownMessageId("env-room")).toBe(7);
		} finally {
			delete process.env.GATEWAY_TALK_STATE_DIR;
			resetTalkStateStore();
			rmSync(envDir, { recursive: true, force: true });
		}
	});
});

// ── 2. CRUD (get / set / update) ───────────────────────────────────────────

describe("talk state CRUD", () => {
	it("returns 0 for a room without stored state", () => {
		expect(getLastKnownMessageId("unknown-room")).toBe(0);
	});

	it("stores and reads back a watermark (insert)", () => {
		setLastKnownMessageId("room-a", 42);
		expect(getLastKnownMessageId("room-a")).toBe(42);
	});

	it("updates an existing watermark in place (upsert, no duplicate row)", () => {
		setLastKnownMessageId("room-b", 10);
		setLastKnownMessageId("room-b", 99);

		expect(getLastKnownMessageId("room-b")).toBe(99);

		const db = initTalkStateStore();
		const count = db
			.prepare("SELECT COUNT(*) AS n FROM talk_state WHERE room_token = ?")
			.get("room-b") as { n: number };
		expect(count.n).toBe(1);
	});

	it("keeps watermarks of different rooms independent", () => {
		setLastKnownMessageId("room-1", 5);
		setLastKnownMessageId("room-2", 60);

		expect(getLastKnownMessageId("room-1")).toBe(5);
		expect(getLastKnownMessageId("room-2")).toBe(60);
	});
});

// ── 3. Warm-Start-Load ─────────────────────────────────────────────────────

describe("warm start load", () => {
	it("loads all stored watermarks via getAllStates", () => {
		setLastKnownMessageId("room-a", 1);
		setLastKnownMessageId("room-b", 2);
		setLastKnownMessageId("room-c", 3);

		expect(getAllStates()).toEqual({ "room-a": 1, "room-b": 2, "room-c": 3 });
	});

	it("returns an empty record on a fresh database", () => {
		expect(getAllStates()).toEqual({});
	});

	it("survives a full re-init with a fresh DB connection (warm start)", () => {
		setLastKnownMessageId("room-a", 123);
		setLastKnownMessageId("room-b", 456);

		// Simulate daemon restart: close the handle, open a brand-new
		// connection to the same file.
		resetTalkStateStore();
		initTalkStateStore(tmpDir);

		expect(getAllStates()).toEqual({ "room-a": 123, "room-b": 456 });
		expect(getLastKnownMessageId("room-a")).toBe(123);
		expect(getLastKnownMessageId("room-b")).toBe(456);
	});
});

// ── 4. Room-Prune ──────────────────────────────────────────────────────────

describe("room prune", () => {
	it("removes deconfigured rooms and keeps the remaining ones", () => {
		setLastKnownMessageId("keep-1", 10);
		setLastKnownMessageId("keep-2", 20);
		setLastKnownMessageId("gone-1", 30);

		const removed = pruneRooms(["gone-1"]);

		expect(removed).toBe(1);
		expect(getLastKnownMessageId("gone-1")).toBe(0); // pruned → unset
		expect(getLastKnownMessageId("keep-1")).toBe(10);
		expect(getLastKnownMessageId("keep-2")).toBe(20);
		expect(getAllStates()).toEqual({ "keep-1": 10, "keep-2": 20 });
	});

	it("removes several rooms at once", () => {
		setLastKnownMessageId("a", 1);
		setLastKnownMessageId("b", 2);
		setLastKnownMessageId("c", 3);

		expect(pruneRooms(["a", "c"])).toBe(2);
		expect(getAllStates()).toEqual({ b: 2 });
	});

	it("returns 0 for unknown tokens and does not throw", () => {
		setLastKnownMessageId("room-x", 5);
		expect(pruneRooms(["never-stored"])).toBe(0);
		expect(getLastKnownMessageId("room-x")).toBe(5); // untouched
	});

	it("returns 0 for an empty token list without touching the DB", () => {
		setLastKnownMessageId("room-y", 7);
		expect(pruneRooms([])).toBe(0);
		expect(getAllStates()).toEqual({ "room-y": 7 });
	});

	it("can prune every stored room", () => {
		setLastKnownMessageId("a", 1);
		setLastKnownMessageId("b", 2);

		expect(pruneRooms(["a", "b"])).toBe(2);
		expect(getAllStates()).toEqual({});
	});
});

// ── 5. Shutdown (production stop path) ─────────────────────────────────────

describe("shutdownTalkStateStore", () => {
	it("releases the singleton; a re-init opens a new handle on the same data", () => {
		const first = initTalkStateStore();
		setLastKnownMessageId("room-z", 55);

		shutdownTalkStateStore();
		const second = initTalkStateStore(tmpDir);

		expect(second).not.toBe(first); // fresh connection
		expect(getLastKnownMessageId("room-z")).toBe(55); // data persisted
	});

	it("is a no-op when the store was never initialized", () => {
		resetTalkStateStore();
		expect(() => shutdownTalkStateStore()).not.toThrow();
	});
});
