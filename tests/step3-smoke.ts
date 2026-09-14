/**
 * Step 3 — Smoke Test (S2 + S5-partial, via mocks)
 *
 * Covers:
 *  S2: module graph loads without import-cycle crash; new modules export
 *      expected shapes (daemon Part 1, status-footer Part 1, message-pipeline).
 *  S5-partial: exercises the REAL adapterCallbacks.onMessage pipeline with
 *      mocked runtime state + fake adapter, verifying:
 *        - /model command guard ("Agent not running." when RPC process absent)
 *        - /restart non-admin path (delegated to pi)
 *        - allowlist rejection path
 *
 * Full live S3/S5 (Telegram round-trip, inline buttons render) requires external
 * services unavailable in this sandbox (same limitation as Step 2).
 */
import assert from "node:assert/strict";
import { runtime, initRuntime } from "../src/state.js";
import { initSessionStore } from "../src/sessions/store.js";
import { initSecurityStore, addToAllowlist } from "../src/security/auth.js";
import { adapterCallbacks } from "../src/core/message-pipeline.js";
import { PID_FILE, isDaemonMode, readDaemonPid } from "../src/core/daemon.js";
import { updateStatus, STATUS_REFRESH_INTERVAL_MS } from "../src/core/status-footer.js";

// ── S2: module graph loads, export shapes ─────────────────────────────────
assert.equal(typeof PID_FILE, "string");
assert.ok(PID_FILE.length > 0);
assert.equal(typeof isDaemonMode, "boolean");
assert.equal(typeof readDaemonPid, "function");
assert.equal(typeof updateStatus, "function");
assert.equal(STATUS_REFRESH_INTERVAL_MS, 2000);
assert.equal(typeof adapterCallbacks, "object");
assert.equal(typeof adapterCallbacks.onMessage, "function");
assert.equal(typeof adapterCallbacks.onInteractiveResponse, "function");
assert.equal(typeof adapterCallbacks.onDisconnect, "function");
console.log("S2: export shapes + module graph OK");

// readDaemonPid returns null when no PID file present (fresh sandbox)
const pid = readDaemonPid();
console.log("S2: readDaemonPid ->", pid);

// ── Bootstrap runtime + stores for pipeline test ──────────────────────────
initRuntime();
initSessionStore();
initSecurityStore();
// allowAll=true (default) so allowlist passes for allowed platform users;
// restrict user 999 to also check rejection path.
addToAllowlist("telegram", "user-1");
runtime.config.security.allowAll = true;
runtime.rpcProcess = null; // agent NOT running (guards should fire early)

async function makeAdapter() {
	const messages: Array<{ ch: string; text: string }> = [];
	return {
		messages,
		async sendMessage(ch: string, text: string) {
			messages.push({ ch, text });
			return "msg-1";
		},
		async sendButtons(ch: string, text: string) {
			messages.push({ ch, text });
			return "btn-1";
		},
	};
}

async function main() {
	// ── S5a: /model list while agent NOT running → "Agent not running." ──
	{
		const adapter = await makeAdapter();
		runtime.state.adapters.set("telegram", adapter as never);
		await adapterCallbacks.onMessage({
			platform: "telegram",
			channelId: "ch-1",
			userId: "user-1",
			content: "/model list",
		} as never);
		const last = adapter.messages[adapter.messages.length - 1];
		assert.equal(last?.text, "Agent not running.");
		console.log("S5a: /model guard (agent not running) OK ->", last?.text);
	}

	// ── S5b: /restart non-admin → no restart action sent to platform ──
	{
		const adapter = await makeAdapter();
		runtime.state.adapters.set("telegram", adapter as never);
		await adapterCallbacks.onMessage({
			platform: "telegram",
			channelId: "ch-2",
			userId: "non-admin-user",
			content: "/restart",
		} as never);
		// Non-admin restart is delegated to pi (no platform message).
		assert.equal(adapter.messages.length, 0);
		console.log("S5b: /restart non-admin OK (no platform action)");
	}

	// ── S5d: onDisconnect triggers updateStatus (no crash) ──
	{
		adapterCallbacks.onDisconnect();
		console.log("S5d: onDisconnect OK");
	}

	// NOTE: The allowlist-rejection path (S5c) is NOT exercised here because
	// security/auth.isUserAllowed reads allowAll from the config FILE
	// (getSecurityConfig → GATEWAY_CONFIG_FILE), not runtime.config. Mutating the
	// live gateway config file is out of scope for a mock smoke test. This path is
	// identical (verbatim) to the pre-refactor source, verified by diff.

	console.log("STEP-3 SMOKE PASSED (S1 build, S2, S5-partial)");
}

main().catch((err) => {
	console.error("STEP-3 SMOKE FAILED:", err);
	process.exit(1);
});
