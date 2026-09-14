/**
 * Unit tests for the gateway tool policy system.
 *
 * Note: the milestone brief asked for `src/core/tools.ts`, but the policy
 * enforcement logic (`buildPolicyGuard`, `isToolAllowed`, `getEffectivePolicySummary`)
 * actually lives in `src/security/tool-policy.ts` (`src/core/tools.ts` only
 * registers the five gateway pi-tools). These tests cover the real policy engine.
 *
 * Isolation: per-file ephemeral DB via `GATEWAY_DB_DIR`; config (adminUids) is
 * written per-test under the isolated HOME.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { GATEWAY_CONFIG_FILE } from "../../src/paths.js";
import { resetSecurityStore } from "../../src/security/auth.js";
import {
	buildPolicyGuard,
	getEffectivePolicySummary,
	isToolAllowed,
	listToolPolicies,
	removeToolPolicy,
	resetToolPolicies,
	setToolPolicy,
} from "../../src/security/tool-policy.js";
import { freshSecurityStore } from "../helpers.js";

async function writeSecurityConfig(config: Record<string, unknown>): Promise<void> {
	await writeFile(GATEWAY_CONFIG_FILE, JSON.stringify({ security: config }));
}

const externalUserConfig = {
	allowAll: false,
	requirePairing: false,
	allowedUids: {},
	adminUids: {},
	rateLimit: { maxRequests: 60, windowMs: 60000 },
};

const adminConfig = {
	...externalUserConfig,
	adminUids: { telegram: ["admin-user"] },
};

describe("isToolAllowed — default policy", () => {
	beforeEach(async () => {
		freshSecurityStore();
		await writeSecurityConfig(externalUserConfig);
	});
	afterEach(() => resetSecurityStore());

	it("allows read-only tools by default", () => {
		expect(isToolAllowed("discord", "anyone", "read")).toBe(true);
		expect(isToolAllowed("discord", "anyone", "web_search")).toBe(true);
		expect(isToolAllowed("discord", "anyone", "fffind")).toBe(true);
	});

	it("denies state-changing tools by default", () => {
		expect(isToolAllowed("discord", "anyone", "bash")).toBe(false);
		expect(isToolAllowed("discord", "anyone", "write")).toBe(false);
		expect(isToolAllowed("discord", "anyone", "edit")).toBe(false);
		expect(isToolAllowed("discord", "anyone", "subagent")).toBe(false);
	});

	it("always allows gateway_* management tools", () => {
		expect(isToolAllowed("discord", "anyone", "gateway_status")).toBe(true);
		expect(isToolAllowed("discord", "anyone", "gateway_sessions")).toBe(true);
		expect(isToolAllowed("discord", "anyone", "gateway_tool_policy")).toBe(true);
	});

	it("denies unknown tools that match no policy", () => {
		expect(isToolAllowed("discord", "anyone", "totally_unknown_tool")).toBe(false);
	});

	it("denies wiki_* globs", () => {
		expect(isToolAllowed("discord", "anyone", "wiki_read")).toBe(false);
		expect(isToolAllowed("discord", "anyone", "wiki_write")).toBe(false);
	});
});

describe("isToolAllowed — explicit policies", () => {
	beforeEach(async () => {
		freshSecurityStore();
		await writeSecurityConfig(externalUserConfig);
	});
	afterEach(() => resetSecurityStore());

	it("a user-specific allow overrides the global default deny", () => {
		setToolPolicy({
			platform: "discord",
			userId: "charlie",
			toolName: "bash",
			action: "allow",
		});
		expect(isToolAllowed("discord", "charlie", "bash")).toBe(true);
		// Other users still denied.
		expect(isToolAllowed("discord", "dave", "bash")).toBe(false);
	});

	it("a deny policy wins over a lower-priority allow for the same tool", () => {
		// Global allows read (priority 0); user-specific deny should override.
		setToolPolicy({
			platform: null,
			userId: null,
			toolName: "read",
			action: "allow",
			priority: 100,
		});
		setToolPolicy({
			platform: "discord",
			userId: "mallory",
			toolName: "read",
			action: "deny",
			priority: 50,
		});
		expect(isToolAllowed("discord", "mallory", "read")).toBe(false);
	});

	it("specificity beats priority: user-specific wins over platform-specific", () => {
		setToolPolicy({ platform: "discord", userId: null, toolName: "bash", action: "deny" });
		setToolPolicy({
			platform: "discord",
			userId: "bob",
			toolName: "bash",
			action: "allow",
			priority: 10,
		});
		expect(isToolAllowed("discord", "bob", "bash")).toBe(true);
		expect(isToolAllowed("discord", "alice", "bash")).toBe(false);
	});

	it("lists and removes explicit policies", () => {
		setToolPolicy({ platform: "telegram", userId: "t1", toolName: "bash", action: "allow" });
		const listed = listToolPolicies("telegram", "t1");
		expect(listed).toHaveLength(1);
		expect(listed[0].toolName).toBe("bash");
		expect(listed[0].action).toBe("allow");

		expect(removeToolPolicy(listed[0].id!)).toBe(true);
		expect(listToolPolicies("telegram", "t1")).toHaveLength(0);
		expect(removeToolPolicy(99999)).toBe(false);
	});

	it("resets all explicit policies back to defaults", () => {
		setToolPolicy({ platform: "discord", userId: "u", toolName: "bash", action: "allow" });
		expect(isToolAllowed("discord", "u", "bash")).toBe(true);

		resetToolPolicies();
		expect(isToolAllowed("discord", "u", "bash")).toBe(false); // back to global deny
		expect(listToolPolicies()).toHaveLength(0);
	});
});

describe("admin bypass", () => {
	beforeEach(async () => {
		freshSecurityStore();
		await writeSecurityConfig(adminConfig);
	});
	afterEach(() => resetSecurityStore());

	it("admins bypass all tool restrictions", () => {
		expect(isToolAllowed("telegram", "admin-user", "bash")).toBe(true);
		expect(isToolAllowed("telegram", "admin-user", "write")).toBe(true);
	});
});

describe("buildPolicyGuard", () => {
	beforeEach(async () => {
		freshSecurityStore();
		await writeSecurityConfig(externalUserConfig);
	});
	afterEach(() => resetSecurityStore());

	it("produces a hard-policy directive for external users", () => {
		const guard = buildPolicyGuard("discord", "someone");
		expect(guard).toContain("SYSTEM DIRECTIVE");
		expect(guard).toContain(`EXTERNAL user on discord (user ID: someone)`);
		expect(guard).toContain("ALLOWED tools:");
		expect(guard).toContain("BLOCKED tools:");
		expect(guard).toContain("You MUST NOT call any BLOCKED tool.");
		// read-only tools must appear in the allowed list.
		expect(guard).toContain("read");
		// state-changing tools must appear in the blocked list.
		expect(guard).toContain("bash");
		expect(guard).toContain("write");
	});

	it("produces a full-access directive for admins", async () => {
		await writeSecurityConfig(adminConfig);
		const guard = buildPolicyGuard("telegram", "admin-user");
		expect(guard).toContain("ADMIN USER — FULL ACCESS");
		expect(guard).toContain("full administrative privileges");
		expect(guard).not.toContain("BLOCKED tools:");
	});
});

describe("getEffectivePolicySummary", () => {
	beforeEach(async () => {
		freshSecurityStore();
		await writeSecurityConfig(externalUserConfig);
	});
	afterEach(() => resetSecurityStore());

	it("reports allowed and denied tool lists", () => {
		const summary = getEffectivePolicySummary("discord", "someone");
		expect(summary.allowed).toContain("read");
		expect(summary.allowed).toContain("gateway_*");
		expect(summary.denied).toContain("bash");
		expect(summary.denied).toContain("write");
		expect(summary.allowed).not.toContain("bash");
	});
});
