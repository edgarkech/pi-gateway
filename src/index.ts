/**
 * pi-gateway - Hermes-style Messaging Gateway
 *
 * Architecture:
 * - Single background process
 * - Platform adapters (Discord, Telegram, etc.)
 * - Per-chat session management
 * - Background task support
 * - Security (allowlists, pairing)
 *
 * Usage:
 *   /gateway start [port]    - Start the gateway
 *   /gateway stop           - Stop the gateway
 *   /gateway status         - Show status
 *   /gateway pair <code>    - Approve pairing code
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { initSessionStore } from "./sessions/store.js";
import { logger } from "./logger.js";
import { initSecurityStore } from "./security/auth.js";
import { initBackgroundTasks } from "./background/manager.js";
import type { MediaManager } from "./media/manager.js";
import { bootstrapMediaManager } from "./media/bootstrap.js";
import { runtime, initRuntime } from "./state.js";
import { registerStatusFooter } from "./core/status-footer.js";
import { bootstrapIfDaemon } from "./core/daemon.js";
import { registerGatewayCommand } from "./core/commands.js";
import { registerGatewayTools } from "./core/tools.js";

export default function (pi: ExtensionAPI) {
	initRuntime();
	runtime.lastDetachedHealthConfig = runtime.config;

	// Phase 3 (S6): initialize stores
	initSessionStore();
	initSecurityStore();
	initBackgroundTasks();

	// Phase 3 (S6): wire the MediaManager singleton from merged config — lazily.
	// First access to `runtime.media` bootstraps the manager (SQLite registry +
	// periodic TTL sweep), so extension load schedules no extra timers: the
	// smoke test contract requires that only the 2s status-footer interval be
	// registered during load (tests/index.ts). The setter keeps existing
	// assignments working (test stubs, daemon bootstrap in core/daemon.ts).
	let mediaInstance: MediaManager | null | undefined;
	Object.defineProperty(runtime, "media", {
		get: () => {
			if (mediaInstance === undefined) {
				mediaInstance = bootstrapMediaManager(runtime.config.media);
			}
			return mediaInstance;
		},
		set: (value: MediaManager | null) => {
			mediaInstance = value;
		},
		configurable: true,
	});

	// Register commands
	registerGatewayCommand(pi);

	// Register tools
	registerGatewayTools(pi);
	// Keep the footer synchronized with detached daemons started outside this session.
	registerStatusFooter(pi);

	logger.info("[pi-gateway] Hermes-style gateway extension loaded");
}

bootstrapIfDaemon();
