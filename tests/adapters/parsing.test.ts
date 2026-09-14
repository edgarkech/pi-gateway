/**
 * Unit tests for adapter payload parsing — verifies that raw incoming messages
 * from each platform are correctly normalized into `PlatformMessage` objects.
 *
 * These tests exercise the real parsing code paths without any network I/O:
 * the adapters' message handlers are invoked directly with realistic payloads,
 * and a mock `onMessage` callback captures the resulting `PlatformMessage`.
 */

import { afterAll, describe, expect, it, vi } from "vitest";
import { DiscordAdapter } from "../../src/adapters/discord.js";
import { TelegramAdapter } from "../../src/adapters/telegram.js";
import { SlackAdapter } from "../../src/adapters/slack.js";
import { WhatsAppAdapter } from "../../src/adapters/whatsapp.js";
import { WebSocketAdapter } from "../../src/adapters/websocket.js";
import type { PlatformMessage } from "../../src/adapters/base.js";

/** Attach an onMessage spy to an adapter without starting network loops. */
function withSpy(adapter: { callbacks: unknown }): (message: PlatformMessage) => Promise<void> {
	const onMessage = vi.fn(async () => {});
	(adapter as { callbacks: unknown }).callbacks = { onMessage };
	return onMessage;
}

describe("Discord message parsing", () => {
	it("parses a direct-message payload into a PlatformMessage", async () => {
		const adapter = new DiscordAdapter({
			enabled: true,
			platform: "discord",
			botToken: "12345.abc.def",
		});
		const onMessage = withSpy(adapter);

		// Cast to invoke the private handleMessage() parsing path.
		await (
			adapter as unknown as {
				handleMessage: (d: unknown) => Promise<void>;
			}
		).handleMessage({
			id: "6000001",
			channel_id: "889900",
			author: { id: "u456", username: "alice" },
			content: "hello gateway",
			timestamp: "2026-01-01T10:00:00.000Z",
			guild_id: null,
		});

		expect(onMessage).toHaveBeenCalledTimes(1);
		const msg = onMessage.mock.calls[0][0] as PlatformMessage;
		expect(msg.platform).toBe("discord");
		expect(msg.channelId).toBe("889900");
		expect(msg.userId).toBe("u456");
		expect(msg.content).toBe("hello gateway");
		expect(msg.timestamp).toBe(new Date("2026-01-01T10:00:00.000Z").getTime());
		expect(msg.metadata).toMatchObject({ isDM: true });
	});

	it("ignores bot messages that are not our own", async () => {
		const adapter = new DiscordAdapter({
			enabled: true,
			platform: "discord",
			botToken: "99999.xyz",
		});
		const onMessage = withSpy(adapter);

		await (
			adapter as unknown as {
				handleMessage: (d: unknown) => Promise<void>;
			}
		).handleMessage({
			id: "1",
			channel_id: "c",
			author: { id: "other-bot", bot: true, username: "other" },
			content: "hi",
			guild_id: "g",
		});

		expect(onMessage).not.toHaveBeenCalled();
	});

	it("parses guild messages and records guild metadata", async () => {
		const adapter = new DiscordAdapter({
			enabled: true,
			platform: "discord",
			botToken: "12345.abc.def",
		});
		const onMessage = withSpy(adapter);

		await (
			adapter as unknown as {
				handleMessage: (d: unknown) => Promise<void>;
			}
		).handleMessage({
			id: "2",
			channel_id: "channel-1",
			guild_id: "guild-9",
			author: { id: "u9", username: "carol" },
			content: "from a server",
			timestamp: "2026-02-02T00:00:00.000Z",
		});

		const msg = onMessage.mock.calls[0][0] as PlatformMessage;
		expect(msg.metadata).toMatchObject({ guildId: "guild-9", isDM: false });
	});
});

describe("Telegram message parsing", () => {
	it("parses a DM update into a PlatformMessage via handleWebhookUpdate", async () => {
		const adapter = new TelegramAdapter({
			enabled: true,
			platform: "telegram",
			token: "bot:token",
		});
		const onMessage = withSpy(adapter);

		await adapter.handleWebhookUpdate({
			update_id: 1,
			message: {
				message_id: 501,
				from: { id: 300, username: "bob" },
				chat: { id: 300, type: "private" },
				text: "hi bot",
				date: 1700000000,
			},
		});

		expect(onMessage).toHaveBeenCalledTimes(1);
		const msg = onMessage.mock.calls[0][0] as PlatformMessage;
		expect(msg.platform).toBe("telegram");
		expect(msg.channelId).toBe("300");
		expect(msg.userId).toBe("300");
		expect(msg.content).toBe("hi bot");
		expect(msg.timestamp).toBe(1700000000 * 1000);
		expect(msg.metadata).toMatchObject({ chatType: "private" });
	});

	it("parses a group message with caption and edited flag", async () => {
		const adapter = new TelegramAdapter({
			enabled: true,
			platform: "telegram",
			token: "t",
		});
		const onMessage = withSpy(adapter);

		await adapter.handleWebhookUpdate({
			update_id: 2,
			edited_message: {
				message_id: 602,
				from: { id: 7, username: "carol" },
				chat: { id: -100, type: "group", title: "Pi Fan Club" },
				caption: "updated caption",
				date: 1700000100,
			},
		});

		const msg = onMessage.mock.calls[0][0] as PlatformMessage;
		expect(msg.content).toBe("updated caption");
		expect(msg.metadata).toMatchObject({ chatType: "group", isEdited: true });
	});

	it("skips empty / command-less messages with no text", async () => {
		const adapter = new TelegramAdapter({
			enabled: true,
			platform: "telegram",
			token: "t",
		});
		const onMessage = withSpy(adapter);

		await adapter.handleWebhookUpdate({
			update_id: 3,
			message: {
				message_id: 1,
				from: { id: 1 },
				chat: { id: 1, type: "private" },
				date: 1000000000,
			},
		});

		expect(onMessage).not.toHaveBeenCalled();
	});
});

describe("Slack message parsing", () => {
	it("parses an incoming event into a PlatformMessage", async () => {
		const adapter = new SlackAdapter({
			enabled: true,
			platform: "slack",
		});
		const onMessage = withSpy(adapter);

		await adapter.handleIncomingEvent({
			type: "message",
			channel: "C123",
			user: "U456",
			text: "hello from slack",
			ts: "1700000000.123",
			team: "T1",
			username: "alice",
		});

		expect(onMessage).toHaveBeenCalledTimes(1);
		const msg = onMessage.mock.calls[0][0] as PlatformMessage;
		expect(msg.platform).toBe("slack");
		expect(msg.channelId).toBe("C123");
		expect(msg.userId).toBe("U456");
		expect(msg.content).toBe("hello from slack");
		expect(msg.timestamp).toBe(1700000000.123 * 1000);
		expect(msg.metadata).toMatchObject({ team: "T1" });
	});

	it("ignores events without required fields (e.g. subtype edits)", async () => {
		const adapter = new SlackAdapter({ enabled: true, platform: "slack" });
		const onMessage = withSpy(adapter);

		await adapter.handleIncomingEvent({
			type: "message",
			subtype: "message_changed",
			channel: "C1",
			user: "U1",
			text: "changed",
			ts: "1",
		});
		expect(onMessage).not.toHaveBeenCalled();
	});
});

describe("WhatsApp message parsing", () => {
	it("parses a conversation message", async () => {
		const adapter = new WhatsAppAdapter({
			enabled: true,
			platform: "whatsapp",
		});
		const onMessage = withSpy(adapter);

		await (
			adapter as unknown as {
				handleMessages: (m: unknown[]) => Promise<void>;
			}
		).handleMessages([
			{
				key: { remoteJid: "551199988@c.us", fromMe: false, id: "wmsg1" },
				message: { conversation: "ci oral" },
				messageTimestamp: 1700000300,
				pushName: "dave",
			},
		]);

		expect(onMessage).toHaveBeenCalledTimes(1);
		const msg = onMessage.mock.calls[0][0] as PlatformMessage;
		expect(msg.platform).toBe("whatsapp");
		expect(msg.channelId).toBe("551199988@c.us");
		expect(msg.userId).toBe("551199988@c.us");
		expect(msg.content).toBe("ci oral");
		expect(msg.metadata).toMatchObject({ isGroup: false, messageType: "conversation" });
	});

	it("parses a group extended-text message", async () => {
		const adapter = new WhatsAppAdapter({ enabled: true, platform: "whatsapp" });
		const onMessage = withSpy(adapter);

		await (
			adapter as unknown as {
				handleMessages: (m: unknown[]) => Promise<void>;
			}
		).handleMessages([
			{
				key: {
					remoteJid: "120200000@g.us",
					participant: "5511888@c.us",
					fromMe: false,
				},
				message: { extendedTextMessage: { text: "group hi" } },
				messageTimestamp: 1700000400,
			},
		]);

		const msg = onMessage.mock.calls[0][0] as PlatformMessage;
		expect(msg.content).toBe("group hi");
		expect(msg.userId).toBe("5511888@c.us");
		expect(msg.metadata).toMatchObject({ isGroup: true, messageType: "extendedTextMessage" });
	});

	it("skips our own outgoing messages", async () => {
		const adapter = new WhatsAppAdapter({ enabled: true, platform: "whatsapp" });
		const onMessage = withSpy(adapter);

		await (
			adapter as unknown as {
				handleMessages: (m: unknown[]) => Promise<void>;
			}
		).handleMessages([
			{
				key: { remoteJid: "55@c.us", fromMe: true },
				message: { conversation: "sent by us" },
				messageTimestamp: 1700000500,
			},
		]);
		expect(onMessage).not.toHaveBeenCalled();
	});
});

describe("WebSocket message parsing", () => {
	// A minimal fake WebSocket so connect() can run without real network I/O.
	class FakeWebSocket {
		readyState = 1; // WebSocket.OPEN
		onopen: (() => void) | null = null;
		onmessage: ((event: { data: string }) => void) | null = null;
		onclose: (() => void) | null = null;
		onerror: ((err: unknown) => void) | null = null;
		close() {}
		send() {}
	}

	afterAll(() => {
		vi.unstubAllGlobals();
	});

	it("parses an inbound JSON frame into a PlatformMessage", async () => {
		const fake = new FakeWebSocket();
		// Regular function (not arrow) so it can be used with `new WebSocket(...)`.
		const webSocketCtor = vi.fn(function (this: unknown) {
			return fake;
		});
		vi.stubGlobal("WebSocket", webSocketCtor);

		const adapter = new WebSocketAdapter({
			enabled: true,
			platform: "websocket",
			clientId: "web-client-1",
		});
		const onMessage = withSpy(adapter);

		// Start (but don't await) connect; the mock's onopen resolves it.
		const connectPromise = adapter.connect("ws://localhost:9999");
		fake.onopen?.(); // simulate the connection opening → resolve connect()
		await connectPromise;

		// Trigger the real onmessage handler with a realistic frame.
		fake.onmessage?.({
			data: JSON.stringify({
				type: "message",
				content: "ping from web",
				metadata: { foo: 1 },
			}),
		});

		expect(onMessage).toHaveBeenCalledTimes(1);
		const msg = onMessage.mock.calls[0][0] as PlatformMessage;
		expect(msg.platform).toBe("websocket");
		expect(msg.channelId).toBe("web-client-1");
		expect(msg.userId).toBe("web-client-1");
		expect(msg.content).toBe("ping from web");
		expect(msg.metadata).toMatchObject({ foo: 1 });
	});

	it("ignores frames that are not of type message", async () => {
		const fake = new FakeWebSocket();
		vi.stubGlobal(
			"WebSocket",
			vi.fn(function (this: unknown) {
				return fake;
			}),
		);

		const adapter = new WebSocketAdapter({
			enabled: true,
			platform: "websocket",
			clientId: "c2",
		});
		const onMessage = withSpy(adapter);

		const connectPromise = adapter.connect("ws://localhost:9998");
		fake.onopen?.();
		await connectPromise;
		fake.onmessage?.({
			data: JSON.stringify({ type: "typing", channelId: "x", isTyping: true }),
		});

		expect(onMessage).not.toHaveBeenCalled();
	});
});
