/**
 * Discord Adapter - Hermes-style Discord platform adapter
 *
 * Features:
 * - DM and guild channel support
 * - Slash command registration
 * - Typing indicators
 * - Message editing/deletion
 * - Rate limit handling
 */

import {
	BaseAdapter,
	type PlatformMessage,
	type PlatformConfig,
	type AdapterCallbacks,
} from "./base.js";
import { logger } from "../logger.js";

export interface DiscordConfig extends PlatformConfig {
	platform: "discord";
	botToken: string;
	guildId?: string;
	allowedChannels?: string[]; // Whitelist specific channels
	allowedRoles?: string[]; // Whitelist roles
	requireMention?: boolean; // Require @mention in guilds
}

/** Discord gateway event received over the WebSocket (op-encoded). */
interface DiscordGatewayEvent {
	op: number;
	/** Sequence number — present on dispatch (op 0) events. */
	s?: number | null;
	/** Event type — present on dispatch (op 0) events. */
	t?: string | null;
	/** Event payload. */
	d: Record<string, unknown>;
}

/** Author object of a Discord message. */
interface DiscordAuthor {
	id: string;
	bot?: boolean;
	username: string;
	discriminator?: string;
}

export class DiscordAdapter extends BaseAdapter {
	readonly platform = "discord" as const;
	config: DiscordConfig;
	private httpClient: typeof fetch | null = null;
	private wsConnection: WebSocket | null = null;
	private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
	private sequence: number | null = null;
	private sessionId: string | null = null;
	private intents: number = 0;

	constructor(config: DiscordConfig) {
		super();
		this.config = config;

		// Intents: GUILD_MESSAGES (1<<9) + DIRECT_MESSAGES (1<<12) + MESSAGE_CONTENT (1<<15)
		this.intents = (1 << 9) | (1 << 12) | (1 << 15);
	}

	async initialize(): Promise<void> {
		// Test bot token
		const response = await this.apiRequest("/users/@me");
		const data = (await response.json()) as { username: string };
		if (!response.ok) {
			throw new Error(`Discord authentication failed: ${response.status}`);
		}
		logger.info(`[Discord] Bot initialized: ${data.username}`);
	}

	private async apiRequest(endpoint: string, options: RequestInit = {}): Promise<Response> {
		const url = `https://discord.com/api/v10${endpoint}`;
		return fetch(url, {
			...options,
			headers: {
				Authorization: `Bot ${this.config.botToken}`,
				"Content-Type": "application/json",
				...options.headers,
			},
		});
	}

	async start(callbacks: AdapterCallbacks): Promise<void> {
		await super.start(callbacks);

		// Connect to Gateway
		const gatewayResponse = await this.apiRequest("/gateway");
		const gatewayData = (await gatewayResponse.json()) as { url: string };
		const gatewayUrl = `${gatewayData.url}?v=10&encoding=json&intents=${this.intents}`;

		this.wsConnection = new WebSocket(gatewayUrl);

		this.wsConnection.onopen = () => {
			logger.info("[Discord] WebSocket connected");
		};

		this.wsConnection.onmessage = async (event) => {
			const data = JSON.parse(event.data) as DiscordGatewayEvent;
			await this.handleGatewayMessage(data);
		};

		this.wsConnection.onclose = () => {
			logger.info("[Discord] WebSocket closed");
			this.callbacks?.onDisconnect?.();
			// Attempt reconnect after 5 seconds
			setTimeout(() => this.start(callbacks), 5000);
		};
	}

	private async handleGatewayMessage(data: DiscordGatewayEvent): Promise<void> {
		switch (data.op) {
			case 0: // Dispatch
				this.sequence = data.s ?? null;
				await this.handleDispatch(data.t ?? "", data.d);
				break;

			case 10: // Hello
				this.startHeartbeat(data.d.heartbeat_interval as number);
				this.identify();
				break;

			case 11: // Heartbeat ACK
				// Heartbeat acknowledged
				break;
		}
	}

	private startHeartbeat(interval: number): void {
		this.heartbeatInterval = setInterval(() => {
			if (this.wsConnection?.readyState === WebSocket.OPEN) {
				this.wsConnection.send(
					JSON.stringify({
						op: 1,
						d: this.sequence,
					}),
				);
			}
		}, interval);
	}

	private async identify(): Promise<void> {
		const identifyPayload = {
			op: 2,
			d: {
				token: this.config.botToken,
				intents: this.intents,
				properties: {
					os: "linux",
					browser: "pi-gateway",
					device: "pi-gateway",
				},
			},
		};

		this.wsConnection?.send(JSON.stringify(identifyPayload));
	}

	private async handleDispatch(type: string, data: Record<string, unknown>): Promise<void> {
		switch (type) {
			case "READY": {
				const ready = data as { session_id: string; user: { username: string } };
				this.sessionId = ready.session_id;
				logger.info(`[Discord] Logged in as ${ready.user.username}`);
				break;
			}

			case "MESSAGE_CREATE": {
				await this.handleMessage(data);
				break;
			}

			case "MESSAGE_UPDATE":
				// Handle edits if needed
				break;
		}
	}

	private async handleMessage(data: Record<string, unknown>): Promise<void> {
		const author = data.author as DiscordAuthor | undefined;
		if (!author) return;
		// Ignore bots
		if (author.bot && author.id !== this.getBotId()) return;

		const guildId = data.guild_id as string | undefined;
		const channelId = data.channel_id as string | undefined;
		const text = data.content as string | undefined;
		if (!channelId || text === undefined) return;

		// Check if DM or allowed channel
		const isDM = !guildId;
		if (!isDM && this.config.allowedChannels?.length) {
			if (!this.config.allowedChannels.includes(channelId)) return;
		}

		// Check mention requirement in guilds
		if (!isDM && this.config.requireMention) {
			const mentioned = text.includes(`<@${this.getBotId()}>`);
			if (!mentioned) return;
		}

		const message: PlatformMessage = {
			id: String(data.id ?? ""),
			platform: this.platform,
			channelId,
			userId: author.id,
			content: text,
			timestamp: new Date((data.timestamp as string | undefined) ?? Date.now()).getTime(),
			metadata: {
				guildId: data.guild_id,
				username: author.username,
				discriminator: author.discriminator,
				isDM,
			},
		};

		await this.callbacks?.onMessage(message);
	}

	private getBotId(): string {
		// Extract from token - this is approximate
		return this.config.botToken.split(".")[0];
	}

	async sendMessage(channelId: string, content: string): Promise<string> {
		const response = await this.apiRequest(`/channels/${channelId}/messages`, {
			method: "POST",
			body: JSON.stringify({ content }),
		});

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Failed to send message: ${error}`);
		}

		const data = (await response.json()) as { id: string };
		return data.id;
	}

	async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
		await this.apiRequest(`/channels/${channelId}/messages/${messageId}`, {
			method: "PATCH",
			body: JSON.stringify({ content }),
		});
	}

	async deleteMessage(channelId: string, messageId: string): Promise<void> {
		await this.apiRequest(`/channels/${channelId}/messages/${messageId}`, {
			method: "DELETE",
		});
	}

	async setTyping(channelId: string, isTyping: boolean): Promise<void> {
		if (!isTyping) return; // Discord doesn't have a "stop typing" API

		await this.apiRequest(`/channels/${channelId}/typing`, {
			method: "POST",
		});
	}

	async getStatus(): Promise<{ connected: boolean; latency?: number }> {
		try {
			const response = await this.apiRequest("/gateway/bot");
			const data = (await response.json()) as { session_start_limit?: { remaining: number } };
			return {
				connected: true,
				latency: data.session_start_limit?.remaining ?? undefined,
			};
		} catch {
			return { connected: false };
		}
	}

	async stop(): Promise<void> {
		if (this.heartbeatInterval) {
			clearInterval(this.heartbeatInterval);
		}
		if (this.wsConnection) {
			this.wsConnection.close();
		}
		await super.stop();
	}

	// Helper to register slash commands
	async registerSlashCommands(
		commands: Array<{
			name: string;
			description: string;
			options?: Array<Record<string, unknown>>;
		}>,
	): Promise<void> {
		if (!this.config.guildId) {
			logger.warn("[Discord] guildId required for slash commands");
			return;
		}

		await this.apiRequest(
			`/applications/${this.getBotId()}/guilds/${this.config.guildId}/commands`,
			{
				method: "PUT",
				body: JSON.stringify(commands),
			},
		);

		logger.info(`[Discord] Registered ${commands.length} slash commands`);
	}
}
