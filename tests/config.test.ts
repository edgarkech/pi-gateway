import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { DEFAULT_CONFIG, mergeGatewayConfig, loadConfig } from "../src/config.js";
import type { GatewayConfig } from "../src/types.js";

/**
 * Phase 3 (S6) — config-validation tests for the `media` block.
 *
 * Covers the merge defaulting (§10.1) and the validation rules added to
 * `mergeGatewayConfig` (§10: numbers > 0, allowedKinds ⊆ {image,document,
 * audio,video}, MIME format type/subtype).
 */

const base: Record<string, unknown> = {
	host: "localhost",
	port: 3847,
	tokens: [],
};

describe("mergeGatewayConfig — media block", () => {
	it("defaults the media block when absent", () => {
		const merged = mergeGatewayConfig({ ...base } as GatewayConfig);
		assert.ok(merged.media, "media block should be present after merge");
		assert.equal(merged.media!.enabled, true);
		assert.equal(merged.media!.maxFileSizeBytes, 20_480_000);
		assert.equal(merged.media!.maxTotalBytes, 536_870_912);
		assert.deepEqual(merged.media!.allowedKinds, ["image", "document", "audio", "video"]);
		assert.deepEqual(merged.media!.allowedMimeTypes, []);
	});

	it("deep-merges partial media over the defaults", () => {
		const merged = mergeGatewayConfig({
			...base,
			media: { enabled: false, maxFileSizeBytes: 1000 },
		} as GatewayConfig);
		assert.equal(merged.media!.enabled, false);
		assert.equal(merged.media!.maxFileSizeBytes, 1000);
		// Untouched defaults survive the deep merge.
		assert.equal(merged.media!.maxTotalBytes, DEFAULT_CONFIG.media!.maxTotalBytes);
		assert.equal(
			merged.media!.sweepIntervalMinutes,
			DEFAULT_CONFIG.media!.sweepIntervalMinutes,
		);
	});

	it("accepts an explicit media:null to disable the block", () => {
		const merged = mergeGatewayConfig({
			...base,
			media: null,
		} as unknown as GatewayConfig);
		assert.equal(merged.media, undefined);
	});

	it("rejects non-object media value", () => {
		assert.throws(
			() => mergeGatewayConfig({ ...base, media: "oops" } as unknown as GatewayConfig),
			/config\.media/,
		);
	});

	it("rejects non-positive numeric fields", () => {
		for (const key of [
			"maxFileSizeBytes",
			"maxImageBytes",
			"maxTotalBytes",
			"retentionHours",
		]) {
			assert.throws(
				() =>
					mergeGatewayConfig({
						...base,
						media: { [key]: 0 },
					} as unknown as GatewayConfig),
				new RegExp(`config\\.media\\.${key}.*number > 0`),
				`expected ${key}=0 to be rejected`,
			);
		}
	});

	it("rejects negative numeric fields", () => {
		assert.throws(
			() =>
				mergeGatewayConfig({
					...base,
					media: { maxTotalBytes: -5 },
				} as unknown as GatewayConfig),
			/config\.media\.maxTotalBytes.*number > 0/,
		);
	});

	it("rejects non-numeric numeric field values", () => {
		assert.throws(
			() =>
				mergeGatewayConfig({
					...base,
					media: { maxFileSizeBytes: "20MB" },
				} as unknown as GatewayConfig),
			/config\.media\.maxFileSizeBytes.*number > 0/,
		);
	});

	it("rejects sweepIntervalMinutes < 0 but accepts 0", () => {
		assert.throws(
			() =>
				mergeGatewayConfig({
					...base,
					media: { sweepIntervalMinutes: -1 },
				} as unknown as GatewayConfig),
			/config\.media\.sweepIntervalMinutes.*>= 0/,
		);
		const merged = mergeGatewayConfig({
			...base,
			media: { sweepIntervalMinutes: 0 },
		} as GatewayConfig);
		assert.equal(merged.media!.sweepIntervalMinutes, 0);
	});

	it("rejects maxAttachmentsPerMessage < 1 or fractional", () => {
		assert.throws(
			() =>
				mergeGatewayConfig({
					...base,
					media: { maxAttachmentsPerMessage: 0 },
				} as unknown as GatewayConfig),
			/config\.media\.maxAttachmentsPerMessage.*>= 1/,
		);
		assert.throws(
			() =>
				mergeGatewayConfig({
					...base,
					media: { maxAttachmentsPerMessage: 2.5 },
				} as unknown as GatewayConfig),
			/config\.media\.maxAttachmentsPerMessage.*>= 1/,
		);
	});

	it("rejects an empty rootDir", () => {
		assert.throws(
			() =>
				mergeGatewayConfig({ ...base, media: { rootDir: "" } } as unknown as GatewayConfig),
			/config\.media\.rootDir.*non-empty string/,
		);
	});

	it("rejects invalid allowedKinds entries", () => {
		assert.throws(
			() =>
				mergeGatewayConfig({
					...base,
					media: { allowedKinds: ["image", "exe"] },
				} as unknown as GatewayConfig),
			/config\.media\.allowedKinds contains invalid kind 'exe'/,
		);
	});

	it("rejects allowedKinds that is not an array", () => {
		assert.throws(
			() =>
				mergeGatewayConfig({
					...base,
					media: { allowedKinds: "image" },
				} as unknown as GatewayConfig),
			/config\.media\.allowedKinds.*must be an array/,
		);
	});

	it("accepts a valid subset of allowedKinds", () => {
		const merged = mergeGatewayConfig({
			...base,
			media: { allowedKinds: ["image", "video"] },
		} as GatewayConfig);
		assert.deepEqual(merged.media!.allowedKinds, ["image", "video"]);
	});

	it("rejects malformed MIME entries in allowedMimeTypes", () => {
		for (const bad of ["imagejpg", "image/", "/png", "image/jpeg; charset=utf-8", ""]) {
			assert.throws(
				() =>
					mergeGatewayConfig({
						...base,
						media: { allowedMimeTypes: [bad] },
					} as unknown as GatewayConfig),
				/config\.media\.allowedMimeTypes contains invalid MIME type/,
				`expected MIME '${bad}' to be rejected`,
			);
		}
	});

	it("accepts well-formed MIME entries", () => {
		const merged = mergeGatewayConfig({
			...base,
			media: {
				allowedMimeTypes: ["image/png", "application/pdf", "audio/ogg", "video/mp4"],
			},
		} as GatewayConfig);
		assert.deepEqual(merged.media!.allowedMimeTypes, [
			"image/png",
			"application/pdf",
			"audio/ogg",
			"video/mp4",
		]);
	});

	it("passes through unrelated base validation untouched", () => {
		assert.throws(
			() => mergeGatewayConfig({ host: "localhost", port: "x", tokens: [] } as never),
			/Invalid gateway host, port, or tokens/,
		);
	});
});

/**
 * Phase 4 (S5) — config-validation tests for the `nextcloudTalk` block.
 *
 * Covers the deep merge over the polling defaults (§10), the env override
 * NEXTCLOUD_TALK_APP_TOKEN (§10.1), the media inheritance of
 * maxAttachmentsPerMessage, and the validation rules added to
 * mergeGatewayConfig: presence checks only when enabled (the seeded default
 * config ships a disabled template with empty credentials), type/range
 * checks always.
 */
const validTalk = {
	enabled: true,
	baseUrl: "https://nextcloud.local",
	userId: "pi-bot",
	appToken: "abc123token",
	rooms: ["room-token-1"],
};

describe("mergeGatewayConfig — nextcloudTalk block", () => {
	it("defaults the nextcloudTalk block when absent (disabled template)", () => {
		const merged = mergeGatewayConfig({ ...base } as GatewayConfig);
		const talk = merged.platforms.nextcloudTalk;
		assert.ok(talk, "nextcloudTalk block should be present after merge");
		assert.equal(talk!.enabled, false);
		assert.equal(talk!.baseUrl, "");
		assert.equal(talk!.userId, "");
		assert.equal(talk!.appToken, "");
		assert.deepEqual(talk!.rooms, []);
		assert.equal(talk!.pollMode, "long-poll");
		assert.equal(talk!.longPollTimeoutSeconds, 30);
		assert.equal(talk!.intervalMs, 5000);
		assert.equal(talk!.minPollIntervalMs, 1000);
		assert.equal(talk!.backoffMaxMs, 60_000);
		assert.equal(talk!.maxConcurrentPolls, 4);
		assert.equal(talk!.circuitThreshold, 5);
		assert.equal(talk!.autoDiscoverRooms, false);
		assert.equal(talk!.roomRefreshIntervalMs, 60_000);
		assert.equal(talk!.allowInsecureHttp, false);
		assert.equal(talk!.maxAttachmentsPerMessage, 4);
	});

	it("deep-merges a partial enabled block over the defaults", () => {
		const merged = mergeGatewayConfig({
			...base,
			platforms: { nextcloudTalk: validTalk },
		} as GatewayConfig);
		const talk = merged.platforms.nextcloudTalk!;
		assert.equal(talk.baseUrl, "https://nextcloud.local");
		assert.equal(talk.userId, "pi-bot");
		assert.deepEqual(talk.rooms, ["room-token-1"]);
		// Untouched polling defaults survive the deep merge.
		assert.equal(talk.pollMode, "long-poll");
		assert.equal(talk.longPollTimeoutSeconds, 30);
		assert.equal(talk.maxConcurrentPolls, 4);
		assert.equal(talk.circuitThreshold, 5);
	});

	it("accepts an explicit nextcloudTalk:null to remove the block", () => {
		const merged = mergeGatewayConfig({
			...base,
			platforms: { nextcloudTalk: null },
		} as unknown as GatewayConfig);
		assert.equal(merged.platforms.nextcloudTalk, undefined);
	});

	it("rejects a non-object nextcloudTalk value", () => {
		assert.throws(
			() =>
				mergeGatewayConfig({
					...base,
					platforms: { nextcloudTalk: "oops" },
				} as unknown as GatewayConfig),
			/config\.platforms\.nextcloudTalk must be an object/,
		);
	});

	it("accepts a disabled block with empty credentials (seeded template)", () => {
		const merged = mergeGatewayConfig({
			...base,
			platforms: { nextcloudTalk: { enabled: false } },
		} as GatewayConfig);
		assert.equal(merged.platforms.nextcloudTalk!.enabled, false);
		// Polling defaults are still merged in for the disabled template.
		assert.equal(merged.platforms.nextcloudTalk!.pollMode, "long-poll");
	});

	it("rejects an enabled block with missing/empty required fields", () => {
		const cases: Array<[Record<string, unknown>, RegExp]> = [
			[{ ...validTalk, baseUrl: "" }, /baseUrl.*non-empty/],
			[{ ...validTalk, userId: "" }, /userId.*non-empty/],
			[{ ...validTalk, appToken: "" }, /appToken.*non-empty/],
			[{ ...validTalk, rooms: [] }, /rooms.*non-empty array/],
			[{ ...validTalk, baseUrl: "not-a-url" }, /baseUrl is not a valid URL/],
			[{ ...validTalk, baseUrl: "http://nextcloud.local" }, /must use https:/],
			[{ ...validTalk, appToken: "…" }, /placeholder/],
			[{ ...validTalk, appToken: "<paste-token>" }, /placeholder/],
		];
		for (const [talk, pattern] of cases) {
			assert.throws(
				() =>
					mergeGatewayConfig({
						...base,
						platforms: { nextcloudTalk: talk },
					} as unknown as GatewayConfig),
				pattern,
				`expected ${JSON.stringify(talk)} to be rejected`,
			);
		}
	});

	it("accepts http:// only with allowInsecureHttp: true", () => {
		const merged = mergeGatewayConfig({
			...base,
			platforms: {
				nextcloudTalk: {
					...validTalk,
					baseUrl: "http://nextcloud.lan",
					allowInsecureHttp: true,
				},
			},
		} as GatewayConfig);
		assert.equal(merged.platforms.nextcloudTalk!.allowInsecureHttp, true);
		assert.equal(merged.platforms.nextcloudTalk!.baseUrl, "http://nextcloud.lan");
	});

	it("rejects invalid polling numbers", () => {
		const cases: Array<[Record<string, unknown>, RegExp]> = [
			[{ ...validTalk, longPollTimeoutSeconds: 61 }, /longPollTimeoutSeconds.*\[0, 60\]/],
			[{ ...validTalk, longPollTimeoutSeconds: -1 }, /longPollTimeoutSeconds.*\[0, 60\]/],
			[{ ...validTalk, intervalMs: 0 }, /intervalMs.*number > 0/],
			[{ ...validTalk, minPollIntervalMs: -5 }, /minPollIntervalMs.*number > 0/],
			[{ ...validTalk, backoffMaxMs: "60s" }, /backoffMaxMs.*number > 0/],
			[{ ...validTalk, maxConcurrentPolls: 0 }, /maxConcurrentPolls.*integer >= 1/],
			[{ ...validTalk, maxConcurrentPolls: 2.5 }, /maxConcurrentPolls.*integer >= 1/],
			[{ ...validTalk, circuitThreshold: 0 }, /circuitThreshold.*integer >= 1/],
			[
				{ ...validTalk, maxAttachmentsPerMessage: 0 },
				/maxAttachmentsPerMessage.*integer >= 1/,
			],
			[{ ...validTalk, roomRefreshIntervalMs: -1 }, /roomRefreshIntervalMs.*number > 0/],
		];
		for (const [talk, pattern] of cases) {
			assert.throws(
				() =>
					mergeGatewayConfig({
						...base,
						platforms: { nextcloudTalk: talk },
					} as unknown as GatewayConfig),
				pattern,
				`expected ${JSON.stringify(talk)} to be rejected`,
			);
		}
	});

	it("accepts the documented polling defaults boundary values", () => {
		const merged = mergeGatewayConfig({
			...base,
			platforms: {
				nextcloudTalk: { ...validTalk, longPollTimeoutSeconds: 60, maxConcurrentPolls: 1 },
			},
		} as GatewayConfig);
		assert.equal(merged.platforms.nextcloudTalk!.longPollTimeoutSeconds, 60);
		assert.equal(merged.platforms.nextcloudTalk!.maxConcurrentPolls, 1);
	});

	it("rejects an invalid pollMode", () => {
		assert.throws(
			() =>
				mergeGatewayConfig({
					...base,
					platforms: { nextcloudTalk: { ...validTalk, pollMode: "burst" } },
				} as unknown as GatewayConfig),
			/pollMode must be "long-poll" or "interval"/,
		);
	});

	it("rejects non-boolean flag fields", () => {
		assert.throws(
			() =>
				mergeGatewayConfig({
					...base,
					platforms: { nextcloudTalk: { ...validTalk, allowInsecureHttp: "yes" } },
				} as unknown as GatewayConfig),
			/allowInsecureHttp must be a boolean/,
		);
	});

	it("rejects rooms with empty entries (even when disabled)", () => {
		assert.throws(
			() =>
				mergeGatewayConfig({
					...base,
					platforms: { nextcloudTalk: { enabled: false, rooms: ["a", ""] } },
				} as unknown as GatewayConfig),
			/rooms contains an empty\/invalid token/,
		);
	});

	it("overrides appToken from NEXTCLOUD_TALK_APP_TOKEN", () => {
		process.env.NEXTCLOUD_TALK_APP_TOKEN = "env-token-xyz";
		try {
			const merged = mergeGatewayConfig({
				...base,
				platforms: { nextcloudTalk: validTalk },
			} as GatewayConfig);
			assert.equal(merged.platforms.nextcloudTalk!.appToken, "env-token-xyz");
		} finally {
			delete process.env.NEXTCLOUD_TALK_APP_TOKEN;
		}
	});

	it("lets NEXTCLOUD_TALK_APP_TOKEN satisfy the enabled appToken requirement", () => {
		process.env.NEXTCLOUD_TALK_APP_TOKEN = "env-token-xyz";
		try {
			const merged = mergeGatewayConfig({
				...base,
				platforms: { nextcloudTalk: { ...validTalk, appToken: "" } },
			} as GatewayConfig);
			assert.equal(merged.platforms.nextcloudTalk!.appToken, "env-token-xyz");
		} finally {
			delete process.env.NEXTCLOUD_TALK_APP_TOKEN;
		}
	});

	it("ignores an empty NEXTCLOUD_TALK_APP_TOKEN", () => {
		process.env.NEXTCLOUD_TALK_APP_TOKEN = "   ";
		try {
			assert.throws(
				() =>
					mergeGatewayConfig({
						...base,
						platforms: { nextcloudTalk: { ...validTalk, appToken: "" } },
					} as unknown as GatewayConfig),
				/appToken.*non-empty/,
			);
		} finally {
			delete process.env.NEXTCLOUD_TALK_APP_TOKEN;
		}
	});

	it("inherits maxAttachmentsPerMessage from media when not set explicitly", () => {
		const merged = mergeGatewayConfig({
			...base,
			media: { maxAttachmentsPerMessage: 8 },
			platforms: { nextcloudTalk: validTalk },
		} as GatewayConfig);
		assert.equal(merged.platforms.nextcloudTalk!.maxAttachmentsPerMessage, 8);
	});

	it("keeps an explicit maxAttachmentsPerMessage over the media default", () => {
		const merged = mergeGatewayConfig({
			...base,
			media: { maxAttachmentsPerMessage: 8 },
			platforms: { nextcloudTalk: { ...validTalk, maxAttachmentsPerMessage: 2 } },
		} as GatewayConfig);
		assert.equal(merged.platforms.nextcloudTalk!.maxAttachmentsPerMessage, 2);
	});
});

describe("DEFAULT_CONFIG", () => {
	it("exposes the Phase 3 media defaults", () => {
		assert.equal(DEFAULT_CONFIG.media?.enabled, true);
		assert.equal(DEFAULT_CONFIG.media?.maxFileSizeBytes, 20_480_000);
		assert.equal(DEFAULT_CONFIG.media?.maxImageBytes, 5_242_880);
		assert.equal(DEFAULT_CONFIG.media?.maxTotalBytes, 536_870_912);
		assert.equal(DEFAULT_CONFIG.media?.retentionHours, 24);
		assert.equal(DEFAULT_CONFIG.media?.sweepIntervalMinutes, 30);
		assert.equal(DEFAULT_CONFIG.media?.maxAttachmentsPerMessage, 4);
	});

	it("exposes the Phase 4 nextcloudTalk defaults (disabled template)", () => {
		const talk = DEFAULT_CONFIG.platforms.nextcloudTalk;
		assert.ok(talk, "nextcloudTalk block should be present in DEFAULT_CONFIG");
		assert.equal(talk!.enabled, false);
		assert.equal(talk!.baseUrl, "");
		assert.deepEqual(talk!.rooms, []);
		assert.equal(talk!.pollMode, "long-poll");
		assert.equal(talk!.longPollTimeoutSeconds, 30);
		assert.equal(talk!.intervalMs, 5000);
		assert.equal(talk!.minPollIntervalMs, 1000);
		assert.equal(talk!.backoffMaxMs, 60_000);
		assert.equal(talk!.maxConcurrentPolls, 4);
		assert.equal(talk!.circuitThreshold, 5);
		assert.equal(talk!.autoDiscoverRooms, false);
		assert.equal(talk!.roomRefreshIntervalMs, 60_000);
		assert.equal(talk!.allowInsecureHttp, false);
		assert.equal(talk!.maxAttachmentsPerMessage, 4);
	});
});

describe("loadConfig", () => {
	it("loads a config containing a media block", () => {
		// loadConfig() uses the isolated ~/.pi/gateway config.json (tests/setup.ts
		// redirects HOME). With no explicit config, it seeds from the default;
		// merge fills the media block with defaults.
		const cfg = loadConfig();
		assert.ok(cfg.media);
		assert.equal(typeof cfg.media!.enabled, "boolean");
	});
});
