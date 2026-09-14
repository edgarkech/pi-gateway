/**
 * Config-Reload-Test: Nextcloud-Talk-Poller-Restart (Bugfix-Regression).
 *
 * BUG (vor Fix): `reloadDaemonConfig()` in `src/core/daemon.ts` tauschte bei
 * einer Konfig-Änderung ohne Listener-Wechsel lediglich `runtime.config` aus.
 * Der laufende NextcloudTalkPoller hält seine Config jedoch aus der
 * Konstruktion im Speicher — er lief mit den ALTEN Werten weiter.
 *
 * FIX (abgedeckt hier): Bei einer Änderung des konsumierten
 * `platforms.nextcloudTalk`-Blocks wird der Adapter (inkl. Poller) gestoppt
 * und mit der neuen Config neu gestartet — ohne kompletten Server-Restart.
 *
 * Methodik:
 * - ECHT: `reloadDaemonConfig()` / `restartNextcloudTalkAdapter()` /
 *   `nextcloudTalkConfigChanged()` aus daemon.ts, `mergeGatewayConfig()`,
 *   der Config-File-Leseweg (GATEWAY_CONFIG_FILE, via tests/setup.ts in ein
 *   Scratch-HOME umgeleitet) und der `runtime`-State.
 * - MOCKED: `NextcloudTalkAdapter` (kein echtes OCS-Auth-Probing/HTTP, keine
 *   echte Poller-Instanz) und `core/server.js` (kein echter HTTP-Server auf
 *   dem Listener-Change-Pfad).
 *
 * Abgedeckte Fälle:
 * 1. Nextcloud-Änderung bei laufendem Daemon → alter Adapter gestoppt, neuer
 *    Adapter mit den NEUEN Werten gestartet und registriert.
 * 2. Nur nicht-Nextcloud-Feld geändert → kein Restart (kein Stop, kein Start).
 * 3. `enabled: false` → Adapter gestoppt und entfernt, kein Neustart.
 * 4. Aktivierung ohne vorherigen Adapter → Adapter wird gestartet.
 * 5. Initialize-Fehler beim Restart → isoliert (N1): Reload wirft nicht,
 *    Config ist trotzdem angewendet, Kanal bleibt down.
 * 6. Daemon nicht running → kein Restart-Versuch, nur Config-Tausch.
 * 7. Listener-Change-Pfad unverändert: stopGatewayServer + startGatewayServer
 *    werden aufgerufen (vollständiger Server-Restart).
 */

import { writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mergeGatewayConfig } from "../../src/config.js";
import { GATEWAY_CONFIG_FILE } from "../../src/paths.js";
import { runtime } from "../../src/state.js";
import type { GatewayConfig } from "../../src/types.js";
import {
	reloadDaemonConfig,
	restartNextcloudTalkAdapter,
	nextcloudTalkConfigChanged,
} from "../../src/core/daemon.js";
import { startGatewayServer, stopGatewayServer } from "../../src/core/server.js";

// ── Mocks (hoisted: vi.mock-Factories dürfen keine Imports referenzieren) ──

interface FakeAdapter {
	config: Record<string, unknown>;
	started: boolean;
	stopped: boolean;
	startCallbacks: unknown;
}

const talkMock = vi.hoisted(() => ({
	instances: [] as FakeAdapter[],
	nextInitializeError: null as Error | null,
	nextStartError: null as Error | null,
	nextStopError: null as Error | null,
}));

vi.mock("../../src/adapters/nextcloud-talk.js", () => {
	class FakeNextcloudTalkAdapter implements Partial<FakeAdapter> {
		readonly platform = "nextcloudTalk";
		config: Record<string, unknown>;
		started = false;
		stopped = false;
		startCallbacks: unknown = null;

		constructor(config: Record<string, unknown>) {
			this.config = config;
			talkMock.instances.push(this as unknown as FakeAdapter);
		}

		async initialize(): Promise<void> {
			if (talkMock.nextInitializeError) throw talkMock.nextInitializeError;
		}

		async start(callbacks: unknown): Promise<void> {
			if (talkMock.nextStartError) throw talkMock.nextStartError;
			this.startCallbacks = callbacks;
			this.started = true;
		}

		async stop(): Promise<void> {
			if (talkMock.nextStopError) throw talkMock.nextStopError;
			this.stopped = true;
		}
	}
	return { NextcloudTalkAdapter: FakeNextcloudTalkAdapter };
});

vi.mock("../../src/core/server.js", () => ({
	startGatewayServer: vi.fn(async (_port: number) => {}),
	stopGatewayServer: vi.fn(async () => {}),
}));

// ── Test-Setup-Helfer ────────────────────────────────────────────────────────

/** Basis-Config für den Nextcloud-Talk-Block (enabled, lauffähig). */
function talkBlock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		enabled: true,
		baseUrl: "https://nextcloud.example",
		userId: "bot",
		appToken: "token-123",
		rooms: ["room-a", "room-b"],
		intervalMs: 5000,
		...overrides,
	};
}

/** Schreibt eine (partielle) Config in die isolierte GATEWAY_CONFIG_FILE. */
function writeConfigFile(value: Record<string, unknown>): void {
	writeFileSync(GATEWAY_CONFIG_FILE, JSON.stringify(value));
}

/** Setzt runtime.config/state deterministisch (ohne initRuntime-Side-Effects). */
function setRuntime(configValue: Record<string, unknown>, running: boolean): void {
	runtime.config = mergeGatewayConfig(configValue);
	runtime.state = {
		running,
		adapters: new Map(),
		clients: new Map(),
		sessions: new Map(),
	};
}

/** Baut einen Fake-Adapter (mit funktionierendem stop(), der den
 * talkMock-Fehlerinjektion-Pfad respektiert). */
function makeFakeAdapter(config: Record<string, unknown>): FakeAdapter {
	const adapter = {
		config,
		started: false,
		stopped: false,
		startCallbacks: null,
		async stop(): Promise<void> {
			if (talkMock.nextStopError) throw talkMock.nextStopError;
			adapter.stopped = true;
		},
	} as unknown as FakeAdapter;
	talkMock.instances.push(adapter);
	return adapter;
}

/** Registriert einen Fake-Adapter als laufenden "nextcloudTalk"-Poller. */
function registerRunningAdapter(config: Record<string, unknown>): FakeAdapter {
	const adapter = makeFakeAdapter(config);
	adapter.started = true;
	runtime.state.adapters.set("nextcloudTalk", adapter);
	return adapter;
}

beforeEach(() => {
	talkMock.instances = [];
	talkMock.nextInitializeError = null;
	talkMock.nextStartError = null;
	talkMock.nextStopError = null;
	vi.mocked(startGatewayServer).mockClear();
	vi.mocked(stopGatewayServer).mockClear();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("reloadDaemonConfig — Nextcloud-Talk-Poller-Restart", () => {
	it("1. restartet den Poller bei Nextcloud-Änderung (neue Werte greifen)", async () => {
		const oldTalk = talkBlock({ baseUrl: "https://old.example", intervalMs: 5000 });
		setRuntime({ platforms: { nextcloudTalk: oldTalk } }, true);
		const running = registerRunningAdapter(oldTalk);

		// baseUrl + Poll-Intervall ändern — Host/Port bleiben gleich.
		writeConfigFile({
			platforms: {
				nextcloudTalk: talkBlock({ baseUrl: "https://new.example", intervalMs: 2500 }),
			},
		});

		await reloadDaemonConfig();

		// Alter Adapter (mit alten Werten) wurde gestoppt …
		expect(running.stopped).toBe(true);
		// … und ein neuer Adapter mit den NEUEN Werten gestartet + registriert.
		expect(talkMock.instances).toHaveLength(2);
		const restarted = talkMock.instances[1];
		expect(restarted.config.baseUrl).toBe("https://new.example");
		expect(restarted.config.intervalMs).toBe(2500);
		expect(restarted.started).toBe(true);
		expect(runtime.state.adapters.get("nextcloudTalk")).toBe(restarted);

		// Config wurde angewendet; kein kompletter Server-Restart nötig.
		expect(runtime.config.platforms.nextcloudTalk?.baseUrl).toBe("https://new.example");
		expect(stopGatewayServer).not.toHaveBeenCalled();
		expect(startGatewayServer).not.toHaveBeenCalled();
	});

	it("2. toucht den Poller nicht, wenn nur ein anderes Config-Feld geändert wird", async () => {
		const oldTalk = talkBlock();
		setRuntime({ platforms: { nextcloudTalk: oldTalk } }, true);
		const running = registerRunningAdapter(oldTalk);

		// Nur die Session-Reset-Logik ändern — Nextcloud-Block bleibt identisch.
		writeConfigFile({
			sessions: { idleMinutes: 42 },
			platforms: { nextcloudTalk: oldTalk },
		});

		await reloadDaemonConfig();

		expect(running.stopped).toBe(false);
		expect(talkMock.instances).toHaveLength(1); // kein neuer Adapter gebaut
		expect(runtime.state.adapters.get("nextcloudTalk")).toBe(running);
		expect(runtime.config.sessions.idleMinutes).toBe(42);
	});

	it("3. stoppt den Poller, wenn Nextcloud Talk deaktiviert wird", async () => {
		const oldTalk = talkBlock();
		setRuntime({ platforms: { nextcloudTalk: oldTalk } }, true);
		const running = registerRunningAdapter(oldTalk);

		writeConfigFile({
			platforms: { nextcloudTalk: talkBlock({ enabled: false }) },
		});

		await reloadDaemonConfig();

		expect(running.stopped).toBe(true);
		expect(runtime.state.adapters.has("nextcloudTalk")).toBe(false);
		expect(talkMock.instances).toHaveLength(1); // kein Neustart
	});

	it("4. startet den Poller, wenn Nextcloud Talk aktiviert wird (Self-Heal)", async () => {
		setRuntime({ platforms: { nextcloudTalk: talkBlock({ enabled: false }) } }, true);
		expect(runtime.state.adapters.has("nextcloudTalk")).toBe(false);

		const newTalk = talkBlock();
		writeConfigFile({ platforms: { nextcloudTalk: newTalk } });

		await reloadDaemonConfig();

		expect(talkMock.instances).toHaveLength(1);
		const started = talkMock.instances[0];
		expect(started.config.baseUrl).toBe(newTalk.baseUrl);
		expect(started.started).toBe(true);
		expect(runtime.state.adapters.get("nextcloudTalk")).toBe(started);
	});

	it("5. isoliert Initialize-Fehler beim Restart (N1): Reload wirft nicht", async () => {
		const oldTalk = talkBlock();
		setRuntime({ platforms: { nextcloudTalk: oldTalk } }, true);
		const running = registerRunningAdapter(oldTalk);

		writeConfigFile({
			platforms: { nextcloudTalk: talkBlock({ appToken: "token-456" }) },
		});
		talkMock.nextInitializeError = new Error("Nextcloud Talk auth failed: AUTH_FAILED");

		await expect(reloadDaemonConfig()).resolves.not.toThrow();

		// Alter Adapter ist gestoppt, Neustart fehlgeschlagen → Kanal down,
		// aber Daemon lebt und die neue Config ist angewendet.
		expect(running.stopped).toBe(true);
		const attempted = talkMock.instances[1];
		expect(attempted).toBeDefined();
		expect(attempted?.started).toBe(false);
		expect(runtime.state.adapters.has("nextcloudTalk")).toBe(false);
		expect(runtime.config.platforms.nextcloudTalk?.appToken).toBe("token-456");
	});

	it("6. versucht keinen Restart, wenn der Daemon nicht läuft", async () => {
		const oldTalk = talkBlock();
		setRuntime({ platforms: { nextcloudTalk: oldTalk } }, false);

		writeConfigFile({
			platforms: { nextcloudTalk: talkBlock({ baseUrl: "https://new.example" }) },
		});

		await reloadDaemonConfig();

		expect(talkMock.instances).toHaveLength(0); // kein Adapter gebaut
		expect(runtime.config.platforms.nextcloudTalk?.baseUrl).toBe("https://new.example");
	});

	it("7. behält den Listener-Change-Pfad: voller Server-Restart", async () => {
		const oldTalk = talkBlock();
		setRuntime({ host: "127.0.0.1", port: 8790, platforms: { nextcloudTalk: oldTalk } }, true);

		writeConfigFile({
			host: "127.0.0.1",
			port: 8791, // Port-Wechsel → Listener-Change
			platforms: { nextcloudTalk: talkBlock({ baseUrl: "https://new.example" }) },
		});

		await reloadDaemonConfig();

		expect(stopGatewayServer).toHaveBeenCalledTimes(1);
		expect(startGatewayServer).toHaveBeenCalledWith(8791);
		expect(runtime.config.port).toBe(8791);
	});
});

describe("nextcloudTalkConfigChanged — reine Vergleichsfunktion", () => {
	const base = {
		enabled: true,
		baseUrl: "https://nc.example",
		userId: "bot",
		appToken: "t",
		rooms: ["a"],
	} as const;

	function cfg(talk: unknown): GatewayConfig {
		return mergeGatewayConfig({ platforms: talk === undefined ? {} : { nextcloudTalk: talk } });
	}

	it("liefert false für identische Blöcke", () => {
		expect(nextcloudTalkConfigChanged(cfg(base), cfg({ ...base }))).toBe(false);
	});

	it("liefert true bei Änderung eines einzelnen Feldes", () => {
		for (const [key, value] of Object.entries({
			enabled: false,
			baseUrl: "https://other.example",
			userId: "other",
			appToken: "u",
			intervalMs: 999,
			pollMode: "interval",
			allowInsecureHttp: true,
		})) {
			expect(nextcloudTalkConfigChanged(cfg(base), cfg({ ...base, [key]: value })), key).toBe(
				true,
			);
		}
	});

	it("liefert true bei Rooms-Änderung (Inhalt und Reihenfolge)", () => {
		expect(nextcloudTalkConfigChanged(cfg(base), cfg({ ...base, rooms: ["a", "b"] }))).toBe(
			true,
		);
		expect(nextcloudTalkConfigChanged(cfg({ ...base, rooms: ["a", "b"] }), cfg(base))).toBe(
			true,
		);
	});

	it("liefert true bei Aktivierung/Deaktivierung und fehlendem Block", () => {
		const off = mergeGatewayConfig({ platforms: { nextcloudTalk: { enabled: false } } });
		const on = cfg(base);
		expect(nextcloudTalkConfigChanged(off, on)).toBe(true);
		expect(nextcloudTalkConfigChanged(on, off)).toBe(true);
	});

	it("ignoriert veränderte Nicht-Nextcloud-Blöcke", () => {
		const a = mergeGatewayConfig({ sessions: { idleMinutes: 10 } });
		const b = mergeGatewayConfig({ sessions: { idleMinutes: 20 } });
		expect(nextcloudTalkConfigChanged(a, b)).toBe(false);
	});
});

describe("restartNextcloudTalkAdapter — Direkt-Verhalten", () => {
	it("stoppt einen fehlerhaften alten Adapter trotzdem (Stop-Fehler isoliert)", async () => {
		setRuntime({}, true);
		const broken = registerRunningAdapter(talkBlock());
		talkMock.nextStopError = new Error("stop failed");

		await expect(
			restartNextcloudTalkAdapter(
				mergeGatewayConfig({ platforms: { nextcloudTalk: talkBlock() } }),
			),
		).resolves.not.toThrow();

		expect(broken.stopped).toBe(false); // stop() hat geworfen
		expect(runtime.state.adapters.has("nextcloudTalk")).toBe(true); // neuer Adapter drin
		const restarted = runtime.state.adapters.get("nextcloudTalk");
		expect(restarted).not.toBe(broken);
	});
});
