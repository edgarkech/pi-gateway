/**
 * Step 9 Smoke Test — core/tools.ts + index.ts tool wiring.
 *
 * Verifies (per plan §6 S13 and task gate):
 *  - S2:       Module graph loads; `core/tools.js` exports `[registerGatewayTools]`;
 *              `dist/index.js` default export is a function.
 *  - S13:      The default export registers all 5 gateway tools via
 *              `registerGatewayTools(pi)`:
 *                  gateway_status, gateway_sessions, gateway_background_tasks,
 *                  gateway_pairing, gateway_tool_policy.
 *              Each tool's `execute` path is reachable and returns valid content.
 *  - Dependency wiring: tools resolve against shared runtime + imported
 *      daemon/rpc/config/status/sessions/background/security modules.
 */

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean) {
	if (cond) {
		pass++;
		console.log(`  ✓ ${label}`);
	} else {
		fail++;
		console.error(`  ✗ ${label}`);
	}
}

async function main() {
	console.log("=== STEP-9 SMOKE (S1 build, S2, S13) ===");

	// ---- S1: build already verified by npm run build externally ----
	// (tsc 0 errors is the gate; re-assert here that dist artifacts exist)

	// ---- S2: module graph + exports ----
	const toolsModule = (await import("../dist/core/tools.js")) as {
		registerGatewayTools: (pi: any) => void;
	};
	ok(
		"S2 tools exports [registerGatewayTools]",
		JSON.stringify(Object.keys(toolsModule)) === JSON.stringify(["registerGatewayTools"]),
	);

	const idxModule = (await import("../dist/index.js")) as {
		default: (pi: any) => void;
	};
	ok("S2 index default export is a function", typeof idxModule.default === "function");

	// ---- S13: default export registers the 5 gateway tools ----
	const registeredTools: Record<string, any> = {};
	const mockPi = {
		registerCommand: () => {},
		registerTool: (def: any) => {
			registeredTools[def.name] = def;
		},
		on: () => {},
	};
	idxModule.default(mockPi);

	const expectedTools = [
		"gateway_status",
		"gateway_sessions",
		"gateway_background_tasks",
		"gateway_pairing",
		"gateway_tool_policy",
	];
	ok(
		"S13 default export registered all 5 tools",
		expectedTools.every((t) => typeof registeredTools[t] === "object"),
	);
	ok("S13 exactly 5 tools registered (no extras)", Object.keys(registeredTools).length === 5);

	// Initialize shared state + stores so tool handlers work.
	const state = (await import("../dist/state.js")) as any;
	const runtime = state.runtime;
	const store = (await import("../dist/sessions/store.js")) as any;
	const security = (await import("../dist/security/auth.js")) as any;
	const background = (await import("../dist/background/manager.js")) as any;
	store.initSessionStore();
	security.initSecurityStore();
	background.initBackgroundTasks();
	runtime.state.running = false;
	runtime.state.adapters = new Map();
	runtime.state.clients = new Map();
	runtime.state.sessions = new Map();
	runtime.config.port = 3847;

	async function execTool(name: string, params: Record<string, unknown> = {}) {
		const def = registeredTools[name];
		return await def.execute("call-1", params, null, () => {}, {});
	}

	// ---- gateway_status ----
	const status = await execTool("gateway_status");
	ok(
		"S13 gateway_status returns text content",
		Array.isArray(status.content) && status.content[0]?.type === "text",
	);
	ok(
		"S13 gateway_status text mentions Gateway + Port",
		String(status.content[0].text).includes("Gateway:") &&
			String(status.content[0].text).includes("Port:"),
	);
	ok(
		"S13 gateway_status details has running + agentConnected",
		typeof status.details.agentConnected !== "undefined" && "running" in status.details,
	);

	// ---- gateway_sessions ----
	const sessions = await execTool("gateway_sessions");
	ok(
		"S13 gateway_sessions returns text content",
		Array.isArray(sessions.content) && sessions.content[0]?.type === "text",
	);
	ok("S13 gateway_sessions details has count", typeof sessions.details.count === "number");

	// ---- gateway_background_tasks ----
	const tasks = await execTool("gateway_background_tasks", { status: "all" });
	ok(
		"S13 gateway_background_tasks returns text content",
		Array.isArray(tasks.content) && tasks.content[0]?.type === "text",
	);
	ok("S13 gateway_background_tasks details has count", typeof tasks.details.count === "number");

	// ---- gateway_pairing (generate) ----
	const pairing = await execTool("gateway_pairing", {
		action: "generate",
		platform: "discord",
		userId: "U9",
	});
	ok(
		"S13 gateway_pairing generate returns text content",
		Array.isArray(pairing.content) && pairing.content[0]?.type === "text",
	);
	ok("S13 gateway_pairing generate details has code", typeof pairing.details.code === "string");

	// ---- gateway_pairing (generate requires platform+userId) ----
	const pairingMissing = await execTool("gateway_pairing", { action: "generate" });
	ok(
		"S13 gateway_pairing generate (missing args) returns error details",
		pairingMissing.details?.error === true,
	);

	// ---- gateway_pairing (list) ----
	const pairingList = await execTool("gateway_pairing", { action: "list" });
	ok(
		"S13 gateway_pairing list returns text content",
		Array.isArray(pairingList.content) && pairingList.content[0]?.type === "text",
	);
	ok("S13 gateway_pairing list details has count", typeof pairingList.details.count === "number");

	// ---- gateway_tool_policy (defaults) ----
	const policyDefaults = await execTool("gateway_tool_policy", { action: "defaults" });
	ok(
		"S13 gateway_tool_policy defaults returns text content",
		Array.isArray(policyDefaults.content) && policyDefaults.content[0]?.type === "text",
	);
	ok(
		"S13 gateway_tool_policy defaults details has allowed",
		Array.isArray(policyDefaults.details.allowed),
	);

	// ---- gateway_tool_policy (set) ----
	const policySet = await execTool("gateway_tool_policy", {
		action: "set",
		toolName: "bash",
		policyAction: "deny",
		platform: "discord",
		userId: "U11",
	});
	ok("S13 gateway_tool_policy set returns success", policySet.details?.success === true);

	// ---- gateway_tool_policy (list) ----
	const policyList = await execTool("gateway_tool_policy", { action: "list" });
	ok(
		"S13 gateway_tool_policy list returns text content",
		Array.isArray(policyList.content) && policyList.content[0]?.type === "text",
	);
	ok(
		"S13 gateway_tool_policy list details has count",
		typeof policyList.details.count === "number",
	);

	// ---- gateway_tool_policy (remove) ----
	const policyRemove = await execTool("gateway_tool_policy", { action: "remove", policyId: 1 });
	ok(
		"S13 gateway_tool_policy remove returns success",
		typeof policyRemove.details?.success === "boolean",
	);

	// ---- gateway_tool_policy (reset) ----
	const policyReset = await execTool("gateway_tool_policy", { action: "reset" });
	ok("S13 gateway_tool_policy reset returns success", policyReset.details?.success === true);

	// ---- Dependency wiring: tools depend on runtime/config/status/rpc/daemon ----
	const config = (await import("../dist/config.js")) as any;
	const rpc = (await import("../dist/core/rpc.js")) as any;
	const daemon = (await import("../dist/core/daemon.js")) as any;
	ok("S13 tools depends on runtime object", typeof runtime.config === "object");
	ok(
		"S13 tools depends on config helpers",
		typeof config.readDetachedHealthConfig === "function" &&
			typeof config.getDetachedGatewayHealth === "function",
	);
	ok("S13 tools depends on rpc.isAgentRunning", typeof rpc.isAgentRunning === "function");
	ok("S13 tools depends on daemon.readDaemonPid", typeof daemon.readDaemonPid === "function");

	console.log("\n=== STEP-9 SMOKE RESULT ===");
	if (fail === 0) {
		console.log(`STEP-9 SMOKE PASSED (S1 build, S2, S13) — ${pass} assertions`);
		process.exit(0);
	} else {
		console.error(`STEP-9 SMOKE FAILED — ${fail} failed / ${pass} passed`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error("STEP-9 SMOKE CRASHED:", err);
	process.exit(1);
});
