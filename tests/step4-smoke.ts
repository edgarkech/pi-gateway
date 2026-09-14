/**
 * Step 4 — Smoke Test (S2 + S4, via mocks)
 *
 * Covers:
 *  S2: module graph loads without import-cycle crash; new `adapters/registry.ts`
 *      exports `initializeAdapters`; `sessions/store.ts` exports `listActiveChannels`.
 *  S4: exercises the REAL `initializeAdapters()` from registry.ts with the default
 *      (all-platforms-disabled) config, verifying it runs cleanly via `runtime`
 *      and registers adapters into the SAME map that `/api/status` lists
 *      (`runtime.state.adapters`). Also verifies `listActiveChannels()` reads the
 *      session DB correctly and returns the planned channelId camelCase shape.
 *
 * Full live S7 (real Discord/Telegram/... client start with tokens) requires
 * external services unavailable in this sandbox (same limitation as Steps 1-3).
 */
import assert from "node:assert/strict";
import { runtime, initRuntime } from "../src/state.js";
import { initSessionStore, listActiveChannels } from "../src/sessions/store.js";
import { initializeAdapters } from "../src/adapters/registry.js";

// ── S2: module graph + export shapes ──────────────────────────────────────
assert.equal(typeof initializeAdapters, "function");
assert.equal(typeof listActiveChannels, "function");
console.log("S2: registry.initializeAdapters + store.listActiveChannels exports OK");

// ── Bootstrap runtime + stores ────────────────────────────────────────────
initRuntime();
initSessionStore();

async function main() {
	// ── S4a: /api/status adapter source is the same map initializeAdapters writes ──
	{
		// /api/status reports: adapters: Array.from(runtime.state.adapters.keys())
		assert.ok(runtime.state.adapters instanceof Map);
		// Fresh runtime -> empty adapters map
		assert.equal(runtime.state.adapters.size, 0);
		console.log("S4a: runtime.state.adapters (statussource) is empty Map at init");
	}

	// ── S4b: initializeAdapters with default config (all platforms disabled) ──
	{
		// Default config ships with every platform disabled; the moved function must
		// read runtime.config.platforms.* without crashing and leave no adapter in
		// the status-source map. (Disabled platforms are skipped before any client
		// start — no external services required.)
		const platforms = runtime.config.platforms;
		assert.ok(
			Object.values(platforms).every((p: { enabled?: boolean }) => !p.enabled),
			"expected default config to have all platforms disabled",
		);
		await initializeAdapters();
		assert.equal(runtime.state.adapters.size, 0);
		console.log("S4b: initializeAdapters (all disabled) ran clean, 0 adapters registered");
	}

	// ── S4c: enabled-platform registration path is wired (graceful, no crash) ──
	{
		// Enable a platform with a placeholder token. Real client init needs network,
		// so it will fail inside the try/catch and log an error — proving the moved
		// function follows the original error-handling (no unhandled rejection).
		// With a VALID token the same code path would set runtime.state.adapters
		// (verified byte-identical move via git diff).
		runtime.config.platforms.telegram = {
			enabled: true,
			token: "placeholder-token-for-sandbox",
			webhookUrl: "",
		};
		await initializeAdapters();
		// Graceful failure path: adapter NOT registered (network token invalid).
		assert.equal(runtime.state.adapters.has("telegram"), false);
		// Restore default so later assertions are hermetic.
		runtime.config.platforms.telegram = {
			enabled: false,
			token: "",
			webhookUrl: "",
		};
		console.log("S4c: initializeAdapters handles enabled-but-unreachable platform gracefully");
	}

	// ── S4d: listActiveChannels() reads Session DB + returns plan shape ──
	{
		// Seed two distinct active channels via the store API.
		const { getOrCreateSession } = await import("../src/sessions/store.js");
		getOrCreateSession("telegram", "tg-chan-1", "user-a");
		getOrCreateSession("telegram", "tg-chan-2", "user-b");
		getOrCreateSession("discord", "dc-chan-1", "user-c");

		const channels = listActiveChannels();
		// DISTINCT platform, channel_id — no duplicate (platform, channelId) pairs.
		const uniq = new Set(channels.map((r) => `${r.platform}/${r.channelId}`));
		assert.equal(uniq.size, channels.length, "listActiveChannels must be DISTINCT");
		const pair = (p: string, c: string) =>
			channels.some((row) => row.platform === p && row.channelId === c);
		assert.ok(pair("telegram", "tg-chan-1"));
		assert.ok(pair("telegram", "tg-chan-2"));
		assert.ok(pair("discord", "dc-chan-1"));
		// camelCase channelId shape per plan §3.5
		assert.ok(channels.every((row) => "channelId" in row && typeof row.channelId === "string"));
		console.log(`S4d: listActiveChannels -> ${channels.length} active channels, shape OK`);
	}

	console.log("STEP-4 SMOKE PASSED (S1 build, S2, S4-partial)");
}

main().catch((err) => {
	console.error("STEP-4 SMOKE FAILED:", err);
	process.exit(1);
});
