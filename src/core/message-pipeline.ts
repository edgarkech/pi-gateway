import { logger } from "../logger.js";
import { runtime } from "../state.js";
import { getOrCreateSession, deleteSession } from "../sessions/store.js";
import {
	isUserAllowed,
	isAdmin,
	isRateLimited,
	isPairingRequired,
	generatePairingCode,
	isPlatform,
	type Platform,
} from "../security/auth.js";
import { buildPolicyGuard } from "../security/tool-policy.js";
import {
	handleInteractiveResponse,
	setActiveChannel,
	setStreamRedirectHandler,
	setFlushHandler,
} from "../interactive.js";
import type { AdapterCallbacks, PlatformMessage, InteractiveResponse } from "../adapters/base.js";
import {
	sendRpc,
	sendPromptRpc,
	restartRpc,
	isAgentRunning,
	peekActiveCompletion,
	resetActiveStream,
} from "./rpc.js";
import { updateStatus } from "./status-footer.js";
import { isDaemonMode } from "./daemon.js";
import {
	buildAttachmentManifest,
	readAttachmentImage,
	DEFAULT_MAX_IMAGE_BYTES,
} from "../media/manifest.js";
import { initMediaManager } from "../media/manager.js";
import type { ImageContent, MediaAttachment } from "../media/types.js";

const adapterCallbacks: AdapterCallbacks = {
	onMessage: async (message: PlatformMessage) => {
		// Validate the platform string up front and narrow it to the Platform
		// union, replacing the former repeated `message.platform as Platform` casts.
		const platform: Platform = isPlatform(message.platform)
			? message.platform
			: (logger.warn(`[gateway] Unknown platform "${message.platform}" — forcing to "web"`),
				"web" as const);

		// Get or create session for this chat
		const session = getOrCreateSession(message.platform, message.channelId, message.userId, {
			resetPolicy: runtime.config.sessions.resetPolicy,
			dailyHour: runtime.config.sessions.dailyHour,
			idleMinutes: runtime.config.sessions.idleMinutes,
		});

		// Rate limiting: block users that exceed the configured threshold
		if (isRateLimited(platform, message.userId)) {
			logger.warn(`[gateway] Rate limit exceeded for ${message.platform}/${message.userId}`);
			await discardMediaAttachments(message.attachments);
			const adapter = runtime.state.adapters.get(message.platform);
			if (adapter) {
				await adapter.sendMessage(
					message.channelId,
					"You are sending messages too quickly. Please slow down and try again shortly.",
				);
			}
			return;
		}

		// Check allowlist
		if (!isUserAllowed(platform, message.userId)) {
			logger.info(`[gateway] User ${message.userId} not in allowlist`);
			await discardMediaAttachments(message.attachments);
			const adapter = runtime.state.adapters.get(message.platform);
			if (isPairingRequired()) {
				if (adapter) {
					const code = generatePairingCode(platform, message.userId);
					await adapter.sendMessage(
						message.channelId,
						`Pairing required. Send this code to the administrator: ${code}`,
					);
				}
			} else if (adapter) {
				await adapter.sendMessage(
					message.channelId,
					"You are not allowed to use this agent. Contact the administrator to request access.",
				);
			}
			return;
		}

		// Store session reference
		runtime.state.sessions.set(`${message.platform}:${message.channelId}`, session);

		// ── Admin/allowed model commands ──
		const modelMatch = message.content.match(/^\/model(?:\s+(.+))?/i);
		const modelCallback = message.content.match(/^Callback:\s*model:(.+)/i);

		if ((modelMatch || modelCallback) && isUserAllowed(platform, message.userId)) {
			const adapter = runtime.state.adapters.get(message.platform);
			if (!isAgentRunning()) {
				if (adapter) {
					await adapter.sendMessage(message.channelId, "Agent not running.");
				}
				return;
			}

			// Handle callback from inline keyboard
			if (modelCallback) {
				const key = modelCallback[1].trim();
				const [provider, modelId] = key.split("/");
				if (!provider || !modelId) return;

				// Only admins can actually switch models
				if (!isAdmin(platform, message.userId)) {
					if (adapter) {
						await adapter.sendMessage(
							message.channelId,
							"Only admins can switch models.",
						);
					}
					return;
				}

				try {
					const result = (await sendRpc("set_model", {
						provider,
						modelId,
					})) as {
						success: boolean;
						error?: string;
						data?: { name: string };
					};
					if (result.success) {
						const name = result.data?.name || `${provider}/${modelId}`;
						if (adapter) {
							await adapter.sendMessage(
								message.channelId,
								`✅ Model changed to ${name}`,
							);
						}
						logger.info(
							`[gateway] Admin ${message.userId} switched model to ${provider}/${modelId}`,
						);
					} else {
						if (adapter) {
							await adapter.sendMessage(
								message.channelId,
								`❌ Failed: ${result.error || "unknown"}`,
							);
						}
					}
				} catch (err) {
					logger.error("[gateway] Model switch failed:", err);
				}
				return;
			}

			const arg = (modelMatch?.[1] || "").trim().toLowerCase();

			// /model (no args) or /model list → show available models
			if (!arg || arg === "list") {
				try {
					const result = (await sendRpc("get_available_models")) as {
						success: boolean;
						data?: {
							models: Array<{
								provider: string;
								id: string;
								name: string;
							}>;
						};
					};
					if (result.success && result.data) {
						const models = result.data.models;

						// Try inline keyboard for Telegram
						const telegram = adapter as unknown as {
							sendButtons?: (
								ch: string,
								text: string,
								btns: Array<Array<{ text: string; data: string }>>,
							) => Promise<string>;
						};
						if (telegram?.sendButtons) {
							const buttons = models.map((m) => [
								{
									text: `${m.name} (${m.provider})`,
									data: `model:${m.provider}/${m.id}`,
								},
							]);
							await telegram.sendButtons(
								message.channelId,
								"<b>Available models</b>\nTap to switch:",
								buttons,
							);
						} else if (adapter) {
							// Text fallback
							const list = models
								.map((m) => `• ${m.provider}/${m.id} — ${m.name}`)
								.join("\n");
							await adapter.sendMessage(
								message.channelId,
								`Available models:\n${list}\n\nUse \`/model provider/id\` to switch.`,
							);
						}
					} else if (adapter) {
						await adapter.sendMessage(
							message.channelId,
							"Could not retrieve model list.",
						);
					}
				} catch (err) {
					logger.error("[gateway] Failed to list models:", err);
					if (adapter) {
						await adapter.sendMessage(
							message.channelId,
							"Failed to retrieve model list.",
						);
					}
				}
				return;
			}

			// /model provider/modelId — only admins can switch
			if (!isAdmin(platform, message.userId)) {
				if (adapter) {
					await adapter.sendMessage(
						message.channelId,
						"Only admins can switch models. Use `/model` to see available models.",
					);
				}
				return;
			}

			const [provider, modelId] = arg.split("/");
			if (!provider || !modelId) {
				if (adapter) {
					await adapter.sendMessage(
						message.channelId,
						"Usage: `/model provider/modelId`\n`/model` to see available models.",
					);
				}
				return;
			}

			try {
				const result = (await sendRpc("set_model", {
					provider,
					modelId,
				})) as { success: boolean; error?: string; data?: { name: string } };
				if (result.success) {
					const name = result.data?.name || `${provider}/${modelId}`;
					if (adapter) {
						await adapter.sendMessage(message.channelId, `✅ Model changed to ${name}`);
					}
					logger.info(
						`[gateway] Admin ${message.userId} switched model to ${provider}/${modelId}`,
					);
				} else {
					if (adapter) {
						await adapter.sendMessage(
							message.channelId,
							`❌ Failed: ${result.error || "unknown"}`,
						);
					}
				}
			} catch (err) {
				logger.error("[gateway] Failed to change model:", err);
				if (adapter) {
					await adapter.sendMessage(message.channelId, "Failed to change model.");
				}
			}
			return;
		}

		// ── Admin restart command ──
		if (/^\/restart$/i.test(message.content.trim())) {
			if (!isAdmin(platform, message.userId)) {
				// Non-admin: let pi handle it as a normal prompt
			} else if (isDaemonMode) {
				// In daemon mode: restart the entire gateway
				const adapter = runtime.state.adapters.get(message.platform);
				if (adapter) {
					await adapter.sendMessage(message.channelId, "♻️ Restarting gateway daemon…");
				}
				// Send SIGHUP to self for graceful restart
				process.kill(process.pid, "SIGHUP");
				return;
			} else {
				const adapter = runtime.state.adapters.get(message.platform);
				if (adapter) {
					await adapter.sendMessage(message.channelId, "♻️ Restarting pi agent…");
				}

				// Kill and restart the pi RPC process
				restartRpc();

				logger.info(`[gateway] Admin ${message.userId} restarted pi agent`);

				if (adapter) {
					await adapter.sendMessage(message.channelId, "✅ Pi agent restarted.");
				}
				return;
			}
		}

		// ── Meta Commands: /new, /status ──
		const newMatch = message.content.match(/^\/new$/i);
		const statusMatch = message.content.match(/^\/status$/i);

		if (newMatch || statusMatch) {
			const adapter = runtime.state.adapters.get(message.platform);
			if (!adapter) return;

			if (newMatch) {
				await deleteSession(session.id);
				await adapter.sendMessage(
					message.channelId,
					"🆕 *Neue Session gestartet.*\nDer bisherige Kontext wurde gelöscht.",
				);
				return;
			}

			if (statusMatch) {
				const date = new Date(session.createdAt).toLocaleString("de-DE");
				const lastAct = new Date(session.lastActivity).toLocaleTimeString("de-DE");
				const statusMsg =
					`📊 *Session Status*\n\n` +
					`🆔 ID: \`${session.id}\`\n` +
					`📱 Plattform: ${session.platform}\n` +
					`📅 Erstellt: ${date}\n` +
					`🕒 Letzte Aktivität: ${lastAct}`;
				await adapter.sendMessage(message.channelId, statusMsg);
				return;
			}
		}

		// Send to pi agent with tool policy guard
		if (isAgentRunning()) {
			const adapter = runtime.state.adapters.get(message.platform);
			const guard = buildPolicyGuard(message.platform, message.userId);

			// Send an initial placeholder message so we can stream edits into it
			let sentId: string | undefined;
			if (adapter) {
				try {
					await adapter.setTyping(message.channelId, true);
					sentId = await adapter.sendMessage(message.channelId, "⏳ Thinking…");
				} catch {
					// If sendMessage itself fails, don't even try to process
					logger.error("[gateway] Failed to send initial placeholder message");
					return;
				}
			}

			// Keep the typing indicator alive while waiting for a response.
			// Telegram's typing action lasts ~5s, so send a heartbeat every 4s.
			let typingInterval: ReturnType<typeof setInterval> | undefined;
			if (adapter) {
				typingInterval = setInterval(() => {
					adapter!.setTyping(message.channelId, true).catch(() => {});
				}, 4000);
			}

			// Track which channel triggered this prompt for UI request routing
			setActiveChannel({
				platform: message.platform,
				channelId: message.channelId,
			});

			let preText = "";

			// When extension_ui_request arrives (select prompt about to show),
			// flush full accumulated text into the placeholder
			setFlushHandler(() => {
				if (!adapter) return;
				const completion = peekActiveCompletion();
				if (completion?.streamedText && sentId) {
					preText = completion.streamedText;
					adapter
						.editMessage(message.channelId, sentId, completion.streamedText)
						.catch(() => {});
				}
			});
			// When user clicks (via handleInteractiveResponse), invalidate
			// old placeholder and redirect to fresh message
			setStreamRedirectHandler(() => {
				if (!adapter) return;
				resetActiveStream();
				sentId = undefined;
				adapter
					.sendMessage(message.channelId, "⏳ Thinking…")
					.then((newId) => {
						sentId = newId;
					})
					.catch(() => {});
			});

			try {
				logger.info(
					`[gateway] Sending prompt from ${message.platform}/${message.userId} (session: ${session.id.slice(0, 12)}...)`,
				);

				// Stream deltas into the placeholder message, then wait for agent_end
				let lastEditTime = 0;
				const EDIT_THROTTLE_MS = 400; // max 2.5 edits/sec to avoid rate limits

				// Phase 3: build the prompt from the policy guard + attachment
				// manifest + user content, and inline images as base64 (§7.3).
				const { promptText, images } = await assemblePromptWithAttachments({
					guard,
					content: message.content,
					attachments: message.attachments,
				});

				const responseText = await sendPromptRpc(
					promptText,
					session.id,
					images.length > 0 ? images : undefined,
					adapter && sentId
						? (streamText: string) => {
								const now = Date.now();
								const currentId = sentId;
								if (currentId && now - lastEditTime >= EDIT_THROTTLE_MS) {
									lastEditTime = now;
									adapter
										.editMessage(message.channelId, currentId, streamText)
										.catch(() => {});
								}
							}
						: undefined,
				);

				logger.info(
					`[gateway] Response received, length: ${responseText.length}, sending back to ${message.platform}/${message.channelId}`,
				);

				if (responseText && adapter) {
					// Walk char-by-char to strip pre-question text from the full
					// agent_end response when a flush happened
					let finalText = responseText;
					if (preText) {
						let pos = 0;
						while (
							pos < preText.length &&
							pos < responseText.length &&
							preText[pos] === responseText[pos]
						) {
							pos++;
						}
						if (pos >= preText.length) {
							finalText = responseText.slice(pos).trim();
						}
					}
					if (sentId) {
						await adapter.editMessage(message.channelId, sentId, finalText);
					} else {
						await adapter.sendMessage(message.channelId, finalText);
					}
					clearInterval(typingInterval);
					await adapter.setTyping(message.channelId, false);
					logger.info("[gateway] Response sent to platform successfully");
				} else if (!responseText && adapter) {
					logger.warn("[gateway] Response text was empty — nothing to send");
					if (sentId) {
						await adapter.editMessage(
							message.channelId,
							sentId,
							"I processed your message but had no text response. Please try again.",
						);
					} else {
						await adapter.sendMessage(
							message.channelId,
							"I processed your message but had no text response. Please try again.",
						);
					}
					clearInterval(typingInterval);
					await adapter.setTyping(message.channelId, false);
				}
			} catch (err) {
				logger.error("[gateway] RPC error processing message:", err);
				clearInterval(typingInterval);
				if (adapter) {
					try {
						const errorMsg =
							"Sorry, I encountered an error processing your message. Please try again.";
						if (sentId) {
							await adapter.editMessage(message.channelId, sentId, errorMsg);
						} else {
							await adapter.sendMessage(message.channelId, errorMsg);
						}
						await adapter.setTyping(message.channelId, false);
					} catch (sendErr) {
						logger.error("[gateway] Failed to send error message:", sendErr);
					}
				}
			}
		} else {
			logger.warn("[gateway] pi agent not running — cannot process message");
			await discardMediaAttachments(message.attachments);
		}
	},
	onInteractiveResponse: (response: InteractiveResponse) => {
		handleInteractiveResponse(response);
	},
	onDisconnect: () => {
		logger.info("[gateway] Platform adapter disconnected");
		void updateStatus();
	},
};

export { adapterCallbacks };

// ── Phase 3 (File-Attachments) helpers ────────────────────────────────────

/**
 * Best-effort deletion of media attachments (concept §7.1 step 3 / §8 E12).
 * Called when a message is rejected downstream (rate limit, allowlist denial,
 * agent not running) so no orphaned files linger in the store. Never throws.
 */
async function discardMediaAttachments(
	attachments: readonly MediaAttachment[] | undefined,
): Promise<void> {
	if (!attachments || attachments.length === 0) return;
	try {
		const manager = initMediaManager();
		await manager.discard(attachments.map((a) => a.id));
	} catch (err) {
		logger.warn("[gateway] Failed to discard media attachments:", err);
	}
}

/**
 * Arguments for `assemblePromptWithAttachments`.
 */
export interface AssemblePromptArgs {
	/** The policy/system guard prepended before the manifest (concept §7.3). */
	guard: string;
	/** The user's text content. May be empty for media-only messages. */
	content: string;
	/** Validated attachments (optional — message without files). */
	attachments?: readonly MediaAttachment[];
	/**
	 * Cap for inlining an image as base64 (default DEFAULT_MAX_IMAGE_BYTES).
	 * Forward-compatible with S6 config (`runtime.config.media.maxImageBytes`).
	 */
	maxImageBytes?: number;
}

/**
 * Build the final prompt text + inlined images (concept §7.1 step 4 / §7.3).
 *
 * - `promptText = [guard, manifest, userPart].filter(Boolean).join("\n\n")`
 *   where `userPart` is the user's content or a placeholder for media-only
 *   messages.
 * - `images` are the Base64 `ImageContent[]` for size-eligible images that
 *   could be read from disk. Unreadable/large images are tracked so their
 *   manifest lines carry an honest ⚠️ / path hint (§7.4) instead of a crash.
 *
 * Messages without attachments produce the exact legacy string
 * `guard\n\ncontent` — bit-identical to pre-Phase-3 behaviour.
 */
export async function assemblePromptWithAttachments(
	args: AssemblePromptArgs,
): Promise<{ promptText: string; images: ImageContent[] }> {
	const attachments = args.attachments ?? [];
	const maxImageBytes = args.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;

	// No attachments: keep the legacy single-block prompt.
	if (attachments.length === 0) {
		return {
			promptText: [args.guard, args.content].filter(Boolean).join("\n\n"),
			images: [],
		};
	}

	// Classify each image: size-eligible to inline vs. too large; then try to
	// read the eligible ones (failures become ⚠️ manifest lines, not crashes).
	const nonInlined = new Set<string>();
	const unavailable = new Set<string>();
	const images: ImageContent[] = [];

	for (const att of attachments) {
		if (att.kind !== "image") continue;
		if (att.sizeBytes > maxImageBytes) {
			nonInlined.add(att.id);
			continue;
		}
		const content = await readAttachmentImage(att, maxImageBytes);
		if (content) {
			images.push(content);
		} else {
			unavailable.add(att.id);
		}
	}

	const manifest = buildAttachmentManifest(attachments, {
		unavailableImageIds: unavailable,
		nonInlinedImageIds: nonInlined,
	});

	const userPart =
		args.content.length > 0
			? args.content
			: "(Der Nutzer hat keine Textnachricht gesendet, nur Anhänge.)";

	const promptText = [args.guard, manifest, userPart].filter(Boolean).join("\n\n");
	return { promptText, images };
}
