import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runtime } from "../state.js";
import { getDetachedGatewayHealth } from "../config.js";
import { resolveGatewayStatus } from "../status.js";
import { readDaemonPid } from "./daemon.js";

const STATUS_REFRESH_INTERVAL_MS = 2000;

// Status update
async function updateStatus(): Promise<void> {
	const ctx = runtime.globalCtx;
	if (!ctx) return;

	const generation = ++runtime.statusUpdateGeneration;
	const daemonPid = runtime.state.running ? null : readDaemonPid();
	const statusText = await resolveGatewayStatus({
		inlineRunning: runtime.state.running,
		adapterCount: runtime.state.adapters.size,
		daemonProcessRunning: daemonPid !== null,
		getDaemonHealth: () =>
			daemonPid === null ? Promise.resolve(null) : getDetachedGatewayHealth(daemonPid),
	});

	if (
		ctx !== runtime.globalCtx ||
		generation !== runtime.statusUpdateGeneration ||
		statusText === runtime.lastGatewayStatusText
	) {
		return;
	}
	runtime.lastGatewayStatusText = statusText;
	ctx.ui.setStatus("gateway", statusText);
}

// Registers the Pi session hooks that keep the footer synchronized with
// session start/shutdown (moved verbatim from index.ts).
function registerStatusFooter(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (runtime.statusRefreshInterval) clearInterval(runtime.statusRefreshInterval);
		runtime.statusRefreshInterval = null;
		runtime.globalCtx = ctx;
		runtime.lastGatewayStatusText = null;
		await updateStatus();
		if (runtime.globalCtx !== ctx) return;

		runtime.statusRefreshInterval = setInterval(updateStatus, STATUS_REFRESH_INTERVAL_MS);
		runtime.statusRefreshInterval.unref();
	});

	pi.on("session_shutdown", async () => {
		runtime.statusUpdateGeneration++;
		if (runtime.statusRefreshInterval) clearInterval(runtime.statusRefreshInterval);
		runtime.statusRefreshInterval = null;
		runtime.lastGatewayStatusText = null;
		runtime.globalCtx = null;
	});
}

export { updateStatus, STATUS_REFRESH_INTERVAL_MS, registerStatusFooter };
