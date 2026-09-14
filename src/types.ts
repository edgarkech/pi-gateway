import type { WebSocket } from "ws";

import type { SessionConfig } from "./sessions/store.js";
import type { BaseAdapter } from "./adapters/base.js";
import type { MediaKind } from "./media/types.js";

// Phase 3 (File-Attachments): convenience re-exports for central type imports.
// Definitions live in src/media/types.ts (concept §5.3) — no breaking change.
export type {
	MediaAttachment,
	MediaKind,
	MediaIngestRequest,
	ImageContent,
} from "./media/types.js";

/**
 * Phase 3 (File-Attachments) — media-handling configuration block.
 *
 * All fields optional; defaults live in config.config.default.json and are
 * mirrored in DEFAULT_CONFIG (src/config.ts). See concept_phase_3_media.md §10.
 */
export interface MediaConfig {
	/** Master switch. false = media messages dropped like today (Default: true). */
	enabled?: boolean;
	/** Storage root (Default: ~/.pi/runtime/media; Env-override PI_MEDIA_DIR for tests). */
	rootDir?: string;
	/** Max bytes per file (Default: 20_480_000 = Telegram bot limit). */
	maxFileSizeBytes?: number;
	/** Max bytes inlined as base64 into the RPC prompt (Default: 5_242_880 = 5 MB). */
	maxImageBytes?: number;
	/** Total store quota in bytes (Default: 536_870_912 = 512 MB). */
	maxTotalBytes?: number;
	/** Per-file retention in hours (Default: 24). */
	retentionHours?: number;
	/** Periodic TTL-sweep interval in minutes (Default: 30). */
	sweepIntervalMinutes?: number;
	/** Max attachments per message (Default: 4). */
	maxAttachmentsPerMessage?: number;
	/** Allowed MediaKinds; empty/missing = all four (see §10). */
	allowedKinds?: MediaKind[];
	/** MIME allowlist; empty/missing = built-in defaults (§10.1). */
	allowedMimeTypes?: string[];
}

/**
 * Phase 4 (Nextcloud Talk) — platform configuration block.
 *
 * Mirrors the `platforms.nextcloudTalk` schema of
 * `concept_phase_4_nextcloud.md` §10. All optional fields have defaults in
 * DEFAULT_CONFIG (src/config.ts) and config/config.default.json; validation
 * runs in mergeGatewayConfig (§10) — strict presence checks only when
 * `enabled: true`, because the seeded default config ships a disabled
 * template with empty credentials (same pattern as the other platform
 * blocks). The adapter re-validates in initialize() as defense in depth.
 *
 * `autoDiscoverRooms`/`roomRefreshIntervalMs` are consumed since P2b:
 * when enabled, rooms of the bot user are discovered via `listRooms()` at
 * start/reload and re-checked on a refresh interval (MVP default: explicit
 * rooms only, D2).
 */
export interface NextcloudTalkPlatformConfig {
	/** Master switch. false = channel disabled (Default: false). */
	enabled: boolean;
	/** Nextcloud base URL without trailing slash, e.g. https://nextcloud.local.
	 *  Required when enabled; must be https:// (or http:// with allowInsecureHttp). */
	baseUrl: string;
	/** Nextcloud login of the bot account — used for Basic-Auth, the
	 *  self-filter (D4) and the WebDAV path basis (§6.4). Required when enabled. */
	userId: string;
	/** App password / app token — NOT the main password (D8).
	 *  Env override: NEXTCLOUD_TALK_APP_TOKEN (§10.1). Never logged. */
	appToken: string;
	/** Talk room tokens (MVP: explicitly configured, D2). Required when enabled. */
	rooms: string[];

	// Polling (§10)
	/** Default: "long-poll"; "interval" forces plain interval polling. */
	pollMode?: "long-poll" | "interval";
	/** Long-poll server hold time in seconds, 0–60 (Default: 30). */
	longPollTimeoutSeconds?: number;
	/** Poll interval in ms, only used for pollMode="interval" (Default: 5000). */
	intervalMs?: number;
	/** Minimum time between two polls of one room in ms (Default: 1000). */
	minPollIntervalMs?: number;
	/** Cap for the exponential backoff in ms (Default: 60000). */
	backoffMaxMs?: number;
	/** Max concurrent open long-polls across all rooms (Default: 4). */
	maxConcurrentPolls?: number;
	/** Consecutive errors after which a room is paused — circuit breaker (Default: 5). */
	circuitThreshold?: number;

	// Discovery (P2b, §10.2 — consumed by the adapter)
	/** When true, all rooms of the bot user are discovered at start/reload
	 *  and additionally monitored (Default: false — MVP: explicit rooms, D2). */
	autoDiscoverRooms?: boolean;
	/** Refresh interval in ms for the room discovery; only effective with
	 *  autoDiscoverRooms=true (Default: 60000). */
	roomRefreshIntervalMs?: number;

	// Security
	/** Allow http:// instead of https:// for pure-LAN setups (Default: false).
	 *  Emits a warning log at adapter start. */
	allowInsecureHttp?: boolean;

	// Media (Default: inherits media.maxAttachmentsPerMessage, §10)
	maxAttachmentsPerMessage?: number;
}
// Types
export interface GatewayConfig {
	port: number;
	host: string;
	tokens: string[];
	corsOrigins: string[];
	enableWebSocket: boolean;
	enableHttp: boolean;
	security: {
		allowAll: boolean;
		requirePairing: boolean;
		allowedUids: Record<string, string[]>;
		adminUids: Record<string, string[]>;
		rateLimit: {
			maxRequests: number;
			windowMs: number;
		};
	};
	/** Timeout in ms for waiting on pi agent to respond (default: 300000 = 5 min) */
	promptTimeoutMs?: number;
	sessions: {
		resetPolicy: "daily" | "idle" | "both";
		dailyHour: number;
		idleMinutes: number;
	};
	/** Phase 3: File-Attachments / Media-Handling (concept §10). */
	media?: MediaConfig;
	platforms: {
		discord?: {
			enabled: boolean;
			botToken: string;
			guildId?: string;
		};
		telegram?: {
			enabled: boolean;
			token: string;
			/** Public URL for Telegram webhook (e.g. https://example.com/webhook/telegram).
			 *  When omitted, long polling is used automatically. */
			webhookUrl?: string;
		};
		slack?: {
			enabled: boolean;
			webhookUrl?: string;
			botToken?: string;
		};
		whatsapp?: {
			enabled: boolean;
			sessionPath?: string;
			printQr?: boolean;
		};
		/** Phase 4: Nextcloud Talk (OCS user polling, concept_phase_4_nextcloud.md). */
		nextcloudTalk?: NextcloudTalkPlatformConfig;
	};
}

export interface GatewayState {
	running: boolean;
	adapters: Map<string, BaseAdapter>;
	clients: Map<string, WebSocket>;
	sessions: Map<string, SessionConfig>;
}
