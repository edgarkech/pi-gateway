/**
 * Unit tests for `src/security/auth.ts` — allowlist logic, DM pairing flow,
 * and rate limiting.
 *
 * Isolation: each test re-initializes the DB via `resetSecurityStore()` into a
 * fresh ephemeral store; the security config file is written per-test under the
 * isolated HOME scratch dir.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Config file always resolves to $HOME/.pi/gateway/config.json (isolated).
import { GATEWAY_CONFIG_FILE } from "../../src/paths.js";
import {
	addAdmin,
	addToAllowlist,
	approvePairingCode,
	checkRateLimit,
	cleanupExpiredCodes,
	generatePairingCode,
	initSecurityStore,
	isAdmin,
	isPlatform,
	isRateLimited,
	isUserAllowed,
	listAdmins,
	listAllowlistedUsers,
	listPendingPairingCodes,
	removeAdmin,
	resetSecurityStore,
	revokeUserAccess,
} from "../../src/security/auth.js";
import { freshSecurityStore } from "../helpers.js";

/** Persist a security config for the isolated HOME. */
async function writeSecurityConfig(config: unknown): Promise<void> {
	await writeFile(GATEWAY_CONFIG_FILE, JSON.stringify({ security: config }));
}

describe("isPlatform type guard", () => {
	it("accepts known platform literals", () => {
		for (const p of [
			"discord",
			"telegram",
			"slack",
			"whatsapp",
			"web",
			"websocket",
			"nextcloudTalk",
		]) {
			expect(isPlatform(p)).toBe(true);
		}
	});

	it("rejects unknown / malformed platform strings", () => {
		expect(isPlatform("twitch")).toBe(false);
		expect(isPlatform("")).toBe(false);
		expect(isPlatform("DISCORD")).toBe(false);
	});
});

describe("initSecurityStore / resetSecurityStore", () => {
	beforeEach(() => resetSecurityStore());
	afterEach(() => resetSecurityStore());

	it("returns a usable Database singleton", () => {
		const db = initSecurityStore();
		expect(db).toBeTruthy();
		// Singleton: repeated calls return the same instance.
		expect(initSecurityStore()).toBe(db);
	});

	it("reset clears the singleton so a fresh dir can be used", () => {
		const db1 = initSecurityStore();
		db1.prepare("INSERT INTO allowlist (platform, user_id, added_at) VALUES (?,?,?)").run(
			"discord",
			"u1",
			Date.now(),
		);

		resetSecurityStore();

		// Re-point to a brand-new temp directory → genuinely fresh database.
		const freshDb = initSecurityStore(mkdtempSync(join(tmpdir(), "pi-sec-reset-")));
		expect(freshDb).not.toBe(db1);
		const row = freshDb.prepare("SELECT COUNT(*) AS c FROM allowlist").get() as {
			c: number;
		};
		expect(row.c).toBe(0);
	});
});

describe("allowlist logic", () => {
	beforeEach(async () => {
		freshSecurityStore();
		await writeSecurityConfig({
			allowAll: false,
			requirePairing: false,
			allowedUids: {},
			adminUids: {},
			rateLimit: { maxRequests: 60, windowMs: 60000 },
		});
	});
	afterEach(() => resetSecurityStore());

	it("denies users not on the allowlist by default", () => {
		expect(isUserAllowed("discord", "alice")).toBe(false);
	});

	it("allows a user after addToAllowlist / approvePairing", () => {
		addToAllowlist("telegram", "bob", "manual");
		expect(isUserAllowed("telegram", "bob")).toBe(true);
	});

	it("scopes the allowlist per platform", () => {
		addToAllowlist("discord", "carol");
		expect(isUserAllowed("discord", "carol")).toBe(true);
		expect(isUserAllowed("slack", "carol")).toBe(false);
	});

	it("lists allowlisted users, optionally filtered by platform", () => {
		addToAllowlist("discord", "dave");
		addToAllowlist("telegram", "erin");
		expect(listAllowlistedUsers()).toHaveLength(2);
		expect(listAllowlistedUsers("discord")).toHaveLength(1);
		expect(listAllowlistedUsers("slack")).toHaveLength(0);
	});

	it("revokes a user's access", () => {
		addToAllowlist("whatsapp", "frank");
		expect(isUserAllowed("whatsapp", "frank")).toBe(true);
		expect(revokeUserAccess("whatsapp", "frank")).toBe(true);
		expect(isUserAllowed("whatsapp", "frank")).toBe(false);
		// Revoking a non-existent entry returns false.
		expect(revokeUserAccess("whatsapp", "nobody")).toBe(false);
	});

	it("honours allowAll in the config", async () => {
		await writeSecurityConfig({
			allowAll: true,
			requirePairing: false,
			allowedUids: {},
			adminUids: {},
			rateLimit: { maxRequests: 60, windowMs: 60000 },
		});
		expect(isUserAllowed("web", "anyone")).toBe(true);
	});

	it("honours platform-specific and wildcard allowedUids", async () => {
		await writeSecurityConfig({
			allowAll: false,
			requirePairing: false,
			allowedUids: { telegram: ["t-user"], "*": ["everyone"] },
			adminUids: {},
			rateLimit: { maxRequests: 60, windowMs: 60000 },
		});
		expect(isUserAllowed("telegram", "t-user")).toBe(true);
		expect(isUserAllowed("discord", "everyone")).toBe(true);
		expect(isUserAllowed("discord", "t-user")).toBe(false);
	});
});

describe("pairing-code flow", () => {
	beforeEach(async () => {
		freshSecurityStore();
		await writeSecurityConfig({
			allowAll: false,
			requirePairing: true,
			allowedUids: {},
			adminUids: {},
			rateLimit: { maxRequests: 60, windowMs: 60000 },
		});
	});
	afterEach(() => resetSecurityStore());

	it("generates an 8-character uppercase alphanumeric code", () => {
		const code = generatePairingCode("discord", "alice");
		expect(code).toMatch(/^[A-Z0-9]{8}$/);
	});

	it("tracks pending codes with an expiry window (~1h)", () => {
		const code = generatePairingCode("telegram", "bob");
		const pending = listPendingPairingCodes();
		expect(pending).toHaveLength(1);
		expect(pending[0].code).toBe(code);
		expect(pending[0].platform).toBe("telegram");
		expect(pending[0].userId).toBe("bob");
		// expiresIn should be just under 3600s.
		expect(pending[0].expiresIn).toBeGreaterThan(3500 * 1000);
		expect(pending[0].expiresIn).toBeLessThanOrEqual(3600 * 1000);
	});

	it("approving a code adds the user to the allowlist and marks it used", () => {
		const code = generatePairingCode("slack", "carol");
		expect(isUserAllowed("slack", "carol")).toBe(false);
		expect(approvePairingCode(code)).toBe(true);
		expect(isUserAllowed("slack", "carol")).toBe(true);
		// Code is now consumed — cannot be approved twice.
		expect(approvePairingCode(code)).toBe(false);
		expect(listPendingPairingCodes()).toHaveLength(0);
	});

	it("rejects approval of an unknown or malformed code", () => {
		expect(approvePairingCode("NOPE1234")).toBe(false);
		expect(approvePairingCode("")).toBe(false);
	});

	it("removes expired codes via cleanupExpiredCodes", () => {
		// Cheat: insert an already-expired code directly.
		const db = initSecurityStore();
		db.prepare(
			`INSERT INTO pairing_codes (code, platform, user_id, created_at, expires_at, used)
       VALUES ('EXPIRED1', 'web', 'ghost', ?, ?, 0)`,
		).run(Date.now() - 100000, Date.now() - 1000);

		generatePairingCode("web", "live");
		expect(listPendingPairingCodes()).toHaveLength(1); // only the live one is returned

		const removed = cleanupExpiredCodes();
		expect(removed).toBe(1);
		expect(listPendingPairingCodes()).toHaveLength(1);
	});
});

describe("rate limiting", () => {
	beforeEach(async () => {
		freshSecurityStore();
		await writeSecurityConfig({
			allowAll: false,
			requirePairing: false,
			allowedUids: {},
			adminUids: {},
			rateLimit: { maxRequests: 2, windowMs: 60000 },
		});
	});
	afterEach(() => resetSecurityStore());

	it("allows requests up to the configured threshold", () => {
		expect(checkRateLimit("id-1", 2, 60000)).toBe(true); // 1st
		expect(checkRateLimit("id-1", 2, 60000)).toBe(true); // 2nd
		expect(checkRateLimit("id-1", 2, 60000)).toBe(false); // block
	});

	it("tracks identifiers independently", () => {
		expect(checkRateLimit("a", 1, 60000)).toBe(true);
		expect(checkRateLimit("a", 1, 60000)).toBe(false);
		expect(checkRateLimit("b", 1, 60000)).toBe(true); // different identifier unaffected
	});

	it("resets the window after windowMs elapses", () => {
		// First request initiates a new window.
		expect(checkRateLimit("win", 1, 60000)).toBe(true);
		// Simulate time passing by writing an old window_start directly.
		const db = initSecurityStore();
		db.prepare("UPDATE rate_limits SET window_start = ? WHERE identifier = 'win'").run(
			Date.now() - 61000,
		);
		// Window expired → a fresh window begins, allowing the request again.
		expect(checkRateLimit("win", 1, 60000)).toBe(true);
	});

	it("exposes isRateLimited for platform:user identifiers (reads config)", () => {
		// Config maxRequests = 2.
		expect(isRateLimited("telegram", "alice")).toBe(false); // 1st
		expect(isRateLimited("telegram", "alice")).toBe(false); // 2nd
		expect(isRateLimited("telegram", "alice")).toBe(true); // blocked
	});
});

describe("admin role management", () => {
	beforeEach(async () => {
		freshSecurityStore();
		await writeSecurityConfig({
			allowAll: false,
			requirePairing: false,
			allowedUids: {},
			adminUids: { discord: ["root"] },
			rateLimit: { maxRequests: 60, windowMs: 60000 },
		});
	});
	afterEach(() => resetSecurityStore());

	it("recognizes admins from the config (platform-scoped)", () => {
		expect(isAdmin("discord", "root")).toBe(true);
		// Root is NOT a wildcard admin — only scoped to discord.
		expect(isAdmin("*", "root")).toBe(false);
		expect(isAdmin("telegram", "root")).toBe(false); // scoped to discord
	});

	it("adds a wildcard admin and removes it", () => {
		addAdmin("*", "super");
		expect(isAdmin("discord", "super")).toBe(true);
		expect(isAdmin("slack", "super")).toBe(true);

		expect(removeAdmin("*", "super")).toBe(true);
		expect(isAdmin("discord", "super")).toBe(false);
		expect(removeAdmin("*", "ghost")).toBe(false);
	});

	it("lists admin entries", () => {
		addAdmin("discord", "d1");
		addAdmin("telegram", "t1");
		addAdmin("*", "global");
		const rows = listAdmins();
		// includes the 3 just added
		expect(rows.length).toBe(3);
		expect(rows.some((r) => r.platform === "discord" && r.userId === "d1")).toBe(true);
	});
});
