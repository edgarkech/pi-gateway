import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { fetchGatewayHealth, normalizeGatewayHealthConfig } from "./status.js";
import { GATEWAY_CONFIG_DIR, GATEWAY_CONFIG_FILE, getPackageRoot } from "./paths.js";
import { logger } from "./logger.js";
import type { GatewayConfig, MediaConfig } from "./types.js";
import { runtime } from "./state.js";

const DEFAULT_CONFIG: GatewayConfig = {
	port: 3847,
	host: "localhost",
	tokens: [],
	corsOrigins: ["*"],
	enableWebSocket: true,
	enableHttp: true,
	security: {
		allowAll: true,
		requirePairing: false,
		allowedUids: {},
		adminUids: {},
		rateLimit: { maxRequests: 60, windowMs: 60000 },
	},
	sessions: {
		resetPolicy: "idle",
		dailyHour: 4,
		idleMinutes: 1440,
	},
	promptTimeoutMs: 300000, // 5 minutes — override to increase for slow models
	media: {
		enabled: true,
		rootDir: "~/.pi/runtime/media",
		maxFileSizeBytes: 20_480_000, // Telegram bot limit (§10)
		maxImageBytes: 5_242_880, // 5 MB base64 cap (§10)
		maxTotalBytes: 536_870_912, // 512 MB store quota (§10)
		retentionHours: 24,
		sweepIntervalMinutes: 30,
		maxAttachmentsPerMessage: 4,
		allowedKinds: ["image", "document", "audio", "video"],
		allowedMimeTypes: [], // empty = built-in defaults (§10.1)
	},
	platforms: {
		// Phase 4 (Nextcloud Talk, concept §10): disabled by default — the
		// seeded template ships empty credentials. Strict validation applies
		// only when enabled (see mergeGatewayConfig below).
		nextcloudTalk: {
			enabled: false,
			baseUrl: "",
			userId: "",
			appToken: "",
			rooms: [],
			pollMode: "long-poll",
			longPollTimeoutSeconds: 30,
			intervalMs: 5000,
			minPollIntervalMs: 1000,
			backoffMaxMs: 60_000,
			maxConcurrentPolls: 4,
			circuitThreshold: 5,
			autoDiscoverRooms: false,
			roomRefreshIntervalMs: 60_000,
			allowInsecureHttp: false,
			// Default = media.maxAttachmentsPerMessage (inheritance is applied
			// in mergeGatewayConfig when the user does not set it explicitly).
			maxAttachmentsPerMessage: 4,
		},
	},
};

// Load/save config
function mergeGatewayConfig(value: unknown): GatewayConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Gateway config must be a JSON object");
	}
	const parsed = value as Partial<GatewayConfig>;
	const healthConfig = normalizeGatewayHealthConfig(parsed);
	if (!healthConfig) throw new Error("Invalid gateway host, port, or tokens");
	if (
		parsed.security === null ||
		(parsed.security !== undefined &&
			(typeof parsed.security !== "object" || Array.isArray(parsed.security)))
	) {
		throw new Error("config.security must be an object");
	}
	if (
		parsed.sessions === null ||
		(parsed.sessions !== undefined &&
			(typeof parsed.sessions !== "object" || Array.isArray(parsed.sessions)))
	) {
		throw new Error("config.sessions must be an object");
	}

	const security: Partial<GatewayConfig["security"]> = parsed.security ?? {};
	const sessions: Partial<GatewayConfig["sessions"]> = parsed.sessions ?? {};
	const rateLimit: Partial<GatewayConfig["security"]["rateLimit"]> = security.rateLimit ?? {};
	const media: Partial<MediaConfig> | null = parsed.media === null ? null : (parsed.media ?? {});
	if (
		parsed.media !== undefined &&
		parsed.media !== null &&
		(typeof parsed.media !== "object" || Array.isArray(parsed.media))
	) {
		throw new Error("config.media must be an object");
	}
	// Phase 4 (S5): deep-merge the optional nextcloudTalk block (concept §10) —
	// a partial user block must not wipe the polling defaults. `null` removes
	// the block entirely (same convention as media).
	const parsedPlatforms = (parsed.platforms ?? {}) as Partial<GatewayConfig["platforms"]>;
	const parsedTalk = parsedPlatforms.nextcloudTalk;
	if (
		parsedTalk !== undefined &&
		parsedTalk !== null &&
		(typeof parsedTalk !== "object" || Array.isArray(parsedTalk))
	) {
		throw new Error("config.platforms.nextcloudTalk must be an object");
	}
	let nextcloudTalk: GatewayConfig["platforms"]["nextcloudTalk"] | undefined;
	if (parsedTalk === null) {
		nextcloudTalk = undefined;
	} else if (parsedTalk !== undefined || DEFAULT_CONFIG.platforms.nextcloudTalk !== undefined) {
		// The default block provides every required field; the user block only
		// overrides with concrete values (JSON cannot carry `undefined`).
		nextcloudTalk = {
			...DEFAULT_CONFIG.platforms.nextcloudTalk,
			...(parsedTalk ?? {}),
		} as GatewayConfig["platforms"]["nextcloudTalk"];
	}

	const merged = {
		...DEFAULT_CONFIG,
		...parsed,
		...healthConfig,
		security: {
			...DEFAULT_CONFIG.security,
			...security,
			rateLimit: { ...DEFAULT_CONFIG.security.rateLimit, ...rateLimit },
		},
		sessions: { ...DEFAULT_CONFIG.sessions, ...sessions },
		media: media === null ? undefined : { ...DEFAULT_CONFIG.media, ...media },
		platforms: {
			...DEFAULT_CONFIG.platforms,
			...parsedPlatforms,
			// Explicit key (after the spread) installs the deep-merged block;
			// `undefined` removes it (null convention).
			nextcloudTalk,
		},
	} as GatewayConfig;

	if (!(["daily", "idle", "both"] as string[]).includes(merged.sessions.resetPolicy)) {
		throw new Error("Invalid sessions.resetPolicy");
	}
	if (
		!Number.isInteger(merged.sessions.dailyHour) ||
		merged.sessions.dailyHour < 0 ||
		merged.sessions.dailyHour > 23 ||
		!Number.isFinite(merged.sessions.idleMinutes) ||
		merged.sessions.idleMinutes <= 0
	) {
		throw new Error("Invalid session reset timing");
	}

	// Phase 3 (S6): validate the optional media block (concept §10).
	if (merged.media !== undefined) {
		const special = ["enabled", "sweepIntervalMinutes", "maxAttachmentsPerMessage"] as const;
		const numeric = [
			"maxFileSizeBytes",
			"maxImageBytes",
			"maxTotalBytes",
			"retentionHours",
		] as const;
		const kinds = ["image", "document", "audio", "video"] as const;
		const m = merged.media;

		for (const key of special as readonly string[]) {
			const v = (m as Record<string, unknown>)[key];
			if (v !== undefined && typeof v !== "boolean" && typeof v !== "number") {
				throw new Error(`config.media.${key} must be a boolean or number`);
			}
		}
		for (const key of numeric as readonly string[]) {
			const v = (m as Record<string, unknown>)[key];
			if (v !== undefined && (!Number.isFinite(v) || typeof v !== "number" || v <= 0)) {
				throw new Error(`config.media.${key} must be a number > 0`);
			}
		}
		if (m.sweepIntervalMinutes !== undefined && m.sweepIntervalMinutes < 0) {
			throw new Error(
				"config.media.sweepIntervalMinutes must be >= 0 (0 disables the timer)",
			);
		}
		if (
			m.maxAttachmentsPerMessage !== undefined &&
			(!Number.isInteger(m.maxAttachmentsPerMessage) || m.maxAttachmentsPerMessage < 1)
		) {
			throw new Error("config.media.maxAttachmentsPerMessage must be an integer >= 1");
		}
		if (m.rootDir !== undefined && (typeof m.rootDir !== "string" || m.rootDir.trim() === "")) {
			throw new Error("config.media.rootDir must be a non-empty string");
		}
		if (m.allowedKinds !== undefined) {
			if (!Array.isArray(m.allowedKinds)) {
				throw new Error("config.media.allowedKinds must be an array");
			}
			const kindSet = new Set<string>(kinds);
			for (const k of m.allowedKinds) {
				if (!kindSet.has(k)) {
					throw new Error(
						`config.media.allowedKinds contains invalid kind '${k}' (expected one of ${kinds.join(", ")})`,
					);
				}
			}
		}
		if (m.allowedMimeTypes !== undefined) {
			if (!Array.isArray(m.allowedMimeTypes)) {
				throw new Error("config.media.allowedMimeTypes must be an array");
			}
			for (const mt of m.allowedMimeTypes) {
				if (typeof mt !== "string" || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mt)) {
					throw new Error(
						`config.media.allowedMimeTypes contains invalid MIME type '${String(mt)}'`,
					);
				}
			}
		}
	}

	// Phase 4 (S5): env override + media inheritance for the nextcloudTalk
	// block (concept §10.1/§10). NEXTCLOUD_TALK_APP_TOKEN wins over the
	// configured appToken (Container/Secret-Manager setups); an empty env
	// value is ignored. maxAttachmentsPerMessage inherits from media.* when
	// the user did not set it explicitly.
	if (merged.platforms.nextcloudTalk !== undefined) {
		const envToken = process.env.NEXTCLOUD_TALK_APP_TOKEN;
		if (typeof envToken === "string" && envToken.trim() !== "") {
			merged.platforms.nextcloudTalk.appToken = envToken;
		}
		if (parsedTalk?.maxAttachmentsPerMessage === undefined) {
			merged.platforms.nextcloudTalk.maxAttachmentsPerMessage =
				merged.media?.maxAttachmentsPerMessage ??
				DEFAULT_CONFIG.platforms.nextcloudTalk?.maxAttachmentsPerMessage;
		}
	}

	// Phase 4 (S5): validate the optional nextcloudTalk block (concept §10).
	// Type/range checks run whenever the block is present; presence checks
	// (baseUrl/userId/appToken/rooms) only when enabled — the seeded default
	// config ships a disabled template with empty credentials, and the other
	// platform blocks follow the same "registry gates on enabled" pattern.
	// The adapter re-validates in initialize() as defense in depth (N1).
	const talk = merged.platforms.nextcloudTalk;
	if (talk !== undefined) {
		if (talk.enabled === true) {
			if (typeof talk.baseUrl !== "string" || talk.baseUrl.trim() === "") {
				throw new Error(
					"config.platforms.nextcloudTalk.baseUrl must be a non-empty URL when enabled",
				);
			}
			let talkUrl: URL | null;
			try {
				talkUrl = new URL(talk.baseUrl);
			} catch {
				talkUrl = null;
			}
			if (talkUrl === null) {
				throw new Error(
					`config.platforms.nextcloudTalk.baseUrl is not a valid URL: "${talk.baseUrl}"`,
				);
			}
			const talkProto = talkUrl.protocol.toLowerCase();
			if (talkProto !== "https:" && !(talkProto === "http:" && talk.allowInsecureHttp)) {
				throw new Error(
					"config.platforms.nextcloudTalk.baseUrl must use https:// " +
						"(or http:// with allowInsecureHttp: true)",
				);
			}
			if (typeof talk.userId !== "string" || talk.userId.trim() === "") {
				throw new Error(
					"config.platforms.nextcloudTalk.userId must be a non-empty string when enabled",
				);
			}
			if (typeof talk.appToken !== "string" || talk.appToken.trim() === "") {
				throw new Error(
					"config.platforms.nextcloudTalk.appToken must be a non-empty string when enabled " +
						"(App-Passwort, not the main password — D8)",
				);
			}
			if (talk.appToken.includes("…") || talk.appToken.startsWith("<")) {
				throw new Error(
					"config.platforms.nextcloudTalk.appToken looks like a placeholder — " +
						"set a real App-Passwort (config or NEXTCLOUD_TALK_APP_TOKEN)",
				);
			}
			if (!Array.isArray(talk.rooms) || talk.rooms.length === 0) {
				throw new Error(
					"config.platforms.nextcloudTalk.rooms must be a non-empty array when enabled " +
						"(MVP: explicit rooms, D2)",
				);
			}
		}
		for (const room of talk.rooms ?? []) {
			if (typeof room !== "string" || room.trim() === "") {
				throw new Error(
					"config.platforms.nextcloudTalk.rooms contains an empty/invalid token",
				);
			}
		}
		if (
			talk.pollMode !== undefined &&
			talk.pollMode !== "long-poll" &&
			talk.pollMode !== "interval"
		) {
			throw new Error(
				`config.platforms.nextcloudTalk.pollMode must be "long-poll" or "interval", ` +
					`got "${String(talk.pollMode)}"`,
			);
		}
		for (const key of ["enabled", "autoDiscoverRooms", "allowInsecureHttp"] as const) {
			const v = talk[key];
			if (v !== undefined && typeof v !== "boolean") {
				throw new Error(`config.platforms.nextcloudTalk.${key} must be a boolean`);
			}
		}
		talkIntInRange("longPollTimeoutSeconds", talk.longPollTimeoutSeconds, 0, 60);
		talkPositive("intervalMs", talk.intervalMs);
		talkPositive("minPollIntervalMs", talk.minPollIntervalMs);
		talkPositive("backoffMaxMs", talk.backoffMaxMs);
		talkPositive("roomRefreshIntervalMs", talk.roomRefreshIntervalMs);
		talkIntMin("maxConcurrentPolls", talk.maxConcurrentPolls, 1);
		talkIntMin("circuitThreshold", talk.circuitThreshold, 1);
		talkIntMin("maxAttachmentsPerMessage", talk.maxAttachmentsPerMessage, 1);
	}
	return merged;
}

// ── Phase 4 (S5): nextcloudTalk numeric validators (concept §10) ────────────

function talkPositive(name: string, value: number | undefined): void {
	if (value === undefined) return;
	if (!Number.isFinite(value) || typeof value !== "number" || value <= 0) {
		throw new Error(`config.platforms.nextcloudTalk.${name} must be a number > 0`);
	}
}

function talkIntMin(name: string, value: number | undefined, min: number): void {
	if (value === undefined) return;
	if (!Number.isInteger(value) || value < min) {
		throw new Error(`config.platforms.nextcloudTalk.${name} must be an integer >= ${min}`);
	}
}

function talkIntInRange(name: string, value: number | undefined, min: number, max: number): void {
	if (value === undefined) return;
	if (!Number.isInteger(value) || value < min || value > max) {
		throw new Error(
			`config.platforms.nextcloudTalk.${name} must be an integer in [${min}, ${max}]`,
		);
	}
}

function loadConfig(): GatewayConfig {
	try {
		if (!existsSync(GATEWAY_CONFIG_FILE)) {
			const packageRoot = getPackageRoot(import.meta.url);
			const defaultConfigPath = join(packageRoot, "config", "config.default.json");
			if (existsSync(defaultConfigPath)) {
				mkdirSync(GATEWAY_CONFIG_DIR, { recursive: true });
				copyFileSync(defaultConfigPath, GATEWAY_CONFIG_FILE);
				logger.info("[gateway] Seeded default config at", GATEWAY_CONFIG_FILE);
			}
		}
		if (existsSync(GATEWAY_CONFIG_FILE)) {
			return mergeGatewayConfig(JSON.parse(readFileSync(GATEWAY_CONFIG_FILE, "utf-8")));
		}
	} catch (err) {
		logger.error("[gateway] Failed to parse config file — using defaults. Error:", err);
	}
	return mergeGatewayConfig({});
}

function readDetachedHealthConfig(): GatewayConfig {
	try {
		const parsed = JSON.parse(readFileSync(GATEWAY_CONFIG_FILE, "utf-8"));
		const healthConfig = normalizeGatewayHealthConfig(parsed);
		if (!healthConfig) throw new Error("Invalid detached health configuration");
		runtime.lastDetachedHealthConfig = {
			...runtime.lastDetachedHealthConfig,
			...healthConfig,
		} as GatewayConfig;
	} catch {
		// Keep the last valid probe target during a partial or invalid config write.
	}
	return runtime.lastDetachedHealthConfig ?? runtime.config;
}

async function getDetachedGatewayHealth(pid: number) {
	return fetchGatewayHealth(readDetachedHealthConfig(), pid);
}

export type { GatewayConfig };

export {
	DEFAULT_CONFIG,
	mergeGatewayConfig,
	loadConfig,
	readDetachedHealthConfig,
	getDetachedGatewayHealth,
};
