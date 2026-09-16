import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { buildRpcSpawnArgs } from "../../src/core/rpc.js";
import { DEFAULT_CONFIG, mergeGatewayConfig } from "../../src/config.js";
import type { GatewayConfig } from "../../src/types.js";

/**
 * rpc-persona (docs/rpc-persona.md §5.1) — unit tests for the spawn
 * args/options composition (buildRpcSpawnArgs) and the `rpc` config block
 * (merge validation, deep-merge defaults, graceful empty fields).
 */

const extensionPath = "/fake/dist/extensions/pi-gateway-ask-user-rpc.js";

describe("buildRpcSpawnArgs — rpc-persona (§4/§5.1)", () => {
	it("keeps today's behavior without an rpc config (no flags, no cwd)", () => {
		const { args, spawnOptions } = buildRpcSpawnArgs(extensionPath);
		assert.deepEqual(args, ["--mode", "rpc", "--extension", extensionPath]);
		assert.equal(spawnOptions.cwd, undefined);
	});

	it("keeps today's behavior with an all-empty rpc config (graceful)", () => {
		const { args, spawnOptions } = buildRpcSpawnArgs(extensionPath, {
			model: "",
			systemPrompt: "",
			cwd: "",
		});
		assert.deepEqual(args, ["--mode", "rpc", "--extension", extensionPath]);
		assert.equal(spawnOptions.cwd, undefined);
	});

	it("appends --model/--system-prompt flags and sets cwd when configured", () => {
		const { args, spawnOptions } = buildRpcSpawnArgs(extensionPath, {
			model: "provider/model-id",
			systemPrompt: "/tmp/prompt.md",
			cwd: "/home/user",
		});
		assert.deepEqual(args, [
			"--mode",
			"rpc",
			"--extension",
			extensionPath,
			"--model",
			"provider/model-id",
			"--system-prompt",
			"/tmp/prompt.md",
		]);
		assert.equal(spawnOptions.cwd, "/home/user");
	});

	it("handles partial configs: only model set → only the model flag", () => {
		const { args, spawnOptions } = buildRpcSpawnArgs(extensionPath, { model: "m" });
		assert.deepEqual(args, ["--mode", "rpc", "--extension", extensionPath, "--model", "m"]);
		assert.equal(spawnOptions.cwd, undefined);
	});

	it("defaults OLLAMA_HOST to localhost:11434 in the env", () => {
		const { spawnOptions } = buildRpcSpawnArgs(extensionPath);
		const env = spawnOptions.env as Record<string, string | undefined>;
		assert.equal(env.OLLAMA_HOST, "localhost:11434");
	});
});

describe("mergeGatewayConfig — rpc block (rpc-persona §3)", () => {
	const base = { host: "localhost", port: 3847, tokens: [] } as Record<string, unknown>;

	it("defaults the rpc block to empty strings (backward compatible)", () => {
		const merged = mergeGatewayConfig({ ...base } as GatewayConfig);
		assert.ok(merged.rpc, "rpc block should be present after merge");
		assert.equal(merged.rpc!.model, "");
		assert.equal(merged.rpc!.systemPrompt, "");
		assert.equal(merged.rpc!.cwd, "");
	});

	it("deep-merges a partial user block over the empty defaults", () => {
		const merged = mergeGatewayConfig({
			...base,
			rpc: { model: "provider/model-id" },
		} as GatewayConfig);
		assert.equal(merged.rpc!.model, "provider/model-id");
		// Untouched defaults survive the deep merge.
		assert.equal(merged.rpc!.systemPrompt, DEFAULT_CONFIG.rpc!.systemPrompt);
		assert.equal(merged.rpc!.cwd, DEFAULT_CONFIG.rpc!.cwd);
	});

	it("accepts rpc:null to remove the block", () => {
		const merged = mergeGatewayConfig({
			...base,
			rpc: null,
		} as unknown as GatewayConfig);
		assert.equal(merged.rpc, undefined);
	});

	it("rejects a non-object rpc value", () => {
		assert.throws(
			() => mergeGatewayConfig({ ...base, rpc: "oops" } as unknown as GatewayConfig),
			/config\.rpc/,
		);
	});

	it("rejects a non-string rpc field", () => {
		assert.throws(
			() =>
				mergeGatewayConfig({
					...base,
					rpc: { model: 123 },
				} as unknown as GatewayConfig),
			/config\.rpc\.model/,
		);
	});
});
