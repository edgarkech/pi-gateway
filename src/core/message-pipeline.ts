import { existsSync } from "node:fs";
import { logger } from "../logger.js";
import { runtime } from "../state.js";
import { getOrCreateSession, deleteSession, setPiSessionFile } from "../sessions/store.js";
import {
	isUserAllowed,
	isAdmin,
	isRateLimited,
	isPairingRequired,
	generatePairingCode,
	isPlatform,
	type Platform,
} from "../security/auth.js";
import { buildPolicyGuard, isBotAddressed } from "../security/tool-policy.js";
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
	newPiSession,
	switchPiSession,
	getPiState,
	setPiSessionName,
} from "./rpc.js";
import { enqueuePromptTask } from "./prompt-queue.js";
import {
	decideChannelCommand,
	resolveRoomType,
	formatChannelStatus,
	formatContextUsage,
	formatModelId,
	parseModelArg,
	type CommandDecision,
} from "./channel-commands.js";
import { updateStatus } from "./status-footer.js";
import { isDaemonMode } from "./daemon.js";
import {
	buildAttachmentManifest,
	readAttachmentImage,
	DEFAULT_MAX_IMAGE_BYTES,
} from "../media/manifest.js";
import { initMediaManager } from "../media/manager.js";
import type { ImageContent, MediaAttachment } from "../media/types.js";

// ── Anti-Bot-Loop (Ansatz B): Kanal-Klassifikation „Gruppe vs. DM" ─────────

/** Ergebnis der Kanal-Klassifikation für den Gruppen-Filter. */
export type ChannelKind = "dm" | "group" | "unknown";

/**
 * Klassifiziert einen Kanal als Direktnachricht, Gruppe/Kanal oder unklar.
 *
 * Quellen (concept-anti-bot-loop-filter §4/§6):
 * - Explizite `groupRooms`-Labels (`gateway:<platform>:<channelId>`)
 *   deterministisch zuerst (z. B. Nextcloud-Talk-Räume ohne DM-Flag).
 * - Platform-Metadaten: Telegram `metadata.chatType` (private vs.
 *   group/supergroup/channel), Discord `metadata.isDM`, WhatsApp
 *   `metadata.isGroup`, Nextcloud-Talk ohne DM-Flag (nur groupRooms).
 *
 * Sicherheitsseite: `unknown` wertet der Filter als NICHT-Gruppe → DM/unklare
 * Kanäle bleiben intakt (Randbedingung des Konzepts).
 */
export function classifyChannel(
	platform: string,
	message: { channelId: string; metadata?: Record<string, unknown> },
	groupRooms?: readonly string[],
): ChannelKind {
	const label = `gateway:${platform}:${message.channelId}`;
	if (groupRooms?.includes(label)) return "group";

	const meta = message.metadata ?? {};
	switch (platform) {
		case "telegram": {
			const t = meta.chatType;
			if (typeof t === "string") {
				if (t === "private") return "dm";
				if (t === "group" || t === "supergroup" || t === "channel") return "group";
			}
			return "unknown";
		}
		case "discord":
			return meta.isDM === true ? "dm" : meta.isDM === false ? "group" : "unknown";
		case "whatsapp":
			return meta.isGroup === true ? "group" : meta.isGroup === false ? "dm" : "unknown";
		default:
			// Nextcloud-Talk & alle anderen ohne DM/Group-Flag: nur über das
			// explizite groupRooms-Label als Gruppe erkennbar, sonst unklar.
			return "unknown";
	}
}

/**
 * Erkennt „leere Nachrichten" im Sinne von concept-anti-bot-loop-filter §5a
 * (2026-09-24, festgezerrt von Edgar):
 *
 * - Länge 0 → leer (`""`).
 * - Länge 1 mit einem NICHT-alphanumerischen Zeichen **außer** `?`/`!` → leer
 *   (gefiltert: `"."`, `","`, `";"`, `":"`, `" "`, …).
 * - NICHT leer (echte Kommunikation): `?`, `!` sowie jede Länge >= 2 und jede
 *   Länge-1-Nachricht mit alphanumerischem Zeichen (`"a"`, `"1"`, …).
 *
 * Diese Nachrichten sind gültiger Loop-Auslösestoff (leere/`.`-Notizen lösen
 * beim Zweitbot eine Modell-Antwort aus → Bot-auf-Bot-Ping-Pong), werden aber
 * als echte Kommunikation behandelt. Der Filter greift GLOBAL (alle Absender,
 * alle Plattformen) zentral im Message-Pfad vor dem Modell-Call — Ausnahme
 * `isBotAddressed` (siehe onMessage).
 */
export function isEmptyMessage(content: string): boolean {
	if (content.length === 0) return true;
	if (content.length !== 1) return false;
	const ch = content[0];
	if (ch === "?" || ch === "!") return false;
	// Alphanumerisch = Unicode-Buchstaben (`\p{L}`) oder Ziffern (`\p{N}`);
	// ein einzelnes alphanumerisches Zeichen ist echte Kommunikation
	// (auch z. B. "Æ"). Alles andere gilt als leer.
	return !/^[\p{L}\p{N}]$/u.test(ch);
}

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

		// 2026-09-20 Festzurrung: Bot-Allowlist-Bypass — gelistete Bots
		// (platforms.nextcloudTalk.allowedBots) laufen wie Menschen durch den
		// Security-Layer; fremde Bots werden still verworfen (keine Meldung —
		// sie würde Lärm + Antwort-Loops provozieren).
		const actorTypeRaw = message.metadata?.actorType;
		const actorType = typeof actorTypeRaw === "string" ? actorTypeRaw : undefined;
		const allowedBots = runtime.config?.platforms?.nextcloudTalk?.allowedBots;
		const isAllowedBot = actorType === "bots" && !!allowedBots?.includes(message.userId);

		// Check allowlist
		if (!isAllowedBot && !isUserAllowed(platform, message.userId)) {
			logger.info(`[gateway] User ${message.userId} not in allowlist`);
			await discardMediaAttachments(message.attachments);
			if (actorType === "bots") {
				// Fremder Bot: still verwerfen (keine Meldung in den Raum).
				return;
			}
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

		// ── Raum-Klassifikation (einmal pro Nachricht) ─────────────────────
		// Dient zwei Konsumenten: dem zentralen Slash-Command-Gating
		// (docs/slash-commands.md §2/§4) und dem Anti-Bot-Loop-Gruppen-Filter
		// (anti-bot-loop §4/§6, unten). DM/Gruppe/unklar aus classifyChannel;
		// die Verfeinerung groupHuman/groupBot kommt für Talk zusätzlich aus
		// der Konfiguration (platforms.nextcloudTalk.roomTypes, Spec §2:
		// configuration-driven only — keine Auto-Erkennung, da Bots bewusst
		// als normale Accounts angelegt sein können).
		const groupRooms = runtime.config.groupRooms ?? [];
		const channelKind = classifyChannel(platform, message, groupRooms);
		const roomType = resolveRoomType(
			message.channelId,
			channelKind,
			message.platform === "nextcloudTalk"
				? runtime.config.platforms.nextcloudTalk?.roomTypes
				: undefined,
		);

		// ── Channel-Slash-Commands: /stop /new /status /model (Spec §§2–§7) ──
		// Zentrales Parsing VOR der Agent-Übergabe, plattform-agnostisch
		// (docs/slash-commands.md §§3–§5):
		// - not-command → Nachricht fließt unverändert weiter (Spec §5).
		// - forward     → groupBot-Raum: KEINE Command-Verarbeitung, KEINE
		//   Quittung; der Text läuft als normale Nachricht zum Agenten, denn
		//   Output in Bot-Gruppen wäre ein Event für die anderen Bots (Spec §4).
		// - ack         → ablehnen mit Kurz-Quittung, NICHT an den Agenten
		//   (Nicht-Admin, Spec §4 Option A; oder Raum-Gating der Matrix).
		// - execute     → kuratiertes Command sicher ausgeführt.
		const commandDecision = decideChannelCommand({
			content: message.content,
			isAdmin: isAdmin(platform, message.userId),
			roomType,
		});
		if (commandDecision.kind === "ack") {
			await discardMediaAttachments(message.attachments);
			const adapter = runtime.state.adapters.get(message.platform);
			// Bots erhalten keine Command-Quittungen: jeder gesendete Text im
			// Bot-Kontext wäre neuer Loop-Auslösestoff (Anti-Bot-Loop-Lehre;
			// Spec §4 verbietet Output in Bot-Gruppen erst recht).
			if (adapter && actorType !== "bots") {
				await adapter.sendMessage(message.channelId, commandDecision.text);
			}
			logger.info(
				`[gateway] Channel command "${message.content.trim()}" denied for ${message.platform}/${message.userId} (roomType: ${roomType})`,
			);
			return;
		}
		if (commandDecision.kind === "execute") {
			await executeChannelCommand(commandDecision, platform, message, session);
			return;
		}

		// ── Telegram inline-keyboard callback for model switching ──
		// Kein Slash-Command (Tastendruck-Callback des alten /model-Keyboards),
		// daher bewusst NACH dem Command-Dispatch; Logik unverändert übernommen.
		const modelCallback = message.content.match(/^Callback:\s*model:(.+)/i);
		if (modelCallback && isUserAllowed(platform, message.userId)) {
			const adapter = runtime.state.adapters.get(message.platform);
			if (!isAgentRunning()) {
				if (adapter) {
					await adapter.sendMessage(message.channelId, "Agent not running.");
				}
				return;
			}

			const key = modelCallback[1].trim();
			const [callbackProvider, callbackModelId] = key.split("/");
			if (!callbackProvider || !callbackModelId) return;

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
					provider: callbackProvider,
					modelId: callbackModelId,
				})) as {
					success: boolean;
					error?: string;
					data?: { name: string };
				};
				if (result.success) {
					const name = result.data?.name || `${callbackProvider}/${callbackModelId}`;
					if (adapter) {
						await adapter.sendMessage(message.channelId, `✅ Model changed to ${name}`);
					}
					logger.info(
						`[gateway] Admin ${message.userId} switched model to ${callbackProvider}/${callbackModelId}`,
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

		// ── Anti-Bot-Loop (Ansatz B, Leer-Nachrichten-Filter — §5a 2026-09-24) ──
		// Leere Nachrichten (Länge 0 bzw. Länge 1 mit nicht-alphanumerischem
		// Zeichen außer ?/!) sind gültiger Loop-Auslösestoff: sie werden bisher
		// als echte Kommunikation behandelt → Modell-Call → Notiz → Zweitbot
		// löst wieder aus. GLOBAL (alle Absender, alle Plattformen, alle
		// Kanäle) vor dem Modell-Call ignorieren — Ausnahme: `isBotAddressed`
		// (@Igor/@all) überschreibt den Filter (Adressierungs-Regel unverändert,
		// ADR Pkt. 3).
		if (isEmptyMessage(message.content) && !isBotAddressed(message.content)) {
			logger.info(
				`[gateway] Empty message "${message.content}" — ignoring (anti-bot-loop §5a)`,
			);
			await discardMediaAttachments(message.attachments);
			return;
		}

		// ── Anti-Bot-Loop (Ansatz B, context-basiert — 2026-09-24) ─────────
		// Gruppen-/Kanal-Nachricht, die den Bot NICHT explizit adressiert
		// (@Igor/@all): Modell DETERMINISTISCH nicht befragen → stumm, kein
		// gesendeter Text, kein Auslösestoff für Bot-auf-Bot-Ping-Pong (auch
		// die Modell-Stumm-Notiz kann so nie entstehen). DM bleibt intakt —
		// der Filter greift nur, wenn der Kanal positiv als Gruppe erkannt
		// wird (platform-Metadaten `chatType`/`isDM`/`isGroup` oder explizite
		// `groupRooms`-Labels). Konzept §§3/4, ADR bot-allowlist Pkt. 3.
		// `groupRooms`/`channelKind` wurden bereits für das Command-Gating
		// berechnet (siehe „Raum-Klassifikation" oben) — hier nur Konsum.
		if (channelKind === "group" && !isBotAddressed(message.content)) {
			logger.info(
				`[gateway] Group message not addressed to bot (@Igor/@all) in ${platform}/${message.channelId} — staying silent (anti-bot-loop)`,
			);
			await discardMediaAttachments(message.attachments);
			return;
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

			// Track which channel triggered this prompt for UI request routing.
			// Session-per-Room (docs/session-per-room.md §5): with perRoom enabled,
			// routing + session-ensure + prompt run inside the FIFO queue at
			// execution time (routing stays with the ACTIVE room, not the waiting
			// one); without perRoom the same runPrompt is awaited directly —
			// bit-identical ordering to the pre-per-room path.
			const perRoom = runtime.config.sessions.perRoom === true;
			const perRoomLabel = `gateway:${platform}:${message.channelId}`;

			let preText = "";

			const runPrompt = async (): Promise<string> => {
				setActiveChannel({
					platform: message.platform,
					channelId: message.channelId,
				});

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

				// Session-per-Room (docs/session-per-room.md §5,
				// docs/jsonl-session-labeling.md §3): ensure the pi session for this
				// room.
				//   unmapped row OR mapped file gone (deleted/moved) → new_session +
				//   set_session_name — fresh file, fresh timestamp. pi does NOT fail
				//   on a missing switch target: SessionManager.open silently opens an
				//   unlabeled fresh session whose filename inherits the stale path's
				//   timestamp (jsonl-session-labeling.md §1.2.1) — so a missing file
				//   must never reach switch_session.
				//   known room → switch_session + post-switch verification: the
				//   actual sessionFile must match the mapping (re-map if not) and the
				//   label (sessionName) must be present — set_session_name is
				//   idempotent (jsonl-session-labeling.md §3.1/§3.2).
				// The wrapper skip-rule (pi-brain) keeps mapped files out of the archive.
				if (perRoom) {
					const ensurePiSession = async (): Promise<void> => {
						const mapped = session.piSessionFile;
						if (!mapped || !existsSync(mapped)) {
							const state = await newPiSession(perRoomLabel);
							if (state.sessionFile) {
								setPiSessionFile(session.id, state.sessionFile);
								logger.info(
									`[gateway] Per-room session created for ${perRoomLabel}: ${state.sessionFile}`,
								);
							}
							return;
						}
						try {
							await switchPiSession(mapped);
						} catch (err) {
							// Switch itself failed → fresh session instead of failing the message.
							logger.warn(
								`[gateway] switch_session to ${mapped} failed for ${perRoomLabel} — creating a fresh session`,
								err,
							);
							const state = await newPiSession(perRoomLabel);
							if (state.sessionFile) setPiSessionFile(session.id, state.sessionFile);
							return;
						}
						// Post-switch verification (self-healing). A failed verification
						// must not kill the message — the switch itself succeeded.
						try {
							const state = await getPiState();
							if (state.sessionFile && state.sessionFile !== mapped) {
								logger.warn(
									`[gateway] switch_session landed on ${state.sessionFile} (expected ${mapped}) for ${perRoomLabel} — re-mapping`,
								);
								setPiSessionFile(session.id, state.sessionFile);
							}
							if (state.sessionName !== perRoomLabel) {
								await setPiSessionName(perRoomLabel);
								logger.info(
									`[gateway] Session label set for ${perRoomLabel} (was: ${state.sessionName ?? "none"})`,
								);
							}
						} catch (err) {
							logger.warn(
								`[gateway] Post-switch state verification failed for ${perRoomLabel}`,
								err,
							);
						}
					};
					await ensurePiSession();
				}

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

				return sendPromptRpc(
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
			};

			try {
				const responseText = perRoom
					? await enqueuePromptTask(
							perRoomLabel,
							runPrompt,
							runtime.config.promptTimeoutMs ?? 300000,
						)
					: await runPrompt();

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
					// Anti-Bot-Loop (Ansatz B, Hybrid — 2026-09-24): leerer
					// Antwort-Fallback GLOBAL unterbinden. Zuvor wurde fest
					// „I processed your message but had no text response." gesendet
					// — eine real gesendete Notiz genau dieser Art löst beim
					// Zweitbot einen neuen Bot-auf-Bot-Loop aus. Stattdessen: nichts
					// senden; die evtl. vorhandene Platzhalter-Message best-effort
					// entfernen (kein Auslösestoff, keine Notiz im Raum).
					logger.warn(
						"[gateway] Empty response — suppressing fallback text (anti-bot-loop)",
					);
					if (sentId) {
						await adapter.deleteMessage(message.channelId, sentId).catch(() => {});
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

// ── Channel-Slash-Command-Ausführung (docs/slash-commands.md §§3–§7) ───────
// Decision + Parsing liegen in src/core/channel-commands.ts (pure, unit-test-
// bar); hier laufen ausschließlich die Seiteneffekte (RPC, Adapter-Sends).

/** Minimaler Response-Schnitt pi-RPC (Erfolgsflag + optionale Fehlerzeile). */
interface RpcCallResult {
	success: boolean;
	error?: string;
}

/** pi-Model-Objekt-Snapshot aus get_state/set_model (nur Anzeige-Felder). */
interface RpcModelInfo {
	provider?: string;
	id?: string;
	name?: string;
}

/**
 * Führt ein per Permission-Matrix freigegebenes Slash-Command aus
 * (docs/slash-commands.md §3). Vorbedingungen (Admin + Raumtyp-Matrix) sind
 * vom Aufrufer via `decideChannelCommand` geprüft — diese Funktion verlässt
 * sich darauf und ergänzt keine Berechtigungslogik.
 */
async function executeChannelCommand(
	decision: Extract<CommandDecision, { kind: "execute" }>,
	platform: Platform,
	message: PlatformMessage,
	session: { id: string },
): Promise<void> {
	const adapter = runtime.state.adapters.get(message.platform);
	const reply = async (text: string): Promise<void> => {
		if (!adapter) return;
		try {
			await adapter.sendMessage(message.channelId, text);
		} catch (err) {
			logger.error("[gateway] Failed to send command reply:", err);
		}
	};
	// Commands konsumieren keine Anhänge — wie bei allen Verwerfungspfaden
	// best-effort discarden, damit keine Orphan-Dateien im Media-Store bleiben.
	await discardMediaAttachments(message.attachments);

	logger.info(
		`[gateway] Channel command /${decision.command} from ${platform}/${message.userId} in room ${message.channelId} (roomType: ${decision.roomType})`,
	);

	switch (decision.command) {
		case "stop": {
			// §3: aktuelle Generierung für diesen Raum abbrechen, Session bleibt.
			if (!isAgentRunning()) {
				await reply("🛑 Agent not running — nothing to stop.");
				return;
			}
			try {
				// pi-RPC-Doku (rpc-commands.md, abort): abort setzt queued
				// steering/follow-up-Nachrichten fort — für „Esc“-Semantik erst
				// clear_queue, dann abort. clear_queue ist best-effort (fehler
				// darf den abort nicht verhindern).
				await sendRpc("clear_queue").catch(() => undefined);
				const res = (await sendRpc("abort")) as RpcCallResult;
				if (res.success) {
					await reply("⏹ Current generation stopped — session kept.");
				} else {
					await reply(`❌ Stop failed: ${res.error || "unknown"}`);
				}
			} catch (err) {
				logger.error("[gateway] /stop failed:", err);
				await reply("❌ Stop failed.");
			}
			return;
		}

		case "new": {
			// §3: Session für diesen Raum zurücksetzen. deleteSession entfernt
			// den Gateway-Session-Satz inkl. piSessionFile-Mapping — beim
			// nächsten Message legt die Per-Room-Logik eine frische pi-Session
			// an (docs/session-per-room.md). Der RPC-Prozess selbst bleibt.
			try {
				await deleteSession(session.id);
				await reply(
					"🆕 *Neue Session gestartet.*\nDer bisherige Kontext wurde gelöscht.",
				);
			} catch (err) {
				logger.error("[gateway] /new failed:", err);
				await reply("❌ Session reset failed.");
			}
			return;
		}

		case "status": {
			// §6: kompakter Health-Report — Agent, Adapter, Modell, Kontext.
			// Modell + Kontext aus dem pi-RPC; fehlt beides (Agent weg oder
			// RPC liefert nicht), ehrlicher Config-/n/a-Fallback (Spec §6).
			const agentConnected = isAgentRunning();
			const adapters = Array.from(runtime.state.adapters.keys());
			let model: string | null = null;
			let modelSource: "rpc" | "config" | undefined;
			let contextUsage: string | null = null;
			if (agentConnected) {
				try {
					const state = (await sendRpc("get_state")) as RpcCallResult & {
						data?: { model?: RpcModelInfo };
					};
					if (state.success && state.data?.model?.id) {
						model = formatModelId(state.data.model);
						modelSource = "rpc";
					}
				} catch (err) {
					logger.warn("[gateway] /status: get_state failed:", err);
				}
				try {
					const stats = (await sendRpc("get_session_stats")) as RpcCallResult & {
						data?: {
							contextUsage?: {
								tokens?: number | null;
								contextWindow?: number | null;
								percent?: number | null;
							};
						};
					};
					const usage = stats.success ? stats.data?.contextUsage : undefined;
					if (usage?.contextWindow) {
						contextUsage = formatContextUsage({
							tokens: usage.tokens ?? null,
							contextWindow: usage.contextWindow,
							percent: usage.percent ?? null,
						});
					}
				} catch (err) {
					logger.warn("[gateway] /status: get_session_stats failed:", err);
				}
			}
			if (model === null) {
				const configured = runtime.config.rpc?.model?.trim();
				if (configured && configured !== "") {
					model = configured;
					modelSource = "config";
				}
			}
			await reply(
				formatChannelStatus({ agentConnected, adapters, model, modelSource, contextUsage }),
			);
			return;
		}

		case "model": {
			// §7: ohne Argument aktives Modell zeigen, mit Argument switchen
			// (pi-RPC unterstützt Runtime-Switch via set_model — verifiziert
			// gegen rpc-commands.md).
			if (!isAgentRunning()) {
				await reply("Agent not running.");
				return;
			}
			const target = parseModelArg(decision.arg);
			if (!target) {
				// /model ohne Argument → aktueller Modell-Identifier.
				try {
					const state = (await sendRpc("get_state")) as RpcCallResult & {
						data?: { model?: RpcModelInfo };
					};
					if (state.success && state.data?.model?.id) {
						await reply(`🧠 Current model: ${formatModelId(state.data.model)}`);
					} else {
						const configured = runtime.config.rpc?.model?.trim();
						await reply(
							configured
								? `🧠 Current model: ${configured} (from config — RPC did not report a model)`
								: "🧠 Current model: n/a (RPC did not report a model)",
						);
					}
				} catch (err) {
					logger.error("[gateway] /model: get_state failed:", err);
					await reply("Failed to retrieve current model.");
				}
				return;
			}

			// /model list → verfügbare Modelle (Textliste; plattform-agnostisch,
			// Telegram-Keyboards bleiben dem Callback-Pfad oben vorbehalten).
			if (target.provider === null && target.modelId.toLowerCase() === "list") {
				try {
					const result = (await sendRpc("get_available_models")) as RpcCallResult & {
						data?: { models?: Array<{ provider: string; id: string; name: string }> };
					};
					const models = result.success ? (result.data?.models ?? []) : [];
					if (models.length === 0) {
						await reply("Could not retrieve model list.");
						return;
					}
					const list = models
						.map((m) => `• ${m.provider}/${m.id} — ${m.name}`)
						.join("\n");
					await reply(
						`Available models:\n${list}\n\nUse \`/model provider/id\` to switch.`,
					);
				} catch (err) {
					logger.error("[gateway] Failed to list models:", err);
					await reply("Failed to retrieve model list.");
				}
				return;
			}

			// Bare Model-ID ohne Provider: über get_available_models auflösen
			// (eindeutiger Match nötig, sonst ehrliche Fehlermeldung).
			let provider = target.provider;
			let modelId = target.modelId;
			if (provider === null) {
				const matches = await listAvailableModels();
				const found = matches.filter(
					(m) => m.id.toLowerCase() === modelId.toLowerCase(),
				);
				if (found.length !== 1) {
					await reply(
						`❌ Unknown model "${modelId}". Use \`/model provider/modelId\` — \`/model list\` shows available models.`,
					);
					return;
				}
				provider = found[0].provider;
				modelId = found[0].id;
			}

			try {
				const result = (await sendRpc("set_model", { provider, modelId })) as
					RpcCallResult & { data?: { name?: string } };
				if (result.success) {
					const name = result.data?.name || `${provider}/${modelId}`;
					await reply(`✅ Model changed to ${name}`);
					logger.info(
						`[gateway] Admin ${message.userId} switched model to ${provider}/${modelId}`,
					);
				} else {
					await reply(`❌ Failed: ${result.error || "unknown"}`);
				}
			} catch (err) {
				logger.error("[gateway] Failed to change model:", err);
				await reply("Failed to change model.");
			}
			return;
		}
	}
}

/** Modelle aus dem pi-RPC (leeres Array bei Fehler — Aufrufer meldet ehrlich). */
async function listAvailableModels(): Promise<Array<{ provider: string; id: string; name: string }>> {
	try {
		const result = (await sendRpc("get_available_models")) as RpcCallResult & {
			data?: { models?: Array<{ provider: string; id: string; name: string }> };
		};
		return result.success ? (result.data?.models ?? []) : [];
	} catch (err) {
		logger.warn("[gateway] get_available_models failed:", err);
		return [];
	}
}
