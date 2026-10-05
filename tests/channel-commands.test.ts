/**
 * Slash Commands over Channels — Unit-Tests (docs/slash-commands.md §9.1).
 *
 * Abdeckung gemäß Acceptance Criteria:
 * 1. Command-Parsing (`parseChannelCommand`, Spec §5): exakter Erst-Token-
 *    Match, case-insensitive, Argument-Extraktion, Non-Match → Durchreichen.
 * 2. Permission-Matrix admin × Raumtyp (Spec §4): alle 4 Commands × 3 Raum-
 *    typen × {admin, Nicht-Admin}; groupBot → `forward` (keine Verarbeitung,
 *    keine Quittung); Nicht-Admin → Kurz-Quittung `ack` (Option A);
 *    Admin + Matrix-Nein → Raum-Gating-`ack`.
 * 3. Talk-Filter-Öffnung + Anti-Loop-Invariante (Spec §5): `isPublishable`
 *    lässt `messageType === "command"` NUR für das bekannte Slash-Command-Set
 *    durch; unbekannte Commands, eigene Echos, System-Events und Bots
 *    bleiben verworfen.
 * 4. Raumtyp-Auflösung (Spec §2): Config schlägt Implizit; DM implizit;
 *    unklassifizierte Gruppen konservativ `groupHuman`.
 * 5. Config-`roomTypes` (AC3): Default `{}`, Deep-Merge (Reload-Pfad:
 *    `loadConfig` → `mergeGatewayConfig` bei jeder Load, daher genügt das
 *    Re-Merge gegen geänderte Eingabe), Validierungsfehler.
 * 6. Report-Helfer: `formatChannelStatus` (§6 inkl. n/a-Fallbacks),
 *    `formatContextUsage`, `formatModelId`, `parseModelArg` (§7).
 *
 * Methodik: reine Funktionstests (channel-commands.ts ist bewusst
 * sideeffektfrei); der Talk-Filter wird gegen das echte `isPublishable`
 * aus dem Adapter mit lokalem Message-Builder getestet (kein Netzwerk).
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
	ADMIN_REQUIRED_ACK,
	CHANNEL_COMMAND_NAMES,
	COMMAND_ROOM_MATRIX,
	decideChannelCommand,
	formatChannelStatus,
	formatContextUsage,
	formatModelId,
	isKnownChannelCommandText,
	parseChannelCommand,
	parseModelArg,
	resolveRoomType,
	roomGateAck,
	type CommandDecision,
	type RoomType,
} from "../src/core/channel-commands.js";
import { isPublishable } from "../src/adapters/nextcloud-talk.js";
import type { NextcloudTalkConfig } from "../src/adapters/nextcloud-talk.js";
import type { TalkChatMessage } from "../src/adapters/nextcloud/talk-types.js";
import { mergeGatewayConfig } from "../src/config.js";
import type { GatewayConfig } from "../src/types.js";

// ── Test-Helfer ───────────────────────────────────────────────────────────────

/** minimale, gültige Talk-Adapter-Config (Anti-Loop-Selbstfilter: userId). */
function talkConfig(overrides: Partial<NextcloudTalkConfig> = {}): NextcloudTalkConfig {
	return {
		enabled: true,
		platform: "nextcloudTalk",
		baseUrl: "https://nc.local",
		userId: "bot-gw",
		appToken: "app-token-123",
		rooms: ["room-a"],
		...overrides,
	};
}

/** Talk-Chat-Nachricht (Shape wie im Poller; Defaults = normale User-Nachricht). */
function talkMessage(overrides: Partial<TalkChatMessage> = {}): TalkChatMessage {
	return {
		id: 700,
		token: "room-a",
		actorType: "users",
		actorId: "alice",
		actorDisplayName: "Alice",
		timestamp: 1_700_000_000,
		systemMessage: "",
		messageType: "comment",
		message: "hello",
		messageParameters: {},
		...overrides,
	} as TalkChatMessage;
}

/** Basis-Config für mergeGatewayConfig (health-Pflichtfelder). */
const base: Record<string, unknown> = { host: "localhost", port: 3847, tokens: [] };

/** Talk-Block einer gemergten Config holen (Typ-Dance einmal zentral). */
function talkOf(merged: GatewayConfig): Record<string, unknown> {
	return merged.platforms.nextcloudTalk as unknown as Record<string, unknown>;
}

// ── 1. Parsing (Spec §5) ──────────────────────────────────────────────────────

describe("parseChannelCommand — zentrales Parsing vor Agent-Übergabe (Spec §5)", () => {
	it("erkennt alle vier Commands als kuriertes Set", () => {
		assert.deepEqual([...CHANNEL_COMMAND_NAMES], ["stop", "new", "status", "model"]);
	});

	it("matcht jeden bekannten Command ohne Argument", () => {
		for (const name of CHANNEL_COMMAND_NAMES) {
			assert.deepEqual(parseChannelCommand(`/${name}`), { name, arg: "" });
		}
	});

	it("ist case-insensitive", () => {
		assert.deepEqual(parseChannelCommand("/STOP"), { name: "stop", arg: "" });
		assert.deepEqual(parseChannelCommand("/New"), { name: "new", arg: "" });
		assert.deepEqual(parseChannelCommand("/MoDeL prOv/Model"), {
			name: "model",
			arg: "prOv/Model", // Argument-Inhalt bleibt erhalten (nur trimmen)
		});
	});

	it("extrahiert den Argument-Text nach dem ersten Token", () => {
		assert.deepEqual(parseChannelCommand("/model z-ai/glm-5.3-flash"), {
			name: "model",
			arg: "z-ai/glm-5.3-flash",
		});
		assert.deepEqual(parseChannelCommand("  /status   "), { name: "status", arg: "" });
		assert.deepEqual(parseChannelCommand("/model   deepseek/deepseek-v4-flash-0731  "), {
			name: "model",
			arg: "deepseek/deepseek-v4-flash-0731",
		});
	});

	it("akzeptiert Mehrzeiligkeit: Argument = Rest inkl. Folgezeilen (getrimmt)", () => {
		assert.deepEqual(parseChannelCommand("/model prov/id\n"), {
			name: "model",
			arg: "prov/id",
		});
	});

	it("leitet Nicht-Commands unverändert durch (null)", () => {
		assert.equal(parseChannelCommand(""), null);
		assert.equal(parseChannelCommand("hallo /stop"), null); // nicht Erster Token
		assert.equal(parseChannelCommand("siehe /stop bitte"), null);
		assert.equal(parseChannelCommand("/"), null);
	});

	it("matcht NICHT bei Präfix-Täuschern (Token muss exakt stimmen)", () => {
		assert.equal(parseChannelCommand("/stopx"), null);
		assert.equal(parseChannelCommand("/stop-now"), null);
		assert.equal(parseChannelCommand("/statusbericht"), null);
		assert.equal(parseChannelCommand("/modeling tipps"), null);
	});

	it("ignoriert nicht-Command-Nachrichten, auch mit Slash im Text", () => {
		assert.equal(parseChannelCommand("http://example.com/stop"), null);
	});

	it("ist mit /restart kompatibel: /restart bleibt fuori Scope (nicht im Set)", () => {
		// Der Admin-Neustart-Command bleibt separat (bestehendes Verhalten);
		// das kuratierte Set darf ihn nicht schlucken.
		assert.equal(parseChannelCommand("/restart"), null);
	});
});

describe("isKnownChannelCommandText — Selektor für den Talk-Filter (Spec §5)", () => {
	it("bejaht das bekannte Set (case-insensitive, mit Argument)", () => {
		assert.equal(isKnownChannelCommandText("/stop"), true);
		assert.equal(isKnownChannelCommandText("/STATUS"), true);
		assert.equal(isKnownChannelCommandText("/model AGENT/qwen38-27b"), true);
	});

	it("verneint Unbekanntes (Anti-Loop-Invariante des Filters)", () => {
		assert.equal(isKnownChannelCommandText("/restart"), false);
		assert.equal(isKnownChannelCommandText("/poll"), false);
		assert.equal(isKnownChannelCommandText("/stopx"), false);
		assert.equal(isKnownChannelCommandText("normale nachricht"), false);
	});
});

// ── 2. Raumtyp-Auflösung (Spec §2) ───────────────────────────────────────────

describe("resolveRoomType — Konfiguration schlägt Implizit (Spec §2)", () => {
	it("übernimmt die explizite Konfiguration für beide Klassen", () => {
		assert.equal(resolveRoomType("r1", "group", { r1: "groupHuman" }), "groupHuman");
		assert.equal(resolveRoomType("r1", "group", { r1: "groupBot" }), "groupBot");
	});

	it("Config-Eintrag schlägt sogar die DM-Erkennung (configuration-driven)", () => {
		// Spec §2: configuration-driven only — ein explizit als groupBot
		// konfigurierter Raum bleibt groupBot, unabhängig von classifyChannel.
		assert.equal(resolveRoomType("r1", "dm", { r1: "groupBot" }), "groupBot");
	});

	it("DM bleibt implizit dm, wenn kein Config-Eintrag existiert", () => {
		assert.equal(resolveRoomType("r9", "dm", {}), "dm");
		assert.equal(resolveRoomType("r9", "dm", { r1: "groupBot" }), "dm");
		assert.equal(resolveRoomType("r9", "dm", undefined), "dm");
	});

	it("unklassifizierte Gruppen und `unknown` → konservativ groupHuman (AC3)", () => {
		assert.equal(resolveRoomType("r5", "group", {}), "groupHuman");
		assert.equal(resolveRoomType("r5", "group", undefined), "groupHuman");
		assert.equal(resolveRoomType("r5", "unknown", {}), "groupHuman");
		assert.equal(resolveRoomType("r5", "unknown", { r1: "groupBot" }), "groupHuman");
	});

	it("ignoriert Config-Werte mit ungültigem Inhalt (Defensive, Config validiert vor)", () => {
		assert.equal(resolveRoomType("r1", "group", { r1: "botNichtKonfiguriert" }), "groupHuman");
	});
});

// ── 3. Permission-Matrix (Spec §4) ───────────────────────────────────────────

describe("COMMAND_ROOM_MATRIX — exakte Spec-§4-Matrix", () => {
	it("stop: dm ✅ groupHuman ✅ groupBot ❌", () => {
		assert.deepEqual(COMMAND_ROOM_MATRIX.stop, {
			dm: true,
			groupHuman: true,
			groupBot: false,
		});
	});

	it("new: nur dm ✅", () => {
		assert.deepEqual(COMMAND_ROOM_MATRIX.new, {
			dm: true,
			groupHuman: false,
			groupBot: false,
		});
	});

	it("status: dm ✅ groupHuman ✅ groupBot ❌", () => {
		assert.deepEqual(COMMAND_ROOM_MATRIX.status, {
			dm: true,
			groupHuman: true,
			groupBot: false,
		});
	});

	it("model: nur dm ✅", () => {
		assert.deepEqual(COMMAND_ROOM_MATRIX.model, {
			dm: true,
			groupHuman: false,
			groupBot: false,
		});
	});
});

describe("decideChannelCommand — Entscheidungsbaum (Spec §4)", () => {
	const ROOM_TYPES: readonly RoomType[] = ["dm", "groupHuman", "groupBot"];
	const COMMANDS = ["stop", "new", "status", "model"] as const;

	it("not-command: Nicht-Command-Text fließt unverändert (alle Raumtypen)", () => {
		for (const roomType of ROOM_TYPES) {
			for (const isAdmin of [true, false]) {
				assert.deepEqual(
					decideChannelCommand({ content: "ganz normale frage", isAdmin, roomType }),
					{ kind: "not-command" },
				);
			}
		}
	});

	it("groupBot: JEDES bekannte Command → forward (keine Verarbeitung, keine Quittung)", () => {
		for (const cmd of COMMANDS) {
			for (const isAdmin of [true, false]) {
				assert.deepEqual(
					decideChannelCommand({ content: `/${cmd}`, isAdmin, roomType: "groupBot" }),
					{ kind: "forward" },
				);
			}
		}
	});

	it("Nicht-Admin in dm/groupHuman: Kurz-Quittung, NICHT an Agent (Option A)", () => {
		for (const cmd of COMMANDS) {
			for (const roomType of ["dm", "groupHuman"] as const) {
				const d = decideChannelCommand({
					content: `/${cmd}`,
					isAdmin: false,
					roomType,
				});
				assert.equal(d.kind, "ack");
				assert.equal((d as Extract<CommandDecision, { kind: "ack" }>).text, ADMIN_REQUIRED_ACK);
			}
		}
	});

	it("Admin + Matrix-Ja → execute (mit Kommando + Argument + Raumtyp)", () => {
		// dm: alle vier Commands erlaubt
		for (const cmd of COMMANDS) {
			const d = decideChannelCommand({ content: `/${cmd}`, isAdmin: true, roomType: "dm" });
			assert.deepEqual(d, { kind: "execute", command: cmd, arg: "", roomType: "dm" });
		}
		// groupHuman: nur /stop und /status
		for (const cmd of ["stop", "status"] as const) {
			assert.equal(
				decideChannelCommand({ content: `/${cmd}`, isAdmin: true, roomType: "groupHuman" })
					.kind,
				"execute",
			);
		}
	});

	it("Admin + Matrix-Nein → Raum-Gating-Quittung (nicht Admin-Quittung)", () => {
		for (const cmd of ["new", "model"] as const) {
			const d = decideChannelCommand({
				content: `/${cmd}`,
				isAdmin: true,
				roomType: "groupHuman",
			});
			assert.equal(d.kind, "ack");
			assert.equal((d as Extract<CommandDecision, { kind: "ack" }>).text, roomGateAck(cmd));
		}
	});

	it("execute trägt das geparste Argument weiter (/model provider/id)", () => {
		const d = decideChannelCommand({
			content: "/model z-ai/glm-5.3-flash",
			isAdmin: true,
			roomType: "dm",
		});
		assert.deepEqual(d, {
			kind: "execute",
			command: "model",
			arg: "z-ai/glm-5.3-flash",
			roomType: "dm",
		});
	});

	it("Gruppenreihenfolge: groupBot-Forward greift VOR dem Admin-Check", () => {
		// Nicht-Admin im groupBot-Raum bekommt KEINE Admin-Quittung — Output
		// in Bot-Gruppen ist ein Event für die anderen Bots (Spec §4).
		const d = decideChannelCommand({
			content: "/stop",
			isAdmin: false,
			roomType: "groupBot",
		});
		assert.deepEqual(d, { kind: "forward" });
	});

	it("Quittungs-Texte sind kurz und eindeutig", () => {
		assert.equal(ADMIN_REQUIRED_ACK, "⚠️ This command requires admin privileges.");
		assert.equal(roomGateAck("new"), "⚠️ /new is not available in this room type.");
	});
});

// ── 4. Talk-Adapter-Filter: selektiv geöffnet, Anti-Loop bleibt (Spec §5) ────

describe("isPublishable — Talk-Filter für messageType=command (Spec §5)", () => {
	const config = talkConfig(); // userId "bot-gw" → Selbstfilter

	it("lässt bekannte Slash-Commands als messageType=command durch", () => {
		for (const cmd of ["/stop", "/new", "/status", "/model"]) {
			assert.equal(
				isPublishable(config, talkMessage({ messageType: "command", message: cmd })),
				true,
				`bekanntes Command ${cmd} muss publishable sein`,
			);
		}
		assert.equal(
			isPublishable(
				config,
				talkMessage({ messageType: "command", message: "/model AGENT/qwen38-27b" }),
			),
			true,
		);
	});

	it("verwirft UNBEKANNTE messageType=command-Texte (Anti-Loop-Invariante)", () => {
		for (const msg of ["/poll", "/gateway pair", "/stopx", "/clear", "lösche alles"]) {
			assert.equal(
				isPublishable(config, talkMessage({ messageType: "command", message: msg })),
				false,
				`unbekannter command-Typ "${msg}" muss verworfen werden`,
			);
		}
	});

	it("Selbstfilter bleibt auch bei bekannten Commands aktiv (Echo-Invariante)", () => {
		assert.equal(
			isPublishable(
				config,
				talkMessage({ messageType: "command", message: "/status", actorId: "bot-gw" }),
			),
			false,
		);
	});

	it("Bot-Actors bleiben verworfen, auch mit bekanntem Command", () => {
		assert.equal(
			isPublishable(
				config,
				talkMessage({
					messageType: "command",
					message: "/status",
					actorType: "bots",
					actorId: "other-bot",
				}),
			),
			false,
		);
	});

	it("System-Nachrichten bleiben verworfen (unabhängig vom Command-Text)", () => {
		assert.equal(
			isPublishable(
				config,
				talkMessage({
					systemMessage: "call_started",
					messageType: "command",
					message: "/stop",
				}),
			),
			false,
		);
	});

	it("comment_deleted bleibt verworfen", () => {
		assert.equal(
			isPublishable(config, talkMessage({ messageType: "comment_deleted", message: "/stop" })),
			false,
		);
	});

	it("normale comment-Nachrichten sind unverändert betroffen (nur command-Zweig)", () => {
		// Ein bekannter Command-Text als normale comment-Nachricht bleibt
		// publishable (Parsing/Gating passiert zentral in der Pipeline).
		assert.equal(
			isPublishable(config, talkMessage({ messageType: "comment", message: "/stop" })),
			true,
		);
	});
});

// ── 5. Config: roomTypes-Block (Spec §2, AC3) ────────────────────────────────

describe("mergeGatewayConfig — platforms.nextcloudTalk.roomTypes (Spec §2, AC3)", () => {
	it("defaultet roomTypes auf {} (alle Gruppen konservativ groupHuman)", () => {
		const merged = mergeGatewayConfig({ ...base } as GatewayConfig);
		assert.deepEqual(talkOf(merged).roomTypes, {});
	});

	it("übernimmt eine gültige Raum-Klassifikation", () => {
		const merged = mergeGatewayConfig({
			...base,
			platforms: {
				nextcloudTalk: {
					roomTypes: { "room-a": "groupBot", "room-b": "groupHuman" },
				},
			},
		} as unknown as GatewayConfig);
		assert.deepEqual(talkOf(merged).roomTypes, {
			"room-a": "groupBot",
			"room-b": "groupHuman",
		});
	});

	it("Reload-Pfad: erneutes Mergen mit geändertem Block spiegelt die Änderung (AC3)", () => {
		// loadConfig() ruft mergeGatewayConfig bei jedem (Re)Load auf — eine
		// geänderte Config-Datei wird 1:1 über den Merge wirksam. Hier ohne
		// Dateisystem: zweiter Merge mit geänderter Eingabe.
		const first = mergeGatewayConfig({
			...base,
			platforms: { nextcloudTalk: { roomTypes: { r1: "groupHuman" } } },
		} as unknown as GatewayConfig);
		assert.deepEqual(talkOf(first).roomTypes, { r1: "groupHuman" });

		const second = mergeGatewayConfig({
			...base,
			platforms: {
				nextcloudTalk: { roomTypes: { r1: "groupBot", r2: "groupHuman" } },
			},
		} as unknown as GatewayConfig);
		assert.deepEqual(talkOf(second).roomTypes, { r1: "groupBot", r2: "groupHuman" });
	});

	it("Deep-Merge: Teilblock verliert die Poll-Defaults nicht", () => {
		const merged = mergeGatewayConfig({
			...base,
			platforms: { nextcloudTalk: { roomTypes: { r1: "groupBot" } } },
		} as unknown as GatewayConfig);
		const talk = talkOf(merged);
		assert.deepEqual(talk.roomTypes, { r1: "groupBot" });
		assert.equal(talk.pollMode, "long-poll");
		assert.equal(talk.intervalMs, 5000);
	});

	it("lehnt Nicht-Objekte als roomTypes ab", () => {
		assert.throws(
			() =>
				mergeGatewayConfig({
					...base,
					platforms: { nextcloudTalk: { roomTypes: "groupBot" } },
				} as unknown as GatewayConfig),
			/roomTypes must be an object/,
		);
		assert.throws(
			() =>
				mergeGatewayConfig({
					...base,
					platforms: { nextcloudTalk: { roomTypes: ["r1"] } },
				} as unknown as GatewayConfig),
			/roomTypes must be an object/,
		);
	});

	it("lehnt ungültige Raumtyp-Werte ab (nur groupHuman | groupBot)", () => {
		assert.throws(
			() =>
				mergeGatewayConfig({
					...base,
					platforms: { nextcloudTalk: { roomTypes: { r1: "groupbot" } } },
				} as unknown as GatewayConfig),
			/must be "groupHuman" or "groupBot"/,
		);
		assert.throws(
			() =>
				mergeGatewayConfig({
					...base,
					platforms: { nextcloudTalk: { roomTypes: { r1: "dm" } } },
				} as unknown as GatewayConfig),
			/must be "groupHuman" or "groupBot"/,
		);
	});

	it("lehnt leere Raum-Token als Schlüssel ab", () => {
		assert.throws(
			() =>
				mergeGatewayConfig({
					...base,
					platforms: { nextcloudTalk: { roomTypes: { "": "groupBot" } } },
				} as unknown as GatewayConfig),
			/empty room token key/,
		);
	});
});

// ── 6. Report-/Argument-Helfer (Spec §§6–§7) ─────────────────────────────────

describe("formatChannelStatus — kompakter Health-Report (Spec §6)", () => {
	it("zeigt Agent, Adapter, Modell (RPC) und Kontext", () => {
		const out = formatChannelStatus({
			agentConnected: true,
			adapters: ["nextcloudTalk", "telegram"],
			model: "AGENT/qwen38-27b",
			modelSource: "rpc",
			contextUsage: "60000 / 200000 tokens (30%)",
		});
		assert.match(out, /Agent: ✅ connected/);
		assert.match(out, /Adapters: nextcloudTalk, telegram/);
		assert.match(out, /Model: AGENT\/qwen38-27b/);
		assert.match(out, /Context: 60000 \/ 200000 tokens \(30%\)/);
		// RPC-Quelle bekommt keinen Fallback-Zusatz
		assert.doesNotMatch(out, /from config/);
	});

	it("weist fehlende Werte ehrlich als n/a aus (RPC-Limitation sichtbar)", () => {
		const out = formatChannelStatus({
			agentConnected: false,
			adapters: [],
			model: null,
			contextUsage: null,
		});
		assert.match(out, /Agent: ❌ not connected/);
		assert.match(out, /Adapters: none/);
		assert.match(out, /Model: n\/a/);
		assert.match(out, /Context: n\/a/);
	});

	it(" kennzeichnet den Config-Fallback beim Modell (Spec §6 Doku-Pflicht)", () => {
		const out = formatChannelStatus({
			agentConnected: false,
			adapters: ["nextcloudTalk"],
			model: "z-ai/glm-5.3-flash",
			modelSource: "config",
			contextUsage: null,
		});
		assert.match(out, /Model: z-ai\/glm-5\.3-flash \(from config — RPC did not report a model\)/);
	});
});

describe("formatContextUsage — Kontext-Anzeige (Spec §6)", () => {
	it("formatiert Tokens und Prozent gerundet", () => {
		assert.equal(
			formatContextUsage({ tokens: 60_000, contextWindow: 200_000, percent: 30.4 }),
			"60000 / 200000 tokens (30%)",
		);
	});

	it("null-Tokens/-Prozent → ehrliche Platzhalter", () => {
		assert.equal(
			formatContextUsage({ tokens: null, contextWindow: 200_000, percent: null }),
			"? / 200000 tokens (?)",
		);
	});

	it("ohne contextWindow (null/0) → null (Aufrufer zeigt n/a)", () => {
		assert.equal(formatContextUsage({ tokens: 10, contextWindow: null, percent: 0 }), null);
		assert.equal(formatContextUsage({ tokens: 10, contextWindow: 0, percent: 5 }), null);
	});
});

describe("formatModelId / parseModelArg — /model-Handling (Spec §7)", () => {
	it("formatiert provider/id und auch ohne Provider", () => {
		assert.equal(formatModelId({ provider: "AGENT", id: "qwen38-27b" }), "AGENT/qwen38-27b");
		assert.equal(formatModelId({ id: "nackt" }), "nackt");
		assert.equal(formatModelId({}), "unknown");
	});

	it("parseModelArg: provider/id wird gesplittet", () => {
		assert.deepEqual(parseModelArg("z-ai/glm-5.3-flash"), {
			provider: "z-ai",
			modelId: "glm-5.3-flash",
		});
	});

	it("parseModelArg: bare Model-ID → provider null (Aufrufer löst auf)", () => {
		assert.deepEqual(parseModelArg("deepseek-v4-flash-0731"), {
			provider: null,
			modelId: "deepseek-v4-flash-0731",
		});
	});

	it("parseModelArg: leer/whitespace → null (kein Argument)", () => {
		assert.equal(parseModelArg(""), null);
		assert.equal(parseModelArg("   "), null);
	});

	it("parseModelArg: kaputte Slash-Formen bleiben bare IDs", () => {
		assert.deepEqual(parseModelArg("/id"), { provider: null, modelId: "/id" });
		assert.deepEqual(parseModelArg("prov/"), { provider: null, modelId: "prov/" });
	});
});
