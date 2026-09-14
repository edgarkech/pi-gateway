import { existsSync, readFileSync, writeFileSync, watchFile, unwatchFile } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { GATEWAY_CONFIG_DIR, GATEWAY_CONFIG_FILE } from "../paths.js";
import {
	parseGatewayPid,
	removeGatewayPidFile,
	waitForGatewayHealth,
	writeGatewayPidFile,
} from "../status.js";
import { logger } from "../logger.js";
import { mergeGatewayConfig, readDetachedHealthConfig } from "../config.js";
import { runtime, initRuntime } from "../state.js";
import type { GatewayConfig } from "../types.js";
import { NextcloudTalkAdapter } from "../adapters/nextcloud-talk.js";
import { adapterCallbacks } from "./message-pipeline.js";
import { initSessionStore } from "../sessions/store.js";
import { initSecurityStore } from "../security/auth.js";
import { initBackgroundTasks } from "../background/manager.js";
import { bootstrapMediaManager } from "../media/bootstrap.js";
import { shutdownMediaManager } from "../media/manager.js";
import { shutdownTalkStateStore } from "../adapters/nextcloud/store.js";
import { isAgentRunning } from "./rpc.js";
import { startGatewayServer, stopGatewayServer } from "./server.js";

// PID file for detached daemon mode
const PID_FILE = join(GATEWAY_CONFIG_DIR, "gateway.pid");

export const isDaemonMode = process.argv.includes("--daemon");

function readDaemonPid(): number | null {
	if (!existsSync(PID_FILE)) return null;

	let rawPid: string;
	try {
		rawPid = readFileSync(PID_FILE, "utf-8").trim();
	} catch {
		return null;
	}

	const pid = parseGatewayPid(rawPid);
	if (pid === null) return null;

	try {
		process.kill(pid, 0);
		return pid;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EPERM") return pid;
		removeGatewayPidFile(PID_FILE, pid);
		return null;
	}
}

/** Top-level dispatch for daemon mode. Replaces the inline `if (isDaemonMode) …`. */
export function bootstrapIfDaemon(): void {
	if (isDaemonMode) {
		void detachAndRun();
	}
}

/**
 * Phase 4 (S5): stop all running platform adapters (concept §5.4).
 *
 * Idempotent and safe to call when no adapters are registered or when
 * `stopGatewayServer()` already stopped them (its adapter-stop path is the
 * primary one; this covers the cases where it was skipped or timed out,
 * e.g. an early startup failure after `initializeAdapters()`). Per-adapter
 * errors are logged and isolated so one failing adapter cannot block the
 * daemon shutdown.
 */
async function stopAllAdapters(): Promise<void> {
	const adapters = runtime.state?.adapters;
	if (!adapters || adapters.size === 0) return;

	const entries = Array.from(adapters.entries());
	const results = await Promise.allSettled(entries.map(([, adapter]) => adapter.stop()));
	entries.forEach(([name], i) => {
		const result = results[i];
		if (result && result.status === "rejected") {
			logger.error(`[pi-gateway] Adapter '${name}' failed to stop:`, result.reason);
		}
	});
	adapters.clear();
}

/**
 * Fields of `platforms.nextcloudTalk` that the `NextcloudTalkAdapter` /
 * `NextcloudTalkPoller` consume at construction time. The poller keeps its
 * config in memory, so a change to any of these requires a restart for the
 * new values to take effect. (`autoDiscoverRooms`/`roomRefreshIntervalMs`
 * are consumed since P2b: discovery runs at start and on a refresh timer,
 * so changes to them also require a restart.)
 */
const NEXTCLOUD_TALK_CONSUMED_FIELDS = [
	"enabled",
	"baseUrl",
	"userId",
	"appToken",
	"rooms",
	"pollMode",
	"longPollTimeoutSeconds",
	"intervalMs",
	"minPollIntervalMs",
	"backoffMaxMs",
	"maxConcurrentPolls",
	"circuitThreshold",
	"autoDiscoverRooms",
	"roomRefreshIntervalMs",
	"allowInsecureHttp",
	"maxAttachmentsPerMessage",
] as const;

/**
 * Detects a Nextcloud Talk config change that a running poller cannot pick
 * up on its own (it holds the config from construction time in memory).
 */
export function nextcloudTalkConfigChanged(prev: GatewayConfig, next: GatewayConfig): boolean {
	const a = prev.platforms?.nextcloudTalk;
	const b = next.platforms?.nextcloudTalk;
	if (a === b) return false; // both undefined or the very same reference

	for (const key of NEXTCLOUD_TALK_CONSUMED_FIELDS) {
		const av = a?.[key];
		const bv = b?.[key];
		if (Array.isArray(av) || Array.isArray(bv)) {
			if (JSON.stringify(av) !== JSON.stringify(bv)) return true;
		} else if (av !== bv) {
			return true;
		}
	}
	return false;
}

/**
 * Restarts the Nextcloud Talk adapter (and with it the poller) with the given
 * config: stops the running instance (waiting for in-flight polls), then
 * builds a fresh adapter from the new config — re-validation, auth probe and
 * warm watermark start included.
 *
 * Stop-before-start ordering is deliberate: `stop()` closes the default
 * Talk-state DB, so the old instance must be gone before the new one reopens
 * it. The brief gap during a reload is acceptable (identical to a full server
 * restart); persisted watermarks prevent message re-processing.
 *
 * Failure semantics follow the registry (N1): errors are logged and isolated
 * — the channel stays down until the next successful reload, but the daemon
 * keeps running with the new config applied.
 */
export async function restartNextcloudTalkAdapter(config: GatewayConfig): Promise<void> {
	const adapters = runtime.state?.adapters;
	if (!adapters) return;

	const existing = adapters.get("nextcloudTalk");
	if (existing) {
		try {
			await existing.stop();
		} catch (err) {
			logger.error("[pi-gateway] Failed to stop Nextcloud Talk adapter:", err);
		}
		adapters.delete("nextcloudTalk");
	}

	const talk = config.platforms?.nextcloudTalk;
	if (!talk?.enabled) {
		logger.info("[pi-gateway] Nextcloud Talk adapter stopped (disabled in config)");
		return;
	}

	try {
		const nextcloudTalk = new NextcloudTalkAdapter({
			enabled: true,
			platform: "nextcloudTalk",
			baseUrl: talk.baseUrl,
			userId: talk.userId,
			appToken: talk.appToken,
			rooms: [...talk.rooms],
			pollMode: talk.pollMode,
			longPollTimeoutSeconds: talk.longPollTimeoutSeconds,
			intervalMs: talk.intervalMs,
			minPollIntervalMs: talk.minPollIntervalMs,
			backoffMaxMs: talk.backoffMaxMs,
			maxConcurrentPolls: talk.maxConcurrentPolls,
			circuitThreshold: talk.circuitThreshold,
			autoDiscoverRooms: talk.autoDiscoverRooms,
			roomRefreshIntervalMs: talk.roomRefreshIntervalMs,
			allowInsecureHttp: talk.allowInsecureHttp,
			maxAttachmentsPerMessage: talk.maxAttachmentsPerMessage,
		});
		await nextcloudTalk.initialize();
		await nextcloudTalk.start(adapterCallbacks);
		adapters.set("nextcloudTalk", nextcloudTalk);
		logger.info("[pi-gateway] Nextcloud Talk adapter restarted with new config");
	} catch (err) {
		logger.error("[pi-gateway] Failed to start Nextcloud Talk adapter:", err);
	}
}

/** Apply config changes with listener rollback so the daemon stays manageable. */
export async function reloadDaemonConfig(): Promise<void> {
	const previousConfig = runtime.config;
	const nextConfig = mergeGatewayConfig(JSON.parse(readFileSync(GATEWAY_CONFIG_FILE, "utf-8")));
	const listenerChanged =
		nextConfig.host !== previousConfig.host || nextConfig.port !== previousConfig.port;
	const nextcloudChanged = nextcloudTalkConfigChanged(previousConfig, nextConfig);

	if (!listenerChanged) {
		runtime.config = nextConfig;
		// Nextcloud Talk: the running poller holds its config in memory — on
		// any change of the consumed block, stop and restart it so the new
		// values take effect without a full server restart.
		if (nextcloudChanged && runtime.state?.running) {
			await restartNextcloudTalkAdapter(nextConfig);
		}
		return;
	}

	if (!runtime.state.running) {
		runtime.config = nextConfig;
		return;
	}

	// Listener change → full server restart. stopGatewayServer() stops all
	// adapters (incl. the Nextcloud poller); startGatewayServer()
	// re-initializes them from the new config.
	await stopGatewayServer();
	runtime.config = nextConfig;
	try {
		await startGatewayServer(runtime.config.port);
	} catch (rebindError) {
		await stopGatewayServer();
		runtime.config = previousConfig;
		try {
			await startGatewayServer(runtime.config.port);
			writeFileSync(GATEWAY_CONFIG_FILE, `${JSON.stringify(previousConfig, null, 2)}\n`);
		} catch (rollbackError) {
			logger.error(
				`[pi-gateway] Listener rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
			);
			process.kill(process.pid, "SIGTERM");
		}
		throw new Error(
			`Listener rebind failed and was rolled back: ${rebindError instanceof Error ? rebindError.message : String(rebindError)}`,
			{ cause: rebindError },
		);
	}
}

/** Watch ~/.pi/gateway/config.json for validated, serialized reloads. */
function startConfigWatcher(): void {
	if (!existsSync(GATEWAY_CONFIG_FILE)) return;

	watchFile(GATEWAY_CONFIG_FILE, () => {
		if (runtime.daemonShuttingDown) return;
		runtime.configReloadQueue = runtime.configReloadQueue
			.then(reloadDaemonConfig)
			.then(() => {
				logger.info("[pi-gateway] Config reloaded from", GATEWAY_CONFIG_FILE);
			})
			.catch((error) => {
				logger.error(
					"[pi-gateway] Config reload failed — keeping previous valid config. Error:",
					error instanceof Error ? error.message : String(error),
				);
			});
	});

	logger.info("[pi-gateway] Watching config file for changes:", GATEWAY_CONFIG_FILE);
}

/** Run the gateway as a standalone detached daemon process. */
async function detachAndRun(): Promise<void> {
	process.title = "pi-gateway-daemon";
	process.stdout.write = () => true;
	process.stderr.write = () => true;

	// Acquire the daemon identity atomically before opening any resources.
	try {
		writeGatewayPidFile(PID_FILE, process.pid);
	} catch (error) {
		logger.error(
			`[pi-gateway] Failed to acquire daemon PID file: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	}

	let shutdownStarted = false;
	const shutdown = async (exitCode = 0) => {
		if (shutdownStarted) return;
		shutdownStarted = true;
		runtime.daemonShuttingDown = true;
		unwatchFile(GATEWAY_CONFIG_FILE);
		logger.info("[pi-gateway] Daemon shutting down...");
		await runtime.configReloadQueue.catch(() => {});
		if (runtime.state?.running || runtime.server || isAgentRunning()) {
			await Promise.race([
				stopGatewayServer(),
				new Promise<void>((resolve) => setTimeout(resolve, 10000)),
			]);
		}
		// Phase 4 (S5): stop all platform adapters (Nextcloud Talk poller etc.)
		// and close the Talk state DB — ordered BEFORE shutdownMediaManager() so
		// no adapter can still ingest media while the media store is torn down
		// (concept §5.4). Both calls are idempotent: stopAllAdapters() is a no-op
		// when stopGatewayServer() already stopped the adapters, and
		// shutdownTalkStateStore() is a no-op when the store was never opened.
		await stopAllAdapters();
		shutdownTalkStateStore();
		// Phase 3 (S6): graceful media cleanup — final TTL sweep, clear the
		// sweep interval, and close the registry DB before exiting.
		await shutdownMediaManager();
		removeGatewayPidFile(PID_FILE, process.pid);
		process.exit(exitCode);
	};
	process.on("SIGTERM", () => void shutdown());
	process.on("SIGINT", () => void shutdown());
	process.on("uncaughtException", (err) => {
		logger.error(`[pi-gateway] UNCAUGHT EXCEPTION: ${err.stack || err.message}`);
		void shutdown(1);
	});
	process.on("unhandledRejection", (reason) => {
		logger.error(
			`[pi-gateway] UNHANDLED REJECTION: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`,
		);
	});

	logger.info(`[pi-gateway] Daemon starting (PID ${process.pid})`);
	try {
		initRuntime();
		initSessionStore();
		initSecurityStore();
		initBackgroundTasks();

		// Phase 3 (S6): bootstrap the MediaManager singleton from merged config.
		runtime.media = bootstrapMediaManager(runtime.config.media);

		process.on("SIGHUP", () => {
			if (runtime.daemonShuttingDown) return;
			runtime.configReloadQueue = runtime.configReloadQueue
				.then(async () => {
					logger.info("[pi-gateway] SIGHUP received — reloading config...");
					await reloadDaemonConfig();
					logger.info("[pi-gateway] SIGHUP config reload complete");
				})
				.catch((error) => {
					logger.error(
						`[pi-gateway] SIGHUP reload failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				});
		});

		await startGatewayServer(runtime.config.port);
		startConfigWatcher();
		logger.info(`[pi-gateway] Daemon ready (PID ${process.pid})`);
	} catch (error) {
		logger.error(
			`[pi-gateway] Daemon startup failed: ${error instanceof Error ? error.stack || error.message : String(error)}`,
		);
		await shutdown(1);
	}
}

/** Spawn a detached daemon and verify it becomes healthy.
 *  Returns the outcome so the caller can notify the user identically to before. */
export async function spawnDetachedDaemon(): Promise<
	| { kind: "already-running"; pid: number; healthRunning: boolean }
	| { kind: "refusing"; pid: number }
	| { kind: "failed-pid" }
	| { kind: "failed-verify"; pid: number }
	| { kind: "started"; pid: number; running: boolean }
> {
	const existingPid = readDaemonPid();
	if (existingPid !== null) {
		const existingHealth = await waitForGatewayHealth(
			readDetachedHealthConfig(),
			existingPid,
			1500,
		);
		if (existingHealth) {
			return {
				kind: "already-running",
				pid: existingPid,
				healthRunning: existingHealth.running,
			};
		}
		return { kind: "refusing", pid: existingPid };
	}

	// Spawn detached daemon
	const entryPoint = new URL("../dist/index.js", import.meta.url).pathname;
	const child = spawn(process.execPath, [entryPoint, "--daemon"], {
		detached: true,
		stdio: "ignore",
		env: process.env,
	});
	child.unref();
	if (child.pid === undefined) {
		return { kind: "failed-pid" };
	}

	const startedHealth = await waitForGatewayHealth(readDetachedHealthConfig(), child.pid, 5000);
	if (!startedHealth) {
		return { kind: "failed-verify", pid: child.pid };
	}

	return { kind: "started", pid: child.pid, running: startedHealth.running };
}

export { PID_FILE, readDaemonPid };
