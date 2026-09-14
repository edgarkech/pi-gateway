/**
 * Gateway Pi-tools registration (moved verbatim from index.ts — Step 9).
 *
 * Encapsulates the 5 `pi.registerTool(...)` calls for the gateway:
 *   gateway_status, gateway_sessions, gateway_background_tasks,
 *   gateway_pairing, gateway_tool_policy.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { runtime } from "../state.js";
import { readDetachedHealthConfig, getDetachedGatewayHealth } from "../config.js";
import { createGatewayStatusReport } from "../status.js";
import { listSessions } from "../sessions/store.js";
import { listTasks, type BackgroundStatus } from "../background/manager.js";
import {
	generatePairingCode,
	approvePairingCode,
	listPendingPairingCodes,
	isPlatform,
} from "../security/auth.js";
import {
	setToolPolicy,
	removeToolPolicy,
	listToolPolicies,
	resetToolPolicies,
	getEffectivePolicySummary,
} from "../security/tool-policy.js";
import { isAgentRunning } from "./rpc.js";

/** All valid background-task status literals (one per BackgroundStatus member). */
const BACKGROUND_STATUSES = [
	"running",
	"completed",
	"failed",
	"timeout",
	"delivered",
] as const satisfies readonly BackgroundStatus[];

/** Type guard: narrow an arbitrary string to a BackgroundStatus (or undefined). */
function isBackgroundStatus(value: unknown): value is BackgroundStatus {
	return typeof value === "string" && (BACKGROUND_STATUSES as readonly string[]).includes(value);
}
import { readDaemonPid } from "./daemon.js";

// Registers the 5 gateway tools (moved verbatim from index.ts).
function registerGatewayTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "gateway_status",
		label: "Gateway Status",
		description: "Check Hermes-style gateway status",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			const daemonPid = runtime.state.running ? null : readDaemonPid();
			const daemonProcessRunning = daemonPid !== null;
			const daemonHealth =
				daemonPid === null ? null : await getDetachedGatewayHealth(daemonPid);
			const report = createGatewayStatusReport({
				inlineRunning: runtime.state.running,
				inlineAdapters: runtime.state.adapters.size,
				inlineClients: runtime.state.clients.size,
				inlineSessions: runtime.state.sessions.size,
				inlineAgentConnected: isAgentRunning(),
				daemonProcessRunning,
				daemonHealth,
			});
			const metric = (value: number | null) => value ?? "unknown";
			const statusConfig = daemonPid === null ? runtime.config : readDetachedHealthConfig();
			const statusPid = daemonPid ?? (runtime.state.running ? process.pid : null);
			const agent =
				report.agentConnected === null
					? "Unknown"
					: report.agentConnected
						? "Connected"
						: "Disconnected";

			return {
				content: [
					{
						type: "text",
						text:
							`Gateway: ${report.status}\n` +
							`PID: ${statusPid ?? "unknown"}\n` +
							`Port: ${statusConfig.port}\n` +
							`Adapters: ${metric(report.adapters)}\n` +
							`Clients: ${metric(report.clients)}\n` +
							`Sessions: ${metric(report.sessions)}\n` +
							`Agent: ${agent}`,
					},
				],
				details: {
					running: report.running,
					mode: report.mode,
					pid: statusPid,
					port: statusConfig.port,
					adapters: report.adapters,
					clients: report.clients,
					sessions: report.sessions,
					agentConnected: report.agentConnected,
				},
			};
		},
	});

	pi.registerTool({
		name: "gateway_sessions",
		label: "Gateway Sessions",
		description: "List active gateway sessions",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			const sessions = listSessions();
			return {
				content: [
					{
						type: "text",
						text:
							`Active sessions: ${sessions.length}\n` +
							JSON.stringify(
								sessions.map((s) => ({
									id: s.id.slice(0, 12),
									platform: s.platform,
									channel: s.channelId,
									lastActivity: new Date(s.lastActivity).toISOString(),
								})),
								null,
								2,
							),
					},
				],
				details: { count: sessions.length },
			};
		},
	});

	pi.registerTool({
		name: "gateway_background_tasks",
		label: "Background Tasks",
		description: "List and manage background tasks",
		parameters: Type.Object({
			status: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const status = isBackgroundStatus(params.status) ? params.status : undefined;
			const tasks = listTasks(status);
			return {
				content: [
					{
						type: "text",
						text:
							`Background tasks: ${tasks.length}\n` +
							JSON.stringify(
								tasks.map((t) => ({
									id: t.id.slice(0, 12),
									status: t.status,
									progress: t.progress,
									command: t.command.slice(0, 50),
								})),
								null,
								2,
							),
					},
				],
				details: { count: tasks.length },
			};
		},
	});

	pi.registerTool({
		name: "gateway_pairing",
		label: "Gateway Pairing",
		description: "Generate or approve pairing codes",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("generate"),
				Type.Literal("list"),
				Type.Literal("approve"),
			]),
			platform: Type.Optional(Type.String()),
			userId: Type.Optional(Type.String()),
			code: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { action, platform, userId, code } = params;
			switch (action) {
				case "generate": {
					if (!platform || !userId) {
						return {
							content: [{ type: "text", text: "platform and userId required" }],
							details: { error: true },
						};
					}
					if (typeof platform !== "string" || !isPlatform(platform)) {
						return {
							content: [
								{
									type: "text",
									text: `Unknown platform "${platform}". Valid platforms: discord, telegram, slack, whatsapp, web, websocket, nextcloudTalk.`,
								},
							],
							details: { error: true },
						};
					}
					const pairingCode = generatePairingCode(platform, userId);
					return {
						content: [
							{
								type: "text",
								text: `Pairing code: ${pairingCode}\n\nShare this code with the user to approve access.`,
							},
						],
						details: { code: pairingCode },
					};
				}
				case "approve": {
					if (!code) {
						return {
							content: [{ type: "text", text: "code required" }],
							details: { error: true },
						};
					}
					const success = approvePairingCode(code);
					return {
						content: [
							{
								type: "text",
								text: success ? "✅ Code approved" : "❌ Invalid/expired",
							},
						],
						details: { success },
					};
				}
				case "list": {
					const pending = listPendingPairingCodes();
					return {
						content: [
							{
								type: "text",
								text:
									`Pending codes: ${pending.length}\n` +
									JSON.stringify(pending, null, 2),
							},
						],
						details: { count: pending.length },
					};
				}
			}
		},
	});

	pi.registerTool({
		name: "gateway_tool_policy",
		label: "Gateway Tool Policy",
		description: "Manage tool access policies for external gateway users",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("list"),
				Type.Literal("defaults"),
				Type.Literal("set"),
				Type.Literal("remove"),
				Type.Literal("reset"),
			]),
			platform: Type.Optional(Type.String()),
			userId: Type.Optional(Type.String()),
			toolName: Type.Optional(Type.String()),
			policyAction: Type.Optional(Type.Union([Type.Literal("allow"), Type.Literal("deny")])),
			policyId: Type.Optional(Type.Number()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { action, platform, userId, toolName, policyAction, policyId } = params;

			switch (action) {
				case "list": {
					const policies = listToolPolicies(platform, userId);
					return {
						content: [
							{
								type: "text",
								text:
									policies.length > 0
										? JSON.stringify(policies, null, 2)
										: "No explicit policies — only defaults active.",
							},
						],
						details: { count: policies.length, policies },
					};
				}

				case "defaults": {
					const summary = getEffectivePolicySummary(platform ?? "*", userId ?? "*");
					return {
						content: [
							{
								type: "text",
								text:
									`Default tool policy:\n\n` +
									`ALLOWED: ${summary.allowed.join(", ")}\n` +
									`DENIED: ${summary.denied.join(", ")}`,
							},
						],
						details: summary,
					};
				}

				case "set": {
					if (!toolName || !policyAction) {
						return {
							content: [
								{
									type: "text",
									text: "toolName and policyAction (allow|deny) are required",
								},
							],
							details: { error: true },
						};
					}
					setToolPolicy({
						platform: platform ?? null,
						userId: userId ?? null,
						toolName,
						action: policyAction,
						priority: 50,
					});
					return {
						content: [
							{
								type: "text",
								text: `Policy set: ${platform ?? "*"}:${userId ?? "*"} → ${toolName} [${policyAction}]`,
							},
						],
						details: { success: true },
					};
				}

				case "remove": {
					if (policyId == null) {
						return {
							content: [{ type: "text", text: "policyId (number) is required" }],
							details: { error: true },
						};
					}
					const removed = removeToolPolicy(policyId);
					return {
						content: [
							{
								type: "text",
								text: removed
									? `Removed policy #${policyId}`
									: `Policy #${policyId} not found`,
							},
						],
						details: { success: removed },
					};
				}

				case "reset": {
					resetToolPolicies();
					return {
						content: [{ type: "text", text: "All tool policies reset to defaults." }],
						details: { success: true },
					};
				}
			}
		},
	});
}

export { registerGatewayTools };
