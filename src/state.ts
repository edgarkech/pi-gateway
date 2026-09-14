import type { createServer } from "node:http";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WebSocketServer } from "ws";

import type { GatewayConfig, GatewayState } from "./types.js";
import { loadConfig } from "./config.js";
import type { MediaManager } from "./media/manager.js";

/** Hooks, die zur Laufzeit von anderen Modulen gesetzt werden (vermeidet Import-Zyklen). */
export interface GatewayHooks {
	/** Gesetzt von core/server.ts beim Start — wird vom RPC-Layer für Broadcasts genutzt. */
	broadcast?: (event: string, data: unknown) => void;
}

/** The pi RPC subprocess with all three stdio streams piped (stdin writable,
 *  stdout/stderr readable). Guaranteed by the spawn stdio config in rpc.ts. */
export type RpcProcess = ChildProcessByStdio<Writable, Readable, Readable>;

export interface GatewayRuntime {
	config: GatewayConfig;
	state: GatewayState;
	server: ReturnType<typeof createServer> | null;
	wss: WebSocketServer | null;
	rpcProcess: RpcProcess | null;
	globalCtx: ExtensionContext | null;
	cronInterval: ReturnType<typeof setInterval> | null;
	statusRefreshInterval: ReturnType<typeof setInterval> | null;
	lastGatewayStatusText: string | null;
	statusUpdateGeneration: number;
	lastDetachedHealthConfig: GatewayConfig | null;
	configReloadQueue: Promise<void>;
	daemonShuttingDown: boolean;
	hooks: GatewayHooks;

	/**
	 * Phase 3 (S5): process-wide MediaManager. Null until bootstrapped via
	 * `initMediaManager()` — the adapters and pipeline lazily seed it on first
	 * use (S3 singleton). Kept on the runtime so all adapters ingest media
	 * through one shared manager and tests can stub it deterministically.
	 */
	media: MediaManager | null;
}

export const runtime: GatewayRuntime = {
	config: undefined as unknown as GatewayConfig,
	state: undefined as unknown as GatewayState,
	server: null,
	wss: null,
	rpcProcess: null,
	globalCtx: null,
	cronInterval: null,
	statusRefreshInterval: null,
	lastGatewayStatusText: null,
	statusUpdateGeneration: 0,
	lastDetachedHealthConfig: null,
	configReloadQueue: Promise.resolve(),
	daemonShuttingDown: false,
	hooks: {},
	media: null,
};

/** Initialisiert Config + frische State-Maps (ersetzt die heutige Inline-Init in
 *  default-export und detachAndRun — beseitigt Duplikat #6 aus §1.4). */
export function initRuntime(): void {
	runtime.config = loadConfig();
	runtime.state = {
		running: false,
		adapters: new Map(),
		clients: new Map(),
		sessions: new Map(),
	};
}
