/**
 * WhatsApp Adapter - Hermes-style WhatsApp platform adapter
 *
 * Features:
 * - WhatsApp Web protocol via Baileys
 * - QR code authentication
 * - Contact and group management
 * - Media messaging
 */

import {
	BaseAdapter,
	type PlatformMessage,
	type PlatformConfig,
	type AdapterCallbacks,
} from "./base.js";
import { logger } from "../logger.js";

export interface WhatsAppConfig extends PlatformConfig {
	platform: "whatsapp";
	sessionPath?: string;
	printQr?: boolean; // Print QR to console
	maxMessageLength?: number;
}

interface WhatsAppContact {
	id: string;
	name?: string;
	isGroup: boolean;
}

/** Minimal structural view of a Baileys message event payload. */
interface WhatsAppMessage {
	key: { remoteJid: string; fromMe?: boolean; participant?: string; id?: string };
	message?: {
		conversation?: string;
		extendedTextMessage?: { text?: string };
		imageMessage?: { caption?: string };
	};
	messageTimestamp?: number | { low?: number; high?: number };
	pushName?: string;
}

/** Minimal structural type for the dynamically-imported Baileys library. */
interface BaileysModule {
	useMultiFileAuthState: (path: string) => Promise<{
		state: unknown;
		saveCreds: (update: unknown) => void;
	}>;
	makeWASocket: (opts: Record<string, unknown>) => BaileysSocket;
}

/** Minimal structural type for the Baileys WASocket instance we use. */
interface BaileysSocket {
	ev: {
		on: (event: string, ...args: unknown[]) => void;
	};
	logout: () => Promise<unknown>;
	sendMessage: (jid: string, content: unknown) => Promise<{ key?: { id?: string } }>;
	sendPresenceUpdate: (action: string, jid: string) => Promise<unknown>;
	relayMessage: (
		jid: string,
		content: Record<string, unknown>,
		options: Record<string, unknown>,
	) => Promise<unknown>;
	store?: { contacts: Record<string, unknown> };
}

export class WhatsAppAdapter extends BaseAdapter {
	readonly platform = "whatsapp" as const;
	config: WhatsAppConfig;

	private sock: BaileysSocket | null = null;
	private connected = false;
	private qrCode: string | null = null;
	/** Baileys module reference (avoids re-importing). Null if unavailable. */
	private baileys: BaileysModule | null = null;
	/** True when the dynamic import of Baileys failed — adapter fails gracefully. */
	private baileysUnavailable = false;

	constructor(config: WhatsAppConfig) {
		super();
		// `enabled`/`platform` are required by WhatsAppConfig (inherited from
		// PlatformConfig), so they come from config — we only apply defaults for
		// the optional behaviour knobs that callers may omit.
		this.config = {
			...config,
			sessionPath: config.sessionPath ?? "./whatsapp-session",
			printQr: config.printQr ?? true,
			maxMessageLength: config.maxMessageLength ?? 4096,
		};
	}

	async initialize(): Promise<void> {
		// Dynamic import of Baileys — fail gracefully if the library is missing.
		// A hard throw here would take down the entire gateway, so instead we log
		// a clear error and disable just the WhatsApp adapter.
		try {
			// Cast via `unknown`: the structural BaileysModule type above captures only
			// the subset of the Baileys public API we use, while the real module exposes
			// many more members — so a direct `as` cast would be rejected by TS. This is
			// a single documented boundary at the dynamic import.
			this.baileys = (await import("@whiskeysockets/baileys")) as unknown as BaileysModule;
			this.baileysUnavailable = false;
		} catch (err) {
			this.baileysUnavailable = true;
			logger.error(
				"[WhatsApp] Baileys library unavailable (@whiskeysockets/baileys import failed) — WhatsApp adapter disabled:",
				err,
			);
			return;
		}

		try {
			const { state, saveCreds } = await this.baileys.useMultiFileAuthState(
				this.config.sessionPath || "./whatsapp-session",
			);

			this.sock = this.baileys.makeWASocket({
				auth: state,
				printQRInTerminal: this.config.printQr,
				defaultQueryTimeoutMs: 60 * 1000,
			});

			// Handle QR code
			this.sock.ev.on("qr", (qr: string) => {
				this.qrCode = qr;
				logger.info("[WhatsApp] QR Code received - scan with WhatsApp app");
				logger.info(qr);
			});

			// Handle connection update
			this.sock.ev.on("connection.update", (raw: unknown) => {
				const update = raw as { qr?: string; connection?: string };
				const { qr, connection } = update;
				if (qr) {
					this.qrCode = qr;
				}
				if (connection === "open") {
					this.connected = true;
					this.qrCode = null;
					logger.info("[WhatsApp] Connected!");
				}
				if (connection === "close") {
					this.connected = false;
					logger.info("[WhatsApp] Disconnected");
				}
			});

			// Handle credentials update
			this.sock.ev.on("creds.update", saveCreds);

			// Handle messages
			this.sock.ev.on("messages.upsert", (raw: unknown) => {
				const { messages } = raw as { messages: WhatsAppMessage[] };
				this.handleMessages(messages);
			});

			logger.info("[WhatsApp] Initializing...");
		} catch (err) {
			this.baileysUnavailable = true;
			logger.error("[WhatsApp] Failed to initialize adapter:", err);
		}
	}

	private handleMessages(messages: WhatsAppMessage[]): void {
		for (const msg of messages) {
			// Skip messages sent by us
			if (msg.key.fromMe) continue;

			const jid = msg.key.remoteJid;
			const isGroup = jid?.endsWith("@g.us");

			// Get message content
			const content =
				msg.message?.conversation ||
				msg.message?.extendedTextMessage?.text ||
				msg.message?.imageMessage?.caption ||
				"";

			if (!content) continue;

			const ts =
				typeof msg.messageTimestamp === "number"
					? msg.messageTimestamp * 1000
					: (msg.messageTimestamp?.low ?? 0) * 1000 || Date.now();

			const message: PlatformMessage = {
				id: msg.key.id || this.generateMessageId(),
				platform: "whatsapp",
				channelId: jid,
				userId: msg.key.participant || jid,
				content,
				timestamp: ts,
				metadata: {
					isGroup,
					messageType: msg.message ? Object.keys(msg.message)[0] : "unknown",
					pushName: msg.pushName,
				},
			};

			this.emitMessage(message);
		}
	}

	async start(callbacks: AdapterCallbacks): Promise<void> {
		await super.start(callbacks);

		// If Baileys was unavailable during initialize(), fail gracefully instead
		// of blocking the gateway with a connection wait loop.
		if (this.baileysUnavailable) {
			logger.warn(
				"[WhatsApp] Adapter disabled — Baileys unavailable, skipping connection wait",
			);
			return;
		}

		// Wait for connection
		let attempts = 0;
		while (!this.connected && attempts < 30) {
			await this.sleep(1000);
			attempts++;
		}

		if (!this.connected) {
			logger.warn("[WhatsApp] Not yet connected - waiting for QR scan");
		}
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	async stop(): Promise<void> {
		if (this.sock) {
			await this.sock.logout();
			this.sock = null;
		}
		this.connected = false;
		await super.stop();
	}

	async sendMessage(channelId: string, content: string): Promise<string> {
		if (!this.sock || !this.connected) {
			throw new Error("WhatsApp not connected");
		}

		// Truncate if too long
		const maxLength = this.config.maxMessageLength ?? 4096;
		const text = content.length > maxLength ? content.slice(0, maxLength - 3) + "..." : content;

		try {
			const result = await this.sock.sendMessage(channelId, { text });
			return result?.key?.id || this.generateMessageId();
		} catch (err) {
			logger.error("[WhatsApp] Send error:", err);
			throw err;
		}
	}

	async sendImage(channelId: string, imageUrl: string, caption?: string): Promise<string> {
		if (!this.sock || !this.connected) {
			throw new Error("WhatsApp not connected");
		}

		try {
			const result = await this.sock.sendMessage(channelId, {
				image: { url: imageUrl },
				caption,
			});
			return result?.key?.id || this.generateMessageId();
		} catch (err) {
			logger.error("[WhatsApp] Send image error:", err);
			throw err;
		}
	}

	async sendReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
		if (!this.sock || !this.connected) {
			throw new Error("WhatsApp not connected");
		}

		try {
			await this.sock.sendMessage(channelId, {
				react: { text: emoji, key: { remoteJid: channelId, id: messageId } },
			});
		} catch (err) {
			logger.error("[WhatsApp] Reaction error:", err);
		}
	}

	async reply(channelId: string, content: string, messageId: string): Promise<string> {
		if (!this.sock || !this.connected) {
			throw new Error("WhatsApp not connected");
		}

		try {
			const result = await this.sock.sendMessage(channelId, {
				text: content,
				contextInfo: {
					stanzaId: messageId,
					remoteJid: channelId,
				},
			});
			return result?.key?.id || this.generateMessageId();
		} catch (err) {
			logger.error("[WhatsApp] Reply error:", err);
			throw err;
		}
	}

	async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
		if (!this.sock || !this.connected) {
			throw new Error("WhatsApp not connected");
		}

		try {
			await this.sock.relayMessage(
				channelId,
				{
					protocolMessage: {
						type: 6, // MESSAGE_EDIT
						key: { remoteJid: channelId, id: messageId },
						editedMessage: { conversation: [{ text: content }] },
					},
				},
				{},
			);
		} catch (err) {
			logger.error("[WhatsApp] Edit error:", err);
		}
	}

	async deleteMessage(channelId: string, messageId: string): Promise<void> {
		if (!this.sock || !this.connected) {
			throw new Error("WhatsApp not connected");
		}

		try {
			await this.sock.sendMessage(channelId, {
				delete: { remoteJid: channelId, id: messageId },
			});
		} catch (err) {
			logger.error("[WhatsApp] Delete error:", err);
		}
	}

	async setTyping(channelId: string, isTyping: boolean): Promise<void> {
		if (!this.sock || !this.connected) return;

		try {
			await this.sock.sendPresenceUpdate(isTyping ? "composing" : "available", channelId);
		} catch (_err) {
			// Ignore presence errors
		}
	}

	async getStatus(): Promise<{ connected: boolean; latency?: number }> {
		return { connected: this.connected };
	}

	async getContacts(): Promise<WhatsAppContact[]> {
		if (!this.sock?.store?.contacts) {
			return [];
		}

		return Object.entries(this.sock.store.contacts).map(([id, contact]) => {
			const c = contact as { name?: string; notify?: string };
			return {
				id,
				name: c.name || c.notify || id.split("@")[0],
				isGroup: id.endsWith("@g.us"),
			};
		});
	}

	async getContact(jid: string): Promise<WhatsAppContact | null> {
		const contacts = await this.getContacts();
		return contacts.find((c) => c.id === jid) || null;
	}

	getQrCode(): string | null {
		return this.qrCode;
	}
}
