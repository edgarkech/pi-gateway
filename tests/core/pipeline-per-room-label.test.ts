/**
 * Unit tests for the per-room session-ensure flow (docs/session-per-room.md §5,
 * docs/jsonl-session-labeling.md §3):
 *
 * 1. Unmapped room → new_session + set_session_name + mapping written (§3.2/§3.6).
 * 2. Label enforcement on switch/resume — set_session_name is idempotent and
 *    must also fire for KNOWN rooms (the former implementation only labeled
 *    new sessions; jsonl-session-labeling.md §1.1/§3.1).
 * 3. Self-healing when the mapped file is gone: pi does NOT fail on a missing
 *    switch target (SessionManager.open silently opens an unlabeled fresh
 *    session whose filename inherits the stale path's timestamp — §1.2.1),
 *    so the pipeline must NEVER switch to a missing file (§3.2) and must
 *    re-map when pi lands on a different file (§3.2).
 * 4. Switch failure → fresh-session fallback (existing behavior preserved).
 * 5. perRoom=false → legacy path without any session RPC.
 *
 * Methodik (wie `anti-loop-edge.test.ts`): ECHT message-pipeline + store;
 * MOCKED ausschließlich die Agent-RPC-Schicht (`src/core/rpc.js`).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { adapterCallbacks } from "../../src/core/message-pipeline.js";
import { runtime, initRuntime } from "../../src/state.js";
import { GATEWAY_CONFIG_FILE } from "../../src/paths.js";
import { getOrCreateSession, setPiSessionFile } from "../../src/sessions/store.js";
import { freshSecurityStore, freshSessionStore } from "../helpers.js";
import type { PlatformMessage } from "../../src/adapters/base.js";

// ── Mock der Agent-RPC-Schicht (einziger gemockter Layer) ───────────────────

const rpcMock = vi.hoisted(() => ({
	agentRunning: true,
	responseText: "Standardantwort vom Agenten.",
	newSessionCalls: 0,
	switchCalls: [] as string[],
	setNameCalls: [] as string[],
	newSessionResult: {
		sessionFile: null as string | null,
		sessionId: "uuid-new" as string | null,
		sessionName: null as string | null,
	},
	getStateResult: {
		sessionFile: null as string | null,
		sessionId: "uuid-state" as string | null,
		sessionName: null as string | null,
	},
	switchThrows: false,
}));

vi.mock("../../src/core/rpc.js", () => ({
	isAgentRunning: () => rpcMock.agentRunning,
	sendPromptRpc: async () => rpcMock.responseText,
	sendRpc: async () => ({ success: true }),
	startRpc: () => {
		throw new Error("startRpc ist in Tests nicht verfügbar");
	},
	stopRpc: () => {},
	restartRpc: () => {},
	peekActiveCompletion: () => null,
	resetActiveStream: () => {},
	// Der Mock spiegelt das Verhalten des echten newPiSession (setzt den Namen
	// intern via set_session_name) inkl. Logging-relevanten Rückgaben.
	newPiSession: async (name?: string) => {
		rpcMock.newSessionCalls += 1;
		if (name) rpcMock.setNameCalls.push(name);
		return { ...rpcMock.newSessionResult };
	},
	switchPiSession: async (sessionPath: string) => {
		if (rpcMock.switchThrows) throw new Error("switch failed");
		rpcMock.switchCalls.push(sessionPath);
		return {};
	},
	getPiState: async () => ({ ...rpcMock.getStateResult }),
	setPiSessionName: async (name: string) => {
		rpcMock.setNameCalls.push(name);
	},
}));

// ── Config-Setup (wie pipeline-nextcloud.test.ts, mit perRoom) ──────────────

const HERE = dirname(new URL(import.meta.url).pathname);
const DEFAULT_CONFIG_PATH = join(HERE, "..", "..", "config", "config.default.json");
const BASE_CONFIG = JSON.parse(readFileSync(DEFAULT_CONFIG_PATH, "utf8")) as Record<
	string,
	unknown
>;

function writeConfig(perRoom: boolean): void {
	const baseSessions = (BASE_CONFIG.sessions ?? {}) as Record<string, unknown>;
	const config: Record<string, unknown> = {
		...BASE_CONFIG,
		sessions: { ...baseSessions, perRoom },
		security: {
			allowAll: false,
			requirePairing: false,
			allowedUids: { "*": ["tester"] },
			adminUids: {},
			rateLimit: { maxRequests: 60, windowMs: 60_000 },
		},
	};
	mkdirSync(dirname(GATEWAY_CONFIG_FILE), { recursive: true });
	writeFileSync(GATEWAY_CONFIG_FILE, JSON.stringify(config, null, 2));
}

// ── Fake-Adapter (telegram — Pipeline ist plattformagnostisch) ──────────────

const fakeAdapter = {
	sendMessage: vi.fn(async () => `fake-msg-${Math.random()}`),
	editMessage: vi.fn(async () => {}),
	setTyping: vi.fn(async () => {}),
};

function makeMessage(channelId: string): PlatformMessage {
	return {
		id: `m-${channelId}-${Date.now()}`,
		platform: "telegram",
		channelId,
		userId: "tester",
		content: "Hallo",
		timestamp: Date.now(),
	};
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

let tmpDir = "";

beforeAll(() => {
	writeConfig(true);
	initRuntime();
});

beforeEach(() => {
	writeConfig(true);
	freshSecurityStore();
	freshSessionStore();
	runtime.state.sessions.clear();
	runtime.state.adapters.set("telegram", fakeAdapter as never);
	runtime.config.sessions.perRoom = true;
	rpcMock.newSessionCalls = 0;
	rpcMock.switchCalls = [];
	rpcMock.setNameCalls = [];
	rpcMock.switchThrows = false;
	rpcMock.newSessionResult = {
		sessionFile: null,
		sessionId: "uuid-new",
		sessionName: null,
	};
	rpcMock.getStateResult = {
		sessionFile: null,
		sessionId: "uuid-state",
		sessionName: null,
	};
	tmpDir = mkdtempSync(join(tmpdir(), "gateway-perroom-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("per-room session-ensure flow (jsonl-session-labeling.md §3)", () => {
	it("creates a labeled new session for an unmapped room (first message)", async () => {
		const file = join(tmpDir, "2026-09-20T12-00-00-new.jsonl");
		rpcMock.newSessionResult = { sessionFile: file, sessionId: "uuid-n1", sessionName: null };

		await adapterCallbacks.onMessage(makeMessage("room-1"));

		expect(rpcMock.newSessionCalls).toBe(1);
		expect(rpcMock.switchCalls).toHaveLength(0);
		expect(rpcMock.setNameCalls).toEqual(["gateway:telegram:room-1"]);

		const stored = getOrCreateSession("telegram", "room-1", "tester");
		expect(stored.piSessionFile).toBe(file);
	});

	it("switches to a mapped, labeled session without touching the label", async () => {
		const file = join(tmpDir, "mapped.jsonl");
		writeFileSync(file, "{}");
		const s = getOrCreateSession("telegram", "room-2", "tester");
		setPiSessionFile(s.id, file);
		rpcMock.getStateResult = {
			sessionFile: file,
			sessionId: "uuid-s2",
			sessionName: "gateway:telegram:room-2",
		};

		await adapterCallbacks.onMessage(makeMessage("room-2"));

		expect(rpcMock.switchCalls).toEqual([file]);
		expect(rpcMock.newSessionCalls).toBe(0);
		expect(rpcMock.setNameCalls).toHaveLength(0);

		const again = getOrCreateSession("telegram", "room-2", "tester");
		expect(again.piSessionFile).toBe(file);
	});

	it("re-labels a resumed, unlabeled session (§3.1: label im switch/resume-Zweig)", async () => {
		const file = join(tmpDir, "unlabeled.jsonl");
		writeFileSync(file, "{}");
		const s = getOrCreateSession("telegram", "room-3", "tester");
		setPiSessionFile(s.id, file);
		rpcMock.getStateResult = { sessionFile: file, sessionId: "uuid-s3", sessionName: null };

		await adapterCallbacks.onMessage(makeMessage("room-3"));

		expect(rpcMock.switchCalls).toEqual([file]);
		expect(rpcMock.newSessionCalls).toBe(0);
		expect(rpcMock.setNameCalls).toEqual(["gateway:telegram:room-3"]);
	});

	it("creates a fresh labeled session when the mapped file is gone (§3.2: nie auf fehlende Datei switchen)", async () => {
		const stale = join(tmpDir, "2026-09-17T12-14-22-stale.jsonl"); // hart gelöscht — existiert nie
		const fresh = join(tmpDir, "2026-09-20T11-30-00-fresh.jsonl");
		const s = getOrCreateSession("telegram", "room-4", "tester");
		setPiSessionFile(s.id, stale);
		rpcMock.newSessionResult = { sessionFile: fresh, sessionId: "uuid-s4", sessionName: null };

		await adapterCallbacks.onMessage(makeMessage("room-4"));

		expect(rpcMock.switchCalls).toHaveLength(0);
		expect(rpcMock.newSessionCalls).toBe(1);
		expect(rpcMock.setNameCalls).toEqual(["gateway:telegram:room-4"]);

		const again = getOrCreateSession("telegram", "room-4", "tester");
		expect(again.piSessionFile).toBe(fresh);
	});

	it("re-maps and labels when pi lands on a different file than requested (self-heal)", async () => {
		const mapped = join(tmpDir, "requested.jsonl");
		writeFileSync(mapped, "{}");
		const actual = join(tmpDir, "2026-09-17T12-14-22-inherited.jsonl");
		const s = getOrCreateSession("telegram", "room-5", "tester");
		setPiSessionFile(s.id, mapped);
		rpcMock.getStateResult = {
			sessionFile: actual,
			sessionId: "uuid-s5",
			sessionName: null,
		};

		await adapterCallbacks.onMessage(makeMessage("room-5"));

		expect(rpcMock.switchCalls).toEqual([mapped]);
		expect(rpcMock.setNameCalls).toEqual(["gateway:telegram:room-5"]);

		const again = getOrCreateSession("telegram", "room-5", "tester");
		expect(again.piSessionFile).toBe(actual);
	});

	it("falls back to a fresh labeled session when the switch itself fails", async () => {
		const mapped = join(tmpDir, "broken.jsonl");
		writeFileSync(mapped, "{}");
		const fresh = join(tmpDir, "2026-09-20T11-40-00-fallback.jsonl");
		const s = getOrCreateSession("telegram", "room-7", "tester");
		setPiSessionFile(s.id, mapped);
		rpcMock.switchThrows = true;
		rpcMock.newSessionResult = { sessionFile: fresh, sessionId: "uuid-s7", sessionName: null };

		await adapterCallbacks.onMessage(makeMessage("room-7"));

		expect(rpcMock.switchCalls).toHaveLength(0);
		expect(rpcMock.newSessionCalls).toBe(1);

		const again = getOrCreateSession("telegram", "room-7", "tester");
		expect(again.piSessionFile).toBe(fresh);
	});

	it("does not touch pi sessions when perRoom is off (legacy path unchanged)", async () => {
		runtime.config.sessions.perRoom = false;

		await adapterCallbacks.onMessage(makeMessage("room-6"));

		expect(rpcMock.newSessionCalls).toBe(0);
		expect(rpcMock.switchCalls).toHaveLength(0);
		expect(rpcMock.setNameCalls).toHaveLength(0);
	});
});
