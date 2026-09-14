/**
 * Telegram Adapter - Hermes-style Telegram platform adapter
 *
 * Features:
 * - Polling and webhook modes
 * - DM and group chat support
 * - Inline queries
 * - Callback buttons
 */

import { Readable } from "node:stream";

import {
	BaseAdapter,
	type PlatformMessage,
	type PlatformConfig,
	type InteractivePrompt,
	type AdapterCallbacks,
} from "./base.js";
import { logger } from "../logger.js";
import { MediaError, type MediaAttachment, type MediaKind } from "../media/types.js";
import { initMediaManager } from "../media/manager.js";
import { runtime } from "../state.js";

interface TelegramConfig extends PlatformConfig {
	platform: "telegram";
	token: string;
	/** Public URL Telegram sends updates to (e.g. https://example.com/webhook/telegram).
	 *  When set, webhook mode is used. When omitted, long polling is used. */
	webhookUrl?: string;
	webhookSecret?: string;
	allowedChats?: string[]; // Whitelist chat IDs
	requireUsername?: boolean; // Require user to have a username
}

export type { TelegramConfig };

interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	edited_message?: TelegramMessage;
	callback_query?: {
		id: string;
		from: { id: number; username?: string; first_name?: string };
		message?: TelegramMessage;
		data: string;
	};
}

/**
 * Common Telegram file descriptor for media fields (photo sizes, document,
 * audio, video, animation, voice + caption entities). Those objects all share
 * `file_id`/`file_unique_id` and optional `file_name`/`file_size`/`mime_type`.
 * Concept §9.1.
 */
interface TelegramFileRef {
	file_id: string;
	file_unique_id?: string;
	file_name?: string;
	file_size?: number;
	mime_type?: string;
}

/** A photo size (extends TelegramFileRef with pixel dimensions). */
interface TelegramPhotoSize extends TelegramFileRef {
	width: number;
	height: number;
}

interface TelegramMessage {
	message_id: number;
	from?: { id: number; username?: string; first_name?: string };
	chat: { id: number; type: string; title?: string };
	text?: string;
	caption?: string;
	date: number;
	entities?: Array<{ type: string; offset: number; length: number }>;
	/** Present when the message is a reply to a ForceReply prompt. */
	reply_to_message?: {
		reply_markup?: { force_reply?: boolean };
	};

	// ── Phase 3 media fields (§9.1) ──
	/** Compressed sizes of a photo; pick the highest-resolution entry. */
	photo?: TelegramPhotoSize[];
	document?: TelegramFileRef;
	audio?: TelegramFileRef;
	video?: TelegramFileRef;
	/** Animated GIF (treated as document media). */
	animation?: TelegramFileRef;
	voice?: TelegramFileRef;
}

/**
 * A normalized, platform-agnostic media candidate extracted from a Telegram
 * message — the input to a single `mediaManager.ingest()` call (§9.2/§9.3).
 */
interface MediaCandidate {
	/** opake Telegram file_id (Dedup-Key) */
	fileId: string;
	fileName?: string;
	/** Deklarerter MIME (UNVERTRAUENSWÜRDIG — wird im Manager verifiziert). */
	mime?: string;
	/** Deklarerte Größe in Bytes. */
	size?: number;
	/** Kategorie-Hinweis für den Manager. */
	kind: MediaKind;
}

/** Concept §10 default: max. Anhänge pro Nachricht, bis S6 config-gesetzt ist. */
const DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE = 4;

export class TelegramAdapter extends BaseAdapter {
	readonly platform = "telegram" as const;
	config: TelegramConfig;

	private offset = 0;
	private pollingActive = false;
	private connected = false;

	constructor(config: TelegramConfig) {
		super();
		// TelegramConfig requires `enabled` and `platform` (inherited from
		// PlatformConfig), so no defaults are overridden here.
		this.config = config;
	}

	async initialize(): Promise<void> {
		// Test bot token
		const response = await this.apiRequest("/getMe");
		const data = (await response.json()) as {
			ok: boolean;
			result?: { id: number; username: string; first_name: string };
		};

		if (!response.ok || !data.ok) {
			throw new Error(`Telegram auth failed: ${response.status}`);
		}

		logger.info(`[Telegram] Bot initialized: @${data.result?.username}`);

		// Set webhook if URL configured; otherwise long polling is used
		if (this.config.webhookUrl) {
			await this.apiRequest("/setWebhook", {
				method: "POST",
				body: JSON.stringify({
					url: this.config.webhookUrl,
					...(this.config.webhookSecret
						? { secret_token: this.config.webhookSecret }
						: {}),
				}),
			});
			logger.info(`[Telegram] Webhook set → ${this.config.webhookUrl}`);
		} else {
			logger.info("[Telegram] No webhookUrl — will use long polling");
		}
	}

	private async apiRequest(endpoint: string, options: RequestInit = {}): Promise<Response> {
		const url = `https://api.telegram.org/bot${this.config.token}${endpoint}`;
		return fetch(url, {
			...options,
			signal: AbortSignal.timeout(35_000), // slightly above Telegram's 30s long-poll
			headers: {
				"Content-Type": "application/json",
				Connection: "close", // prevent stale undici connections
				...options.headers,
			},
		});
	}

	/**
	 * Resolve a Telegram `file_id` to its download path via `/getFile`, then
	 * stream the file bytes from `api.telegram.org` (§9.3).
	 *
	 * Returns a Readable for the `MediaManager.ingest` fetch-closure. Any
	 * network/HTTP/protocol failure is normalised into a `MediaError` with a
	 * stable code (`DOWNLOAD_FAILED`, `TIMEOUT`, `VALIDATION_FAILED`) so the
	 * calling `handleUpdate` loop can react deterministically (§8 E3–E6).
	 */
	private async downloadFile(fileId: string): Promise<Readable> {
		// 1) Telegram does not expose the download URL in the update; a separate
		//    /getFile call returns the server-side `file_path`.
		let res: Response;
		try {
			res = await this.apiRequest("/getFile", {
				method: "POST",
				body: JSON.stringify({ file_id: fileId }),
			});
		} catch (err) {
			throw new MediaError(
				"DOWNLOAD_FAILED",
				`getFile request failed: ${(err as Error).message || err}`,
			);
		}

		let data: { ok: boolean; result?: { file_path?: string } };
		try {
			data = (await res.json()) as { ok: boolean; result?: { file_path?: string } };
		} catch {
			throw new MediaError("VALIDATION_FAILED", "Invalid getFile response from Telegram");
		}

		if (!data.ok || !data.result?.file_path) {
			throw new MediaError(
				"DOWNLOAD_FAILED",
				`getFile failed for ${truncateRef(fileId)}: ${res.status}`,
			);
		}

		// 2) Stream the actual bytes. The Bot token rides in the URL — internal
		//    only, never logged (§11). Abort after 60 s per concept §9.3.
		let dl: Response;
		try {
			dl = await fetch(
				`https://api.telegram.org/file/bot${this.config.token}/${data.result.file_path}`,
				{ signal: AbortSignal.timeout(60_000) },
			);
		} catch (err) {
			const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
			throw new MediaError(
				isTimeout ? "TIMEOUT" : "DOWNLOAD_FAILED",
				isTimeout
					? `Download timed out after 60 s`
					: `Download network error: ${(err as Error).message || err}`,
			);
		}

		if (!dl.ok || !dl.body) {
			throw new MediaError("DOWNLOAD_FAILED", `Download HTTP ${dl.status}`);
		}

		// Node ≥ 20: convert the web ReadableStream to a Node Readable.
		return Readable.fromWeb(dl.body as import("node:stream/web").ReadableStream);
	}

	async start(callbacks: AdapterCallbacks): Promise<void> {
		await super.start(callbacks);

		if (!this.config.webhookUrl) {
			// Long polling — keep a persistent connection and receive messages near-real-time
			this.startLongPolling();
		}
		// Webhook mode: gateway's HTTP server calls handleWebhookUpdate() on each POST
	}

	/**
	 * Long polling via getUpdates.
	 *
	 * Telegram holds the connection open (up to `timeout` seconds) and
	 * returns immediately when a message arrives. This is NOT interval-
	 * based polling — it is near-real-time, similar to a persistent
	 * connection. Used as a fallback when no webhookUrl is configured.
	 */
	private startLongPolling(): void {
		this.connected = true;
		this.pollingActive = true;
		this.longPoll();
	}

	private async longPoll(): Promise<void> {
		let backoff = 1000; // start at 1s, max ~30s
		while (this.pollingActive) {
			try {
				const response = await this.apiRequest("/getUpdates", {
					method: "POST",
					body: JSON.stringify({
						offset: this.offset,
						timeout: 30, // Telegram long-poll timeout (seconds)
					}),
				});

				// Reset backoff on successful connection
				backoff = 1000;

				if (!response.ok) {
					logger.error(`[Telegram] Poll HTTP ${response.status}`);
					await this.sleep(5000);
					continue;
				}

				const data = (await response.json()) as {
					ok: boolean;
					result?: TelegramUpdate[];
				};

				if (data.ok && data.result && data.result.length > 0) {
					for (const update of data.result) {
						// Fire-and-forget: do NOT await — msg processing blocks up to 5 min
						// while waiting for agent_end. If we await, no new /getUpdates
						// requests can be made, and callback queries get buffered by Telegram.
						this.handleUpdate(update).catch((err) => {
							logger.error(
								`[Telegram] Error handling update: ${(err as Error).message || err}`,
							);
						});
						this.offset = update.update_id + 1;
					}
				}
			} catch (err) {
				// Transient network errors are expected on long-lived connections
				logger.warn(
					`[Telegram] Poll retry in ${Math.round(backoff / 1000)}s — ${(err as Error).message || err}`,
				);
				await this.sleep(backoff);
				backoff = Math.min(backoff * 2, 30_000);
			}
		}
	}

	private async handleUpdate(update: TelegramUpdate): Promise<void> {
		// Handle messages
		if (update.message || update.edited_message) {
			const msg = update.message || update.edited_message;
			// Narrow the union — either branch may be undefined at compile time.
			if (!msg) return;

			// Check if this is a ForceReply response (reply to an interactive prompt)
			if (
				msg.reply_to_message?.reply_markup?.force_reply &&
				this.callbacks?.onInteractiveResponse
			) {
				const content = msg.text || msg.caption || "";
				if (content) {
					// Generate a requestId — we don't have the original ID
					// from the message text, so we use a correlation approach.
					// The ForceReply message was sent for the current active prompt.
					// We just forward it; interactive.ts will correlate.
					this.callbacks.onInteractiveResponse({
						requestId: "", // filled by interactive.ts via activeChannel
						value: content,
					});
					return;
				}
			}

			// Check if chat is allowed
			if (
				this.config.allowedChats &&
				!this.config.allowedChats.includes(String(msg.chat.id))
			) {
				return;
			}

			// Check if username is required
			if (this.config.requireUsername && !msg.from?.username) {
				// Could send "Please set a username" message here
				return;
			}

			const content = msg.text || msg.caption || "";

			// Phase 3 (S5): extract media candidates from the message (photo →
			// highest-res; document/audio/video/animation/voice → single entry),
			// then ingest each through the shared MediaManager. Errors are
			// reported back to the chat per-attachment (§8 E1–E8) while the rest
			// of the message keeps flowing (§9.2).
			const candidates = extractTelegramMedia(msg);
			if (!content && candidates.length === 0) {
				// Invariant: nothing to process (§9.2).
				return;
			}

			const attachments: MediaAttachment[] = [];
			const failures: string[] = [];
			const mediaManager = runtime.media ?? initMediaManager();
			// S6 wires `runtime.config.media.maxAttachmentsPerMessage`; until then
			// the concept default applies (§9.2 / §10).
			const maxPerMsg = DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE;

			for (const cand of candidates.slice(0, maxPerMsg)) {
				try {
					const attachment = await mediaManager.ingest({
						platform: "telegram",
						messageId: String(msg.message_id),
						channelId: String(msg.chat.id),
						userId: String(msg.from?.id || 0),
						fileRef: cand.fileId,
						fileName: cand.fileName,
						declaredMime: cand.mime,
						declaredSizeBytes: cand.size,
						kindHint: cand.kind,
						// Lazy-Download-Closure: getFile → file_path → HTTP-Stream (§9.3).
						fetch: () => this.downloadFile(cand.fileId),
					});
					attachments.push(attachment);
				} catch (err) {
					const userText = mediaErrorToUserMessage(err, cand);
					logger.warn(`[Telegram] Media ingest failed: ${userText}`);
					// Diagnostic: log the technical cause (contains declared MIME) for
					// attachments, so unsupported-type cases are debuggable from the log.
					logger.info(
						`[Telegram] ingest failure detail: ${err instanceof Error ? err.message : String(err)}`,
					);
					failures.push(userText);
				}
			}

			// Report per-attachment failures as a single text message (§8).
			if (failures.length > 0) {
				this.sendMessage(String(msg.chat.id), failures.join("\n")).catch(() =>
					logger.warn("[Telegram] Failed to notify user about media errors"),
				);
			}

			// E9: everything failed and there is no text → nothing to emit.
			if (!content && attachments.length === 0) return;

			const message: PlatformMessage = {
				id: this.generateMessageId(),
				platform: "telegram",
				channelId: String(msg.chat.id),
				userId: String(msg.from?.id || 0),
				content,
				timestamp: msg.date * 1000,
				metadata: {
					username: msg.from?.username,
					firstName: msg.from?.first_name,
					chatType: msg.chat.type,
					chatTitle: msg.chat.title,
					isEdited: !!update.edited_message,
				},
				attachments: attachments.length > 0 ? attachments : undefined,
			};

			await this.emitMessage(message);
		}

		// Handle callback queries (button presses)
		if (update.callback_query) {
			const query = update.callback_query;
			const data: string = query.data || "";
			logger.info(`[Telegram] Callback query received: ${data}`);

			// Route interactive UI callbacks (buttons from sendInteractive)
			// Formats:
			//   ui:s:requestId:optionLabel  → select (value = label)
			//   ui:c:requestId:1|0          → confirm (confirmed = boolean)
			//   ui:requestId:value          → legacy fallback
			if (data.startsWith("ui:") && this.callbacks?.onInteractiveResponse) {
				const parts = data.split(":");
				logger.info(
					`[Telegram] Routing interactive callback: parts=${JSON.stringify(parts)}`,
				);

				if (parts[1] === "s" || parts[1] === "c") {
					// New format: ui:s:requestId:... or ui:c:requestId:...
					const methodType = parts[1];
					const requestId = parts[2];
					const rawValue = parts.slice(3).join(":");
					logger.info(
						`[Telegram] Interactive callback — method=${methodType}, requestId=${requestId.slice(0, 8)}…, rawValue=${rawValue}`,
					);

					if (methodType === "c") {
						// Confirm: rawValue is "1" (yes) or "0" (no)
						this.callbacks.onInteractiveResponse({
							requestId,
							confirmed: rawValue === "1",
						});
					} else {
						// Select: rawValue is the option index
						this.callbacks.onInteractiveResponse({
							requestId,
							value: rawValue,
						});
					}
				} else {
					// Legacy format: ui:requestId:value
					const requestId = parts[1];
					const rawValue = parts.slice(2).join(":");

					this.callbacks.onInteractiveResponse({
						requestId,
						value: rawValue,
					});
				}

				// Answer callback to dismiss loading spinner
				await this.apiRequest("/answerCallbackQuery", {
					method: "POST",
					body: JSON.stringify({ callback_query_id: query.id }),
				});

				// Remove inline keyboard so the user can't click again
				if (query.message) {
					this.apiRequest("/editMessageReplyMarkup", {
						method: "POST",
						body: JSON.stringify({
							chat_id: query.message.chat.id,
							message_id: query.message.message_id,
						}),
					}).catch(() => {
						// Ignore — message may have been deleted
					});
				}
				return;
			}

			const message: PlatformMessage = {
				id: this.generateMessageId(),
				platform: "telegram",
				channelId: String(query.message?.chat.id || query.from.id),
				userId: String(query.from.id),
				content: `Callback: ${query.data}`,
				timestamp: query.message?.date ? query.message.date * 1000 : Date.now(),
				metadata: {
					callbackId: query.id,
					callbackData: query.data,
					username: query.from.username,
				},
			};

			await this.emitMessage(message);

			// Answer callback to remove loading state
			await this.apiRequest("/answerCallbackQuery", {
				method: "POST",
				body: JSON.stringify({ callback_query_id: query.id }),
			});
		}
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	async stop(): Promise<void> {
		this.connected = false;
		this.pollingActive = false;
		await super.stop();
	}

	async sendMessage(channelId: string, content: string): Promise<string> {
		const response = await this.apiRequest("/sendMessage", {
			method: "POST",
			body: JSON.stringify({
				chat_id: channelId,
				text: content,
				parse_mode: "HTML",
			}),
		});

		const data = (await response.json()) as {
			ok: boolean;
			result?: { message_id: number };
		};

		if (!data.ok) {
			throw new Error(`Failed to send message: ${JSON.stringify(data)}`);
		}

		return String(data.result?.message_id || 0);
	}

	async sendPhoto(channelId: string, photoUrl: string, caption?: string): Promise<string> {
		const response = await this.apiRequest("/sendPhoto", {
			method: "POST",
			body: JSON.stringify({
				chat_id: channelId,
				photo: photoUrl,
				caption,
				parse_mode: "HTML",
			}),
		});

		const data = (await response.json()) as {
			ok: boolean;
			result?: { message_id: number };
		};

		if (!data.ok) {
			throw new Error(`Failed to send photo: ${JSON.stringify(data)}`);
		}

		return String(data.result?.message_id || 0);
	}

	async sendButtons(
		channelId: string,
		text: string,
		buttons: Array<Array<{ text: string; data: string }>>,
	): Promise<string> {
		const replyMarkup = {
			inline_keyboard: buttons.map((row) =>
				row.map((btn) => ({ text: btn.text, callback_data: btn.data })),
			),
		};

		const response = await this.apiRequest("/sendMessage", {
			method: "POST",
			body: JSON.stringify({
				chat_id: channelId,
				text,
				parse_mode: "HTML",
				reply_markup: replyMarkup,
			}),
		});

		const data = (await response.json()) as {
			ok: boolean;
			result?: { message_id: number };
		};

		if (!data.ok) {
			throw new Error(`Failed to send buttons: ${JSON.stringify(data)}`);
		}

		return String(data.result?.message_id || 0);
	}

	/** Send an interactive prompt with native Telegram UI. */
	async sendInteractive(
		channelId: string,
		prompt: InteractivePrompt,
	): Promise<{ messageId: string }> {
		switch (prompt.method) {
			case "select": {
				const options = prompt.options || [];
				if (options.length === 0) {
					// No options to display — fall back to a plain message
					const messageId = await this.sendMessage(
						channelId,
						`<b>${escapeHtml(prompt.title)}</b>`,
					);
					return { messageId };
				}
				const buttons = options.map((opt, i) => [
					{
						text: opt,
						data: `ui:s:${prompt.requestId}:${i}`,
					},
				]);
				const messageId = await this.sendButtons(
					channelId,
					`<b>${escapeHtml(prompt.title)}</b>`,
					buttons,
				);
				return { messageId };
			}
			case "confirm": {
				const text = prompt.message
					? `<b>${escapeHtml(prompt.title)}</b>\n\n<i>${escapeHtml(prompt.message)}</i>`
					: `<b>${escapeHtml(prompt.title)}</b>`;
				const buttons = [
					[
						{ text: "✅ Yes", data: `ui:c:${prompt.requestId}:1` },
						{ text: "❌ No", data: `ui:c:${prompt.requestId}:0` },
					],
				];
				const messageId = await this.sendButtons(channelId, text, buttons);
				return { messageId };
			}
			case "input":
			case "editor": {
				const hint = prompt.placeholder ? `\n<i>${escapeHtml(prompt.placeholder)}</i>` : "";
				const prefill = prompt.prefill
					? `\n\n<pre>${escapeHtml(prompt.prefill)}</pre>`
					: "";
				const text =
					`<b>${escapeHtml(prompt.title)}</b>${hint}${prefill}\n\n` +
					`<i>Reply to this message with your ${prompt.method === "editor" ? "text" : "input"}.</i>`;
				const response = await this.apiRequest("/sendMessage", {
					method: "POST",
					body: JSON.stringify({
						chat_id: channelId,
						text,
						parse_mode: "HTML",
						reply_markup: { force_reply: true },
					}),
				});
				const data = (await response.json()) as {
					ok: boolean;
					result?: { message_id: number };
				};
				if (!data.ok) {
					throw new Error(`Failed to send ForceReply: ${JSON.stringify(data)}`);
				}
				return { messageId: String(data.result?.message_id || 0) };
			}
			case "notify":
			case "setStatus":
			case "setWidget":
			case "setTitle":
			case "set_editor_text": {
				const text = prompt.message || prompt.title;
				// Skip if pi clears a widget/status with no content (e.g. setWidget(name, undefined))
				if (!text) {
					return { messageId: "0" };
				}
				const icon =
					prompt.notifyType === "warning"
						? "⚠️"
						: prompt.notifyType === "error"
							? "❌"
							: "ℹ️";
				const messageId = await this.sendMessage(channelId, `${icon} ${text}`);
				return { messageId };
			}
			default: {
				logger.warn(
					`[telegram] Unknown interactive method "${prompt.method}", falling back to text`,
				);
				return super.sendInteractive(channelId, prompt);
			}
		}
	}

	async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
		await this.apiRequest("/editMessageText", {
			method: "POST",
			body: JSON.stringify({
				chat_id: channelId,
				message_id: parseInt(messageId),
				text: content,
				parse_mode: "HTML",
			}),
		});
	}

	async deleteMessage(channelId: string, messageId: string): Promise<void> {
		await this.apiRequest("/deleteMessage", {
			method: "POST",
			body: JSON.stringify({
				chat_id: channelId,
				message_id: parseInt(messageId),
			}),
		});
	}

	/** Remove inline keyboard from a message. */
	override async cleanupInteractive(channelId: string, messageId: string): Promise<void> {
		await this.apiRequest("/editMessageReplyMarkup", {
			method: "POST",
			body: JSON.stringify({
				chat_id: channelId,
				message_id: parseInt(messageId),
			}),
		});
	}

	async setTyping(channelId: string, isTyping: boolean): Promise<void> {
		const action = isTyping ? "typing" : "cancel";
		await this.apiRequest("/sendChatAction", {
			method: "POST",
			body: JSON.stringify({
				chat_id: channelId,
				action,
			}),
		});
	}

	async getStatus(): Promise<{ connected: boolean; latency?: number }> {
		return { connected: this.connected };
	}

	async getMe(): Promise<{ id: number; username: string; first_name: string }> {
		const response = await this.apiRequest("/getMe");
		const data = (await response.json()) as {
			ok: boolean;
			result: { id: number; username: string; first_name: string };
		};
		return data.result;
	}

	// Handle webhook update (called from HTTP handler)
	async handleWebhookUpdate(update: TelegramUpdate): Promise<void> {
		if (this.config.webhookSecret) {
			// Verify secret here
		}
		await this.handleUpdate(update);
	}
}

// ── Helpers ─────────────────────────────────────────────────────────────────┐

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Extract normalized media candidates from a Telegram message (§9.1/§9.2).
 *
 * - `photo[]` → the single highest-resolution size (largest width×height, then
 *   largest file_size as tiebreaker). Telegram sends the array ordered by
 *   ascending size, so usually the last entry wins.
 * - `document` / `audio` / `video` / `animation` / `voice` → exactly one
 *   candidate each, with the platform-supplied metadata.
 *
 * Returns an empty array when the message carries no (recognized) media.
 */
export function extractTelegramMedia(msg: TelegramMessage): MediaCandidate[] {
	const candidates: MediaCandidate[] = [];

	if (Array.isArray(msg.photo) && msg.photo.length > 0) {
		const best = msg.photo.reduce<TelegramPhotoSize | null>((chosen, size) => {
			if (!chosen) return size;
			const area = size.width * size.height;
			const chosenArea = chosen.width * chosen.height;
			if (area > chosenArea) return size;
			// Tie-break on file_size (more bytes usually means higher quality).
			if (area === chosenArea && (size.file_size ?? 0) > (chosen.file_size ?? 0)) {
				return size;
			}
			return chosen;
		}, null);
		if (best) {
			candidates.push({
				fileId: best.file_id,
				// Telegram does not always supply a name for photos — fall back to
				// a descriptive placeholder. The manager sanitizes it anyway.
				fileName: best.file_name,
				mime: best.mime_type ?? "image/jpeg",
				size: best.file_size,
				kind: "image",
			});
		}
	}

	for (const field of ["document", "audio", "video", "animation", "voice"] as const) {
		const ref = msg[field];
		if (!ref) continue;
		// heuristic kind mapping (§10.1): animation is a GIF → classify as image
		// only if we know it is animatable; otherwise treat as document.
		let kind: MediaKind;
		if (field === "audio" || field === "voice") kind = "audio";
		else if (field === "video") kind = "video";
		else if (field === "animation") kind = "image";
		else kind = "document";

		candidates.push({
			fileId: ref.file_id,
			fileName: ref.file_name,
			mime: ref.mime_type,
			size: ref.file_size,
			kind,
		});
	}

	return candidates;
}

/**
 * Map a `MediaError` (or any thrown `Error`) to a user-facing German message
 * per concept §8 (E1–E8). Used to report per-attachment ingest failures back
 * into the Telegram chat without crashing the message flow.
 */
export function mediaErrorToUserMessage(err: unknown, cand: MediaCandidate): string {
	const name = cand.fileName ? `„${sanitizeFileNameForDisplay(cand.fileName)}“` : "Datei";
	if (err instanceof MediaError) {
		switch (err.code) {
			case "SIZE_EXCEEDED":
				return `⚠️ ${name} ist zu groß (max. 20 MB).`;
			case "UNSUPPORTED_TYPE":
				return `⚠️ Dateityp von ${name} wird nicht unterstützt.`;
			case "DOWNLOAD_FAILED":
				return `⚠️ Download von ${name} fehlgeschlagen. Bitte erneut senden.`;
			case "TIMEOUT":
				return `⚠️ Download von ${name} hat zu lange gedauert. Bitte erneut senden.`;
			case "VALIDATION_FAILED":
				return `⚠️ Dateityp von ${name} konnte nicht verifiziert werden.`;
			case "QUOTA_EXCEEDED":
				return `⚠️ Speicher voll — ${name} konnte nicht gespeichert werden.`;
			default:
				return `⚠️ ${name} konnte nicht verarbeitet werden.`;
		}
	}
	logger.warn(`[Telegram] Unexpected media error: ${(err as Error)?.message ?? err}`);
	return `⚠️ ${name} konnte nicht verarbeitet werden.`;
}

/** Strip control characters before embedding a (sanitized) filename in chat text. */
function sanitizeFileNameForDisplay(raw: string): string {
	// Split on any char whose code is < 0x20 or === 0x7f (control chars). Built
	// via a range so ESLint's `no-control-regex` stays quiet.
	return raw
		.split("")
		.filter((ch) => {
			const c = ch.charCodeAt(0);
			return c >= 0x20 && c !== 0x7f;
		})
		.join("")
		.slice(0, 128);
}

/** Truncated file_id for structured logging (never log the download URL §11). */
function truncateRef(ref: string): string {
	return ref.length > 12 ? `${ref.slice(0, 12)}…` : ref;
}
