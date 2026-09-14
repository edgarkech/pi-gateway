/**
 * Security Layer - Hermes-style allowlists and DM pairing
 *
 * Features:
 * - Per-platform user allowlists
 * - DM pairing flow with one-time codes
 * - Rate limiting
 * - Token authentication for gateway access
 */

import Database from "better-sqlite3";
import { join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { randomBytes } from "node:crypto";
import { logger } from "../logger.js";
import { GATEWAY_CONFIG_FILE } from "../paths.js";

// ── Database path resolution ────────────────────────────────────
//
// Test Isolation:
// The module owns a process-wide singleton `db`. To prevent tests from
// corrupting production data (or each other), the database root directory
// can be overridden — either via the `GATEWAY_DB_DIR` environment variable
// or programmatically through `initSecurityStore(dir?)` / `resetSecurityStore()`.

/** Resolve the directory that holds the security database file. */
function resolveGatewayDir(): string {
	return process.env.GATEWAY_DB_DIR || join(homedir(), ".pi", "gateway");
}

export type Platform =
	"discord" | "telegram" | "slack" | "whatsapp" | "web" | "websocket" | "nextcloudTalk";

/** All valid platform literals, used by the isPlatform type guard. */
const PLATFORM_VALUES: readonly Platform[] = [
	"discord",
	"telegram",
	"slack",
	"whatsapp",
	"web",
	"websocket",
	"nextcloudTalk",
];

/** Type guard: narrow an arbitrary string to a known Platform. */
export function isPlatform(value: string): value is Platform {
	return (PLATFORM_VALUES as readonly string[]).includes(value);
}

interface AllowlistEntry {
	platform: Platform;
	userId: string;
	addedAt: number;
	note?: string;
}

interface AdminEntry {
	platform: Platform | "*";
	userId: string;
	addedAt: number;
	note?: string;
}

interface RateLimitEntry {
	identifier: string;
	count: number;
	window_start: number;
}

// ── Database row shapes ─────────────────────────────────────────
// better-sqlite3 returns rows keyed by the literal SQL column names (snake_case).
// These mirror the camelCase interfaces above so `SELECT *` results can be
// mapped correctly.

interface AllowlistRow {
	platform: string;
	user_id: string;
	added_at: number;
	note: string | null;
}

interface AdminRow {
	platform: string;
	user_id: string;
	added_at: number;
	note: string | null;
}

interface PairingCodeRow {
	code: string;
	platform: string;
	user_id: string;
	created_at: number;
	expires_at: number;
	used: number;
}

let db: Database.Database | null = null;

/**
 * Initialize security database.
 *
 * Resolves the database directory from (in priority order):
 *   1. the optional `dir` argument (programmatic override — used by tests),
 *   2. the `GATEWAY_DB_DIR` environment variable,
 *   3. the default `~/.pi/gateway` directory.
 *
 * The database path is only fixed ONCE per process. Subsequent calls return
 * the existing singleton. Use `resetSecurityStore()` (tests only) to switch
 * to a fresh database.
 */
export function initSecurityStore(dir?: string): Database.Database {
	if (db) return db;

	const gatewayDir = dir || resolveGatewayDir();
	if (!existsSync(gatewayDir)) {
		mkdirSync(gatewayDir, { recursive: true });
	}

	db = new Database(join(gatewayDir, "gateway-security.db"));
	db.exec("PRAGMA journal_mode = WAL;");

	// Allowlist table
	db.exec(`
    CREATE TABLE IF NOT EXISTS allowlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      user_id TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      note TEXT
    )
  `);
	db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_allowlist ON allowlist(platform, user_id)`);

	// Pairing codes table
	db.exec(`
    CREATE TABLE IF NOT EXISTS pairing_codes (
      code TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    )
  `);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_pairing_expires ON pairing_codes(expires_at)`);

	// Rate limiting table
	db.exec(`
    CREATE TABLE IF NOT EXISTS rate_limits (
      identifier TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 1,
      window_start INTEGER NOT NULL
    )
  `);

	// Admin table
	db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL DEFAULT '*',
      user_id TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      note TEXT
    )
  `);
	db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_admins ON admins(platform, user_id)`);

	logger.info("[Security] Database initialized");
	return db;
}

/**
 * Close and reset the in-memory singleton (test-only helper).
 *
 * Closes the underlying connection and clears the reference so the next
 * `initSecurityStore(...)` call creates a brand-new database. Never call
 * this in production — production relies on a single long-lived handle.
 */
export function resetSecurityStore(): void {
	if (db) {
		try {
			db.close();
		} catch (err) {
			logger.warn("[Security] Error closing test DB:", err);
		}
		db = null;
	}
}

/**
 * Generate pairing code
 */
export function generatePairingCode(platform: Platform, userId: string): string {
	const database = initSecurityStore();

	// 8-character uppercase alphanumeric code, free of ambiguous symbols
	// (no '-'/'_' like base64url) so users can type it reliably.
	const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
	const bytes = randomBytes(8);
	let code = "";
	for (let i = 0; i < 8; i++) {
		code += ALPHABET[bytes[i] % ALPHABET.length];
	}
	const now = Date.now();
	const expiresAt = now + 60 * 60 * 1000; // 1 hour

	database
		.prepare(
			`
		INSERT INTO pairing_codes (code, platform, user_id, created_at, expires_at, used)
		VALUES (?, ?, ?, ?, ?, 0)
	`,
		)
		.run(code, platform, userId, now, expiresAt);

	logger.info(`[Security] Generated pairing code ${code} for ${platform}/${userId}`);
	return code;
}

/**
 * Approve pairing code
 */
export function approvePairingCode(code: string): boolean {
	const database = initSecurityStore();

	const entry = database
		.prepare(
			`
		SELECT * FROM pairing_codes WHERE code = ? AND used = 0 AND expires_at > ?
	`,
		)
		.get(code, Date.now()) as PairingCodeRow | undefined;

	if (!entry) {
		logger.info(`[Security] Pairing code ${code} not found or expired`);
		return false;
	}

	// Add to allowlist
	database
		.prepare(
			`
		INSERT OR IGNORE INTO allowlist (platform, user_id, added_at)
		VALUES (?, ?, ?)
	`,
		)
		.run(entry.platform, entry.user_id, Date.now());

	// Mark code as used
	database.prepare("UPDATE pairing_codes SET used = 1 WHERE code = ?").run(code);

	logger.info(`[Security] Approved pairing: ${entry.platform}/${entry.user_id}`);
	return true;
}

/**
 * List pending pairing codes
 */
export function listPendingPairingCodes(): Array<{
	code: string;
	platform: Platform;
	userId: string;
	createdAt: number;
	expiresIn: number;
}> {
	const database = initSecurityStore();
	const now = Date.now();

	const rows = database
		.prepare(
			`
		SELECT * FROM pairing_codes WHERE used = 0 AND expires_at > ?
		ORDER BY created_at ASC
	`,
		)
		.all(now) as PairingCodeRow[];

	return rows.map((row) => ({
		code: row.code,
		platform: row.platform as Platform,
		userId: row.user_id,
		createdAt: row.created_at,
		expiresIn: Math.max(0, row.expires_at - now),
	}));
}

/**
 * Revoke user access
 */
export function revokeUserAccess(platform: Platform, userId: string): boolean {
	const database = initSecurityStore();
	const result = database
		.prepare("DELETE FROM allowlist WHERE platform = ? AND user_id = ?")
		.run(platform, userId);
	return result.changes > 0;
}

/**
 * Check if user is allowed
 */
export function isUserAllowed(platform: Platform, userId: string): boolean {
	const database = initSecurityStore();

	// Check global allow all first
	const config = getSecurityConfig();
	if (config.allowAll) return true;

	// Check config-based allowedUids (cross-platform wildcard or platform-specific)
	if (config.allowedUids) {
		const platformUids = config.allowedUids[platform];
		if (platformUids?.includes(userId)) return true;
		const wildcardUids = config.allowedUids["*"];
		if (wildcardUids?.includes(userId)) return true;
	}

	// Check specific allowlist
	const entry = database
		.prepare(
			`
		SELECT 1 FROM allowlist WHERE platform = ? AND user_id = ?
	`,
		)
		.get(platform, userId);

	return !!entry;
}

/**
 * Add user to allowlist
 */
export function addToAllowlist(platform: Platform, userId: string, note?: string): void {
	const database = initSecurityStore();
	database
		.prepare(
			`
		INSERT OR REPLACE INTO allowlist (platform, user_id, added_at, note)
		VALUES (?, ?, ?, ?)
	`,
		)
		.run(platform, userId, Date.now(), note ?? null);
}

/**
 * List allowlisted users
 */
export function listAllowlistedUsers(platform?: Platform): AllowlistEntry[] {
	const database = initSecurityStore();

	const query = platform
		? "SELECT * FROM allowlist WHERE platform = ? ORDER BY added_at DESC"
		: "SELECT * FROM allowlist ORDER BY platform, added_at DESC";

	const rows = platform
		? (database.prepare(query).all(platform) as AllowlistRow[])
		: (database.prepare(query).all() as AllowlistRow[]);

	return rows.map((row) => ({
		platform: row.platform as Platform,
		userId: row.user_id,
		addedAt: row.added_at,
		note: row.note ?? undefined,
	}));
}

/**
 * Rate limiting
 */
export function checkRateLimit(
	identifier: string,
	maxRequests: number = 60,
	windowMs: number = 60000,
): boolean {
	const database = initSecurityStore();
	const now = Date.now();

	const entry = database
		.prepare(
			`
		SELECT * FROM rate_limits WHERE identifier = ?
	`,
		)
		.get(identifier) as RateLimitEntry | undefined;

	if (!entry || now - entry.window_start > windowMs) {
		// New window
		database
			.prepare(
				`
			INSERT OR REPLACE INTO rate_limits (identifier, count, window_start)
			VALUES (?, 1, ?)
		`,
			)
			.run(identifier, now);
		return true;
	}

	if (entry.count >= maxRequests) {
		logger.warn(`[Security] Rate limit exceeded for ${identifier}`);
		return false;
	}

	// Increment counter
	database
		.prepare(
			`
		UPDATE rate_limits SET count = count + 1 WHERE identifier = ?
	`,
		)
		.run(identifier);

	return true;
}

/**
 * Check whether a user has exceeded the configured rate limit.
 *
 * Encapsulates the security config and delegates to `checkRateLimit()`.
 * Returns `true` when the request is rate-limited (i.e. the user should
 * be blocked), `false` when they may continue.
 *
 * @param platform - The messaging platform the message arrived on.
 * @param userId - The id of the user who sent the message.
 */
export function isRateLimited(platform: Platform, userId: string): boolean {
	const config = getSecurityConfig();
	const identifier = `${platform}:${userId}`;
	const allowed = checkRateLimit(
		identifier,
		config.rateLimit?.maxRequests ?? 60,
		config.rateLimit?.windowMs ?? 60000,
	);
	return !allowed;
}

/**
 * Check whether the gateway requires users to complete a pairing flow
 * before they are allowed access.
 *
 * Returns the value of `requirePairing` from the current security config.
 */
export function isPairingRequired(): boolean {
	return getSecurityConfig().requirePairing ?? false;
}

/**
 * Clean up expired pairing codes
 */
export function cleanupExpiredCodes(): number {
	const database = initSecurityStore();
	const result = database
		.prepare("DELETE FROM pairing_codes WHERE expires_at < ?")
		.run(Date.now());
	return result.changes;
}

// Shared with index.ts — reads from the single gateway config file.
// Schema: the `security` block inside ~/.pi/gateway/config.json
export interface SecurityConfig {
	allowAll: boolean;
	requirePairing: boolean;
	allowedUids: Record<string, string[]>;
	adminUids: Record<string, string[]>;
	rateLimit: {
		maxRequests: number;
		windowMs: number;
	};
}

function getSecurityConfig(): SecurityConfig {
	try {
		if (existsSync(GATEWAY_CONFIG_FILE)) {
			const raw = JSON.parse(readFileSync(GATEWAY_CONFIG_FILE, "utf-8"));
			if (raw.security) return raw.security as SecurityConfig;
		}
	} catch (err) {
		logger.error("[Security] Failed to parse config — using defaults. Error:", err);
	}
	return {
		allowAll: false,
		requirePairing: false,
		allowedUids: {},
		adminUids: {},
		rateLimit: { maxRequests: 60, windowMs: 60000 },
	};
}

// ── Admin Role Management ─────────────────────────────────────────

/**
 * Check if a user has admin privileges.
 * Looks at both DB admins table and config adminUids.
 */
export function isAdmin(platform: Platform | string, userId: string): boolean {
	const database = initSecurityStore();
	const config = getSecurityConfig();

	// Check config-based adminUids (cross-platform wildcard or platform-specific)
	if (config.adminUids) {
		const platformUids = config.adminUids[platform];
		if (platformUids?.includes(userId)) return true;
		const wildcardUids = config.adminUids["*"];
		if (wildcardUids?.includes(userId)) return true;
	}

	// Check DB admins (platform-specific or wildcard)
	const entry = database
		.prepare(`SELECT 1 FROM admins WHERE (platform = ? OR platform = '*') AND user_id = ?`)
		.get(platform, userId);

	return !!entry;
}

/** Add a user as admin. Platform "*" means admin on all platforms. */
export function addAdmin(platform: Platform | "*", userId: string, note?: string): void {
	const database = initSecurityStore();
	database
		.prepare(
			`INSERT OR REPLACE INTO admins (platform, user_id, added_at, note)
       VALUES (?, ?, ?, ?)`,
		)
		.run(platform, userId, Date.now(), note ?? null);
	logger.info(`[Security] Admin added: ${platform}:${userId}`);
}

/** Remove admin privileges from a user. Returns true if removed. */
export function removeAdmin(platform: Platform | "*", userId: string): boolean {
	const database = initSecurityStore();
	const result = database
		.prepare("DELETE FROM admins WHERE platform = ? AND user_id = ?")
		.run(platform, userId);
	if (result.changes > 0) {
		logger.info(`[Security] Admin removed: ${platform}:${userId}`);
	}
	return result.changes > 0;
}

/** List all admin entries. */
export function listAdmins(): AdminEntry[] {
	const database = initSecurityStore();
	const rows = database
		.prepare("SELECT * FROM admins ORDER BY platform, user_id")
		.all() as AdminRow[];
	return rows.map((row) => ({
		platform: row.platform as Platform | "*",
		userId: row.user_id,
		addedAt: row.added_at,
		note: row.note ?? undefined,
	}));
}
