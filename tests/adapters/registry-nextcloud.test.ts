/**
 * Phase 4 (S5) — registry-wiring tests for the Nextcloud Talk adapter.
 *
 * Covers:
 *  - the default config ships a DISABLED nextcloudTalk block, so
 *    `initializeAdapters()` skips it (no adapter registered);
 *  - an enabled-but-unreachable Nextcloud fails gracefully (N1): the channel
 *    stays disabled, no unhandled rejection, no adapter in the status map;
 *  - a reachable (fake) OCS server completes the full wiring path:
 *    `initialize()` (listRooms auth probe) → `start()` (poller + talk state
 *    store) → registered in `runtime.state.adapters` → clean `stop()`.
 *
 * No real Nextcloud is needed: a minimal local HTTP server emulates the two
 * OCS endpoints used at startup (`GET /room`, `GET /chat/{token}` → 304).
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, it } from "vitest";

import { runtime, initRuntime } from "../../src/state.js";
import { initializeAdapters } from "../../src/adapters/registry.js";

initRuntime();

/** Minimal fake Nextcloud: OCS room list + chat long-poll (304 = nothing new). */
function startFakeNextcloud(): Promise<{ server: Server; baseUrl: string }> {
	return new Promise((resolve) => {
		const server = createServer((req, res) => {
			const url = req.url ?? "";
			if (url.startsWith("/ocs/v2.php/apps/spreed/api/v4/room")) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						ocs: { meta: { statuscode: 100, status: "OK", message: "OK" }, data: [] },
					}),
				);
				return;
			}
			if (url.startsWith("/ocs/v2.php/apps/spreed/api/v1/chat/")) {
				// Long-poll answer: nothing new → 304 (concept §5.1).
				res.writeHead(304);
				res.end();
				return;
			}
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					ocs: {
						meta: { statuscode: 999, status: "NotFound", message: "Not found" },
						data: null,
					},
				}),
			);
		});
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
		});
	});
}

let fake: { server: Server; baseUrl: string } | null = null;

beforeAll(async () => {
	fake = await startFakeNextcloud();
});

afterAll(async () => {
	if (fake) {
		fake.server.closeAllConnections?.();
		await new Promise<void>((resolve) => fake!.server.close(() => resolve()));
	}
});

describe("initializeAdapters — nextcloudTalk wiring (Phase 4 S5)", () => {
	it("skips the talk adapter when the block is disabled (default config)", async () => {
		const talk = runtime.config.platforms.nextcloudTalk;
		assert.ok(talk, "default config must ship the nextcloudTalk template block");
		assert.equal(talk!.enabled, false);

		await initializeAdapters();
		assert.equal(runtime.state.adapters.has("nextcloudTalk"), false);
	});

	it("handles an enabled-but-unreachable Nextcloud gracefully (N1: no throw, no registration)", async () => {
		runtime.config.platforms.nextcloudTalk = {
			enabled: true,
			baseUrl: "https://127.0.0.1:9", // closed port → fast connection refused
			userId: "pi-bot",
			appToken: "test-token",
			rooms: ["room-1"],
			pollMode: "interval",
			intervalMs: 50,
		};
		try {
			await initializeAdapters(); // must resolve (error is caught + logged)
			assert.equal(runtime.state.adapters.has("nextcloudTalk"), false);
		} finally {
			runtime.config.platforms.nextcloudTalk = {
				...runtime.config.platforms.nextcloudTalk,
				enabled: false,
			};
		}
	});

	it("registers the talk adapter against a reachable OCS server and stops it cleanly", async () => {
		assert.ok(fake, "fake Nextcloud must be running");
		runtime.config.platforms.nextcloudTalk = {
			enabled: true,
			baseUrl: fake.baseUrl,
			userId: "pi-bot",
			appToken: "test-token",
			rooms: ["room-1"],
			allowInsecureHttp: true, // local test server speaks plain http
			pollMode: "interval",
			intervalMs: 50,
			minPollIntervalMs: 10,
		};
		let adapter;
		try {
			await initializeAdapters();
			assert.equal(runtime.state.adapters.has("nextcloudTalk"), true);
			adapter = runtime.state.adapters.get("nextcloudTalk");
			assert.ok(adapter, "talk adapter must be registered in the status-source map");

			const status = await adapter.getStatus();
			assert.equal(status.connected, true);

			// Clean stop: poller stops and the talk state store closes via
			// adapter.stop() (default store) — the daemon-level
			// shutdownTalkStateStore() would be a no-op afterwards.
			await adapter.stop();
			const after = await adapter.getStatus();
			assert.equal(after.connected, false);
		} finally {
			runtime.state.adapters.clear();
			runtime.config.platforms.nextcloudTalk = {
				...runtime.config.platforms.nextcloudTalk,
				enabled: false,
			};
		}
	});
});
