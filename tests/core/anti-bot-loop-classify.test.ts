/**
 * Unit-Tests — Anti-Bot-Loop (Ansatz B, concept-anti-bot-loop-filter §4/§6):
 *
 * - `isBotAddressed` (tool-policy.ts, Einzel-Quelle der @-Adressierung — ADR
 *   bot-allowlist Pkt. 3): nur @Igor/@all adressiert, Klartext-Nennungen nicht.
 * - `classifyChannel` (message-pipeline.ts): Gruppe vs. DM über
 *   platform-Metadaten (`chatType`/`isDM`/`isGroup`) + explizite groupRooms-
 *   Labels; `unknown` wertet der Filter als NICHT-Gruppe (DM intakt).
 */

import { describe, expect, it } from "vitest";
import { isBotAddressed } from "../../src/security/tool-policy.js";
import { classifyChannel, isEmptyMessage } from "../../src/core/message-pipeline.js";

describe("isEmptyMessage — Leer-Nachrichten-Filter (concept §5a)", () => {
	it("Länge 0 → leer", () => {
		expect(isEmptyMessage("")).toBe(true);
	});

	it("Länge 1 mit nicht-alphanumerischem Zeichen → leer (außer ?/!)", () => {
		expect(isEmptyMessage(".")).toBe(true);
		expect(isEmptyMessage(",")).toBe(true);
		expect(isEmptyMessage(";")).toBe(true);
		expect(isEmptyMessage(":")).toBe(true);
		expect(isEmptyMessage(" ")).toBe(true);
		expect(isEmptyMessage("-")).toBe(true);
	});

	it("? und ! sind echte Kommunikation → NICHT leer", () => {
		expect(isEmptyMessage("?")).toBe(false);
		expect(isEmptyMessage("!")).toBe(false);
	});

	it("Länge 1 mit alphanumerischem Zeichen → NICHT leer", () => {
		expect(isEmptyMessage("a")).toBe(false);
		expect(isEmptyMessage("1")).toBe(false);
		expect(isEmptyMessage("Æ")).toBe(false);
	});

	it("mehrzeilige Nachrichten (Länge >= 2) → NICHT leer", () => {
		expect(isEmptyMessage("..")).toBe(false);
		expect(isEmptyMessage("Hallo")).toBe(false);
		expect(isEmptyMessage(". ")).toBe(false);
	});
});

describe("isBotAddressed — strikte @-Adressierung (ADR Pkt. 3)", () => {
	it("adressiert via @Igor (case-insensitive)", () => {
		expect(isBotAddressed("@Igor was ist das?")).toBe(true);
		expect(isBotAddressed("@igor hallo")).toBe(true);
	});

	it("adressiert via @all", () => {
		expect(isBotAddressed("@all Achtung")).toBe(true);
		expect(isBotAddressed("Hallo @ALL")).toBe(true);
	});

	it("NICHT adressiert bei Klartext-Nennungen (Igor ohne @)", () => {
		expect(isBotAddressed("Hey, kannst Du Igor's Notizen lesen?")).toBe(false);
		expect(isBotAddressed("Hallo Pepe, grüße Igor von mir")).toBe(false);
	});

	it("NICHT adressiert bei leeren/übrigen Texten", () => {
		expect(isBotAddressed("Hallo Bots")).toBe(false);
		expect(isBotAddressed("")).toBe(false);
		expect(isBotAddressed("  ")).toBe(false);
	});

	it("kein Fehl-Match bei Teilworten (@igorx, @alliance)", () => {
		expect(isBotAddressed("@igorx hat gefragt")).toBe(false);
		expect(isBotAddressed("@alliance steht fest")).toBe(false);
	});
});

describe("classifyChannel — Gruppe vs. DM", () => {
	it("groupRooms-Label gewinnt deterministisch (z. B. NC-Talk-Raum)", () => {
		expect(
			classifyChannel("nextcloudTalk", { channelId: "room-1", metadata: {} }, [
				"gateway:nextcloudTalk:room-1",
			]),
		).toBe("group");
	});

	it("Telegram: private → dm, group/supergroup/channel → group", () => {
		expect(
			classifyChannel("telegram", { channelId: "1", metadata: { chatType: "private" } }),
		).toBe("dm");
		expect(
			classifyChannel("telegram", { channelId: "2", metadata: { chatType: "group" } }),
		).toBe("group");
		expect(
			classifyChannel("telegram", { channelId: "3", metadata: { chatType: "supergroup" } }),
		).toBe("group");
		expect(
			classifyChannel("telegram", { channelId: "4", metadata: { chatType: "channel" } }),
		).toBe("group");
	});

	it("Discord: isDM=false → group, isDM=true → dm", () => {
		expect(classifyChannel("discord", { channelId: "a", metadata: { isDM: false } })).toBe(
			"group",
		);
		expect(classifyChannel("discord", { channelId: "b", metadata: { isDM: true } })).toBe("dm");
	});

	it("WhatsApp: isGroup=true → group, isGroup=false → dm", () => {
		expect(classifyChannel("whatsapp", { channelId: "jid", metadata: { isGroup: true } })).toBe(
			"group",
		);
		expect(
			classifyChannel("whatsapp", { channelId: "jid", metadata: { isGroup: false } }),
		).toBe("dm");
	});

	it("unbekannte Plattform/Metadaten → unknown (Filter greift nicht, DM intakt)", () => {
		expect(classifyChannel("nextcloudTalk", { channelId: "r", metadata: {} })).toBe("unknown");
		expect(classifyChannel("slack", { channelId: "c", metadata: {} })).toBe("unknown");
		expect(classifyChannel("telegram", { channelId: "x", metadata: {} })).toBe("unknown");
	});
});
