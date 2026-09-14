import { logger } from "../logger.js";
import { runtime } from "../state.js";
import { adapterCallbacks } from "./../core/message-pipeline.js";
import { DiscordAdapter } from "./discord.js";
import { TelegramAdapter } from "./telegram.js";
import { SlackAdapter } from "./slack.js";
import { WhatsAppAdapter } from "./whatsapp.js";
import { NextcloudTalkAdapter } from "./nextcloud-talk.js";

// Initialize platform adapters
export async function initializeAdapters(): Promise<void> {
	// Discord
	if (runtime.config.platforms.discord?.enabled && runtime.config.platforms.discord.botToken) {
		try {
			const discord = new DiscordAdapter({
				enabled: true,
				platform: "discord",
				botToken: runtime.config.platforms.discord.botToken,
				guildId: runtime.config.platforms.discord.guildId,
			});
			await discord.initialize();
			await discord.start(adapterCallbacks);
			runtime.state.adapters.set("discord", discord);
			logger.info("[gateway] Discord adapter started");
		} catch (err) {
			logger.error("[gateway] Failed to start Discord adapter:", err);
		}
	}

	// Telegram
	if (runtime.config.platforms.telegram?.enabled && runtime.config.platforms.telegram.token) {
		try {
			const telegram = new TelegramAdapter({
				enabled: true,
				platform: "telegram",
				token: runtime.config.platforms.telegram.token,
				webhookUrl: runtime.config.platforms.telegram.webhookUrl,
			});
			await telegram.initialize();
			await telegram.start(adapterCallbacks);
			runtime.state.adapters.set("telegram", telegram);
			logger.info("[gateway] Telegram adapter started");
		} catch (err) {
			logger.error("[gateway] Failed to start Telegram adapter:", err);
		}
	}

	// Slack
	if (
		runtime.config.platforms.slack?.enabled &&
		(runtime.config.platforms.slack.webhookUrl || runtime.config.platforms.slack.botToken)
	) {
		try {
			const slack = new SlackAdapter({
				enabled: true,
				platform: "slack",
				webhookUrl: runtime.config.platforms.slack.webhookUrl,
				botToken: runtime.config.platforms.slack.botToken,
			});
			await slack.initialize();
			await slack.start(adapterCallbacks);
			runtime.state.adapters.set("slack", slack);
			logger.info("[gateway] Slack adapter started");
		} catch (err) {
			logger.error("[gateway] Failed to start Slack adapter:", err);
		}
	}

	// WhatsApp
	if (runtime.config.platforms.whatsapp?.enabled) {
		try {
			const whatsapp = new WhatsAppAdapter({
				enabled: true,
				platform: "whatsapp",
				sessionPath: runtime.config.platforms.whatsapp.sessionPath,
				printQr: runtime.config.platforms.whatsapp.printQr,
			});
			await whatsapp.initialize();
			await whatsapp.start(adapterCallbacks);
			runtime.state.adapters.set("whatsapp", whatsapp);
			logger.info("[gateway] WhatsApp adapter started");
		} catch (err) {
			logger.error("[gateway] Failed to start WhatsApp adapter:", err);
		}
	}

	// Nextcloud Talk (Phase 4 S5, concept §10): OCS user polling — no webhook,
	// no public URL. The registry gates on `enabled`; the adapter re-validates
	// the full block in initialize() (baseUrl schema, credentials, rooms) and
	// probes auth via listRooms() (N1: on failure the channel stays disabled
	// with a clear log, the daemon keeps running).
	const talk = runtime.config.platforms.nextcloudTalk;
	if (talk?.enabled) {
		try {
			const nextcloudTalk = new NextcloudTalkAdapter({
				enabled: true,
				platform: "nextcloudTalk",
				baseUrl: talk.baseUrl,
				userId: talk.userId,
				appToken: talk.appToken,
				rooms: [...talk.rooms],
				pollMode: talk.pollMode,
				longPollTimeoutSeconds: talk.longPollTimeoutSeconds,
				intervalMs: talk.intervalMs,
				minPollIntervalMs: talk.minPollIntervalMs,
				backoffMaxMs: talk.backoffMaxMs,
				maxConcurrentPolls: talk.maxConcurrentPolls,
				circuitThreshold: talk.circuitThreshold,
				autoDiscoverRooms: talk.autoDiscoverRooms,
				roomRefreshIntervalMs: talk.roomRefreshIntervalMs,
				allowInsecureHttp: talk.allowInsecureHttp,
				maxAttachmentsPerMessage: talk.maxAttachmentsPerMessage,
			});
			await nextcloudTalk.initialize();
			await nextcloudTalk.start(adapterCallbacks);
			runtime.state.adapters.set("nextcloudTalk", nextcloudTalk);
			logger.info("[gateway] Nextcloud Talk adapter started");
		} catch (err) {
			logger.error("[gateway] Failed to start Nextcloud Talk adapter:", err);
		}
	}
}
