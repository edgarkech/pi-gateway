/**
 * Phase 4 (S7) — E2E-Tests: Nextcloud Talk Adapter gegen die REALE Instanz.
 *
 * Source: `docs/phase4-e2e.md`. Abdeckung der ROADMAP-Invariante S7:
 * **Empfangen → Antworten → Media → Loop-Freiheit → Restart**.
 *
 * Setup (isoliertes Gateway, keine Berührung von `~/.pi/gateway/config.json`):
 * - Eigene `NextcloudTalkAdapter`-Instanz(en) mit Config aus
 *   `docs/nextcloud-test.env` (via `e2e-harness.ts`; Credentials nie im Code).
 * - **Agent-Call gemockt:** `AgentCallTracker` spyt auf `onMessage` — den
 *   Punkt, an dem das Gateway den pi-Agenten rufen würde. Deterministisch,
 *   kein echter Agent.
 * - **Isolierte State-Daten:** pro Szenario eigenes `GATEWAY_TALK_STATE_DIR`
 *   (tmp-Dir) für den talk_state-Wasserstand; MediaManager mit eigener
 *   tmp-`rootDir`.
 * - Reale Long-Poll-Schleife (30s-Timeout); Inbound wird durch echtes
 *   `messages:send` in den Room getriggert. Netzwerk-Latenz wird über
 *   `waitFor`-Polling abgefangen (flaky-tolerant, aber ohne Fake-OCS).
 *
 * Ein-Konto-Besonderheit (nur der Bot-Account ist credentialisiert):
 * - S1–S3: synthetische Selbstfilter-Identität → bot-user-Nachrichten laufen als
 *   externer User-Input durch die echte Pipeline (siehe e2e-harness.ts).
 * - S4–S5: echte Identität (`userId = bot-user`) → Anti-Loop-Filter wie im Betrieb.
 *
 * Skip-Verhalten: Ohne `docs/nextcloud-test.env` (oder leere Felder) wird die
 * komplette Suite gescippt — die 393 Unit-/Integrationstests bleiben grün,
 * unabhängig davon, ob jemand Credentials hat.
 */

import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { NextcloudTalkAdapter } from "../../../src/adapters/nextcloud-talk.js";
import type { TalkChatMessage } from "../../../src/adapters/nextcloud/talk-types.js";
import {
	getLastKnownMessageId,
	setLastKnownMessageId,
} from "../../../src/adapters/nextcloud/store.js";
import { initMediaManager, resetMediaManager } from "../../../src/media/manager.js";

import {
	AgentCallTracker,
	E2EOcsClient,
	SYNTHETIC_SELF_FILTER_USER,
	TINY_PNG,
	baselineWatermark,
	buildConfig,
	davDelete,
	davMkcol,
	davPut,
	deleteSharesByPath,
	listMessagesSince,
	loadE2eEnv,
	makeTmpDir,
	shareFileToRoom,
	waitFor,
} from "./e2e-harness.js";

const creds = loadE2eEnv();

/** Eindeutiger Run-Marker — alle Test-Nachrichten/Dateien tragen ihn, damit
 *  Läufen gegen denselben Room nie kollidieren und Cleanup exakt greift. */
const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** Generöse Timeouts: reale Instanz = echte Latenz (Long-Poll ~30s). */
const T = { hook: 90_000, test: 180_000, wait: 60_000, mediaWait: 90_000 } as const;

describe.runIf(creds !== null)("S7 E2E: Nextcloud Talk Adapter gegen reale Instanz", () => {
	// Lint-Note: `creds` ist hier nicht null (runIf), TypeScript sieht das nicht.
	const c = creds!;

	let tmpBase = "";
	let ocs: E2EOcsClient;

	// Geteilter Lauf-State (Tests laufen serial in einer Datei).
	let adapterA: NextcloudTalkAdapter | null = null;
	let trackerA: AgentCallTracker;
	let s1SentId = 0;

	// Remote-Cleanup-Tracking (Best-Effort in afterAll).
	const sentMessageIds: number[] = [];
	const davPaths: string[] = []; // zu löschende DAV-Pfade (Datei + Verzeichnis)

	beforeAll(async () => {
		tmpBase = makeTmpDir("nc-talk-e2e-");

		// Isoliertes MediaManager (eigene tmp-rootDir, kein TTL-Timer).
		initMediaManager({ rootDir: join(tmpBase, "media"), sweepIntervalMinutes: 0 });

		// Echter OCS-Client (mit NC 33 listRooms-Kompatibilität) + Auth-Präflight.
		ocs = new E2EOcsClient(c);
		const rooms = await ocs.listRooms();
		expect(
			rooms.some((r) => r.token === c.room),
			`Room ${c.room} nicht in der Room-Liste der Instanz — Credentials/Room prüfen`,
		).toBe(true);
	}, T.hook);

	afterAll(async () => {
		// ── Remote-Cleanup (Best-Effort: Cleanup-Fehler dürfen den Run nicht roden) ──
		try {
			for (const id of sentMessageIds) {
				await ocs.deleteChatMessage(c.room, id).catch(() => undefined);
			}
			for (const path of davPaths) {
				await deleteSharesByPath(c, `/${path.replace(/^\/+/, "")}`).catch(() => undefined);
				await davDelete(c, path).catch(() => undefined);
			}
		} catch {
			/* Best-Effort */
		}

		// ── Lokale Cleanup ──
		resetMediaManager();
		if (tmpBase) rmSync(tmpBase, { recursive: true, force: true });
	}, T.hook);

	/** Adapter-Start-Helfer: State-Dir setzen, (optional) Baseline, starten. */
	async function startAdapter(
		selfFilterUserId: string,
		stateSubDir: string,
		tracker: AgentCallTracker,
		withBaseline: boolean,
	): Promise<NextcloudTalkAdapter> {
		process.env.GATEWAY_TALK_STATE_DIR = join(tmpBase, stateSubDir);
		if (withBaseline) {
			await baselineWatermark(ocs, c.room, setLastKnownMessageId);
		}
		const adapter = new NextcloudTalkAdapter(buildConfig(c, selfFilterUserId), { ocs });
		await adapter.initialize();
		await adapter.start(tracker);
		return adapter;
	}

	/** Chat-Nachricht posten (echtes `messages:send`) + für Cleanup tracken. */
	async function postMessage(text: string): Promise<number> {
		const sent = await ocs.sendChatMessage(c.room, text);
		sentMessageIds.push(sent.id);
		return sent.id;
	}

	// ── S1: Empfangen ─────────────────────────────────────────────────────────

	it(
		"S1 Empfangen: getriggerte Nachricht wird per Long-Poll abgeholt und löst genau einen Agent-Call mit korrekter Session-Zuordnung aus",
		async () => {
			trackerA = new AgentCallTracker();
			adapterA = await startAdapter(SYNTHETIC_SELF_FILTER_USER, "state-s1", trackerA, true);

			const text = `E2E-${RUN_ID} S1 trigger`;
			s1SentId = await postMessage(text);

			const call = await trackerA.waitForCall(
				(m) => m.content === text,
				`Agent-Call für S1-Trigger ("${text}")`,
				T.wait,
			);

			// Session-Zuordnung: Channel = Room-Token, User = echter Sender (bot-user),
			// Plattform + Talk-Message-ID im Metadata.
			expect(call.platform).toBe("nextcloudTalk");
			expect(call.channelId).toBe(c.room);
			expect(call.userId).toBe(c.userId);
			expect(call.metadata?.talkMessageId).toBe(s1SentId);
			expect(call.attachments).toBeUndefined();

			// Invariante: 1 Agent-Call pro User-Nachricht (kein Duplikat).
			await waitFor(
				() => trackerA.calls.filter((m) => m.content === text).length === 1,
				"exakt ein Agent-Call für S1-Trigger",
				5_000,
			);
		},
		T.test,
	);

	// ── S2: Antworten ─────────────────────────────────────────────────────────

	it(
		"S2 Antworten: Mock-Antwort wird via messages:send gesendet und ist im Room vorhanden",
		async () => {
			expect(adapterA, "S1 muss den Adapter gestartet haben").not.toBeNull();

			const replyText = `E2E-${RUN_ID} S2 reply`;
			const messageId = await adapterA!.sendMessage(c.room, replyText);
			expect(Number(messageId)).toBeGreaterThan(0);
			sentMessageIds.push(Number(messageId));

			// Verifikation über die ECHTE Instanz (Chat-Poll seit S1-Message):
			const found = await waitForFoundMessage(replyText, s1SentId);
			expect(found.actorId).toBe(c.userId);
			expect(Number(messageId)).toBe(found.id);
		},
		T.test,
	);

	/** Wartet, bis eine Nachricht mit exaktem Text im Room sichtbar ist. */
	async function waitForFoundMessage(text: string, sinceId: number): Promise<TalkChatMessage> {
		let found: TalkChatMessage | undefined;
		await waitFor(
			async () => {
				const msgs = await listMessagesSince(ocs, c.room, sinceId);
				found = msgs.find((m) => m.message === text);
				return found !== undefined;
			},
			`Nachricht "${text}" im Room sichtbar`,
			T.wait,
		);
		return found!;
	}

	// ── S3: Media inbound ─────────────────────────────────────────────────────

	it(
		"S3 Media inbound: via WebDAV abgelegte Datei wird geteilt, vom Poller erkannt und vom MediaManager materialisiert (Agent-Call mit Pfad)",
		async () => {
			const dir = "e2e-media-test";
			const fileName = `e2e-${RUN_ID}.png`;
			const relPath = `${dir}/${fileName}`;

			// Datei per WebDAV in den Bot-User-Space legen (Parent erst anlegen).
			await davMkcol(c, dir);
			await davPut(c, relPath, TINY_PNG, "image/png");
			davPaths.push(relPath, `${dir}/`);

			// Datei in den Room teilen → erzeugt echte File-Share-Chat-Nachricht.
			const caption = `E2E-${RUN_ID} S3 caption`;
			await shareFileToRoom(c, c.room, `/${relPath}`, caption);

			const call = await trackerA!.waitForCall(
				(m) => (m.attachments?.length ?? 0) > 0,
				"Agent-Call mit Media-Anhang",
				T.mediaWait,
			);

			// Caption als Text + Anhang im selben Call.
			expect(call.content).toContain(caption);
			const att = call.attachments![0];
			expect(att.kind).toBe("image");
			expect(att.mimeType).toBe("image/png"); // Magic-Byte-Sniffing (nicht deklariert)
			expect(att.sizeBytes).toBe(TINY_PNG.length);
			expect(att.fileName).toBe(fileName);
			expect(att.source.platform).toBe("nextcloudTalk");

			// Materialisiert: lokale Datei existiert und ist byte-identisch.
			expect(existsSync(att.localPath), `Media-Datei fehlt: ${att.localPath}`).toBe(true);
			expect(readFileSync(att.localPath)).toEqual(TINY_PNG);
		},
		T.test,
	);

	// ── S4: Loop-Freiheit ─────────────────────────────────────────────────────

	it(
		"S4 Loop-Freiheit: eigene (Bot-)Nachrichten triggern KEINEN Agent-Call — der Wasserstand wird trotzdem fortgeschrieben (kein Re-Delivery)",
		async () => {
			// S1–S3-Adapter stoppen (schließt auch dessen State-DB).
			await adapterA!.stop();
			adapterA = null;

			// Echte Identität: Selbstfilter wie im Betrieb (userId = bot-user).
			const trackerB = new AgentCallTracker();
			const adapterB = await startAdapter(c.userId, "state-s4", trackerB, true);

			// "Bot-Antwort-Sturm": zwei eigene Nachrichten in den Room.
			const own1 = `E2E-${RUN_ID} S4 own-1`;
			const own2 = `E2E-${RUN_ID} S4 own-2`;
			const id1 = await postMessage(own1);
			const id2 = await postMessage(own2);

			// Wasserstand läuft über beide eigenen Nachrichten hinaus …
			await waitFor(
				() => getLastKnownMessageId(c.room) >= id2,
				`Wasserstand ≥ ${id2} (eigene Nachrichten konsumiert)`,
				T.wait,
			);

			// … aber es gibt KEINEN Agent-Call für sie (Anti-Loop, D4).
			const ownCalls = trackerB.calls.filter((m) => m.userId === c.userId);
			expect(ownCalls, `Eigene Nachrichten triggerten Agent-Calls: ${JSON.stringify(ownCalls.map((m) => m.content))}`).toHaveLength(0);

			await adapterB.stop();
		},
		T.test,
	);

	// ── S5: Restart ───────────────────────────────────────────────────────────

	it(
		"S5 Restart: Wasserstand überlebt Stop+Start — kein Re-Processing, kein Double-Send, Adapter bleibt danach funktionsfähig",
		async () => {
			const trackerC = new AgentCallTracker();
			const adapterC = await startAdapter(SYNTHETIC_SELF_FILTER_USER, "state-s5", trackerC, true);

			// Phase 1: Trigger + Antwort verarbeiten lassen.
			const t1 = `E2E-${RUN_ID} S5 t1`;
			const t1Id = await postMessage(t1);
			await trackerC.waitForCall((m) => m.content === t1, "S5 t1 Agent-Call", T.wait);

			const r1 = `E2E-${RUN_ID} S5 r1`;
			const r1MsgId = Number(await adapterC.sendMessage(c.room, r1));
			expect(r1MsgId).toBeGreaterThan(0);
			sentMessageIds.push(r1MsgId);
			// (Filter-off-Modus: die eigene Antwort kommt deterministisch auch
			// inbound zurück — darauf warten, damit der Wasserstand sie enthält.)
			await trackerC.waitForCall((m) => m.content === r1, "S5 r1 Inbound", T.wait);
			await waitFor(
				() => getLastKnownMessageId(c.room) >= r1MsgId,
				`Wasserstand ≥ ${r1MsgId} vor Restart`,
				T.wait,
			);

			// Phase 2: Restart (gleiche State-Dir → SQLite-Wasserstand persistiert).
			await adapterC.stop(); // schließt die talk_state-DB
			const trackerD = new AgentCallTracker();
			const adapterD = await startAdapter(SYNTHETIC_SELF_FILTER_USER, "state-s5", trackerD, false);

			// Kein Re-Processing: nach einem Poll-Zyklus keine Calls für t1/r1.
			await new Promise((r) => setTimeout(r, 4_000));
			expect(trackerD.countCallsWithMarker(`E2E-${RUN_ID} S5`), "Re-Processing nach Restart").toBe(0);

			// Adapter bleibt funktionsfähig: neue Nachricht → genau ein Call.
			const t2 = `E2E-${RUN_ID} S5 t2`;
			const t2Id = await postMessage(t2);
			const call2 = await trackerD.waitForCall(
				(m) => m.content === t2,
				"S5 t2 Agent-Call nach Restart",
				T.wait,
			);
			expect(call2.metadata?.talkMessageId).toBe(t2Id);

			// Kein Double-Send: die Antwort r1 existiert im Room exakt einmal.
			const msgs = await listMessagesSince(ocs, c.room, t1Id - 1);
			const r1Count = msgs.filter((m) => m.message === r1).length;
			expect(r1Count, `r1 wurde ${r1Count}× gesendet (erwartet 1)`).toBe(1);

			await adapterD.stop();
		},
		T.test,
	);
});
