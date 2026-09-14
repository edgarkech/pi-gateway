/**
 * /gateway command registration (moved verbatim from index.ts — Step 8).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { runtime } from "../state.js";
import { loadConfig, readDetachedHealthConfig, getDetachedGatewayHealth } from "../config.js";
import { logger } from "../logger.js";
import { createGatewayStatusReport, waitForGatewayHealth } from "../status.js";
import { listSessions } from "../sessions/store.js";
import {
	approvePairingCode,
	listPendingPairingCodes,
	addToAllowlist,
	listAllowlistedUsers,
	revokeUserAccess,
	addAdmin,
	removeAdmin,
	listAdmins,
	isPlatform,
	type Platform,
} from "../security/auth.js";
import {
	setToolPolicy,
	removeToolPolicy,
	listToolPolicies,
	resetToolPolicies,
	getEffectivePolicySummary,
} from "../security/tool-policy.js";
import { listTasks } from "../background/manager.js";
import { isAgentRunning } from "./rpc.js";

/** Narrow a string to either a known Platform or the admin wildcard "*". */
function isAdminPlatform(value: string): value is Platform | "*" {
	return value === "*" || isPlatform(value);
}

/** Human-readable byte size for the status line (e.g. "128 MB"). */
function formatMediaBytes(bytes: number): string {
	if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GB`;
	if (bytes >= 1 << 20) return `${Math.round(bytes / (1 << 20))} MB`;
	if (bytes >= 1 << 10) return `${Math.round(bytes / (1 << 10))} KB`;
	return `${bytes} B`;
}
import { spawnDetachedDaemon, readDaemonPid } from "./daemon.js";
import { startGatewayServer, stopGatewayServer } from "./server.js";

// Registers the /gateway command with all subcommands (moved verbatim from index.ts).
function registerGatewayCommand(pi: ExtensionAPI): void {
	pi.registerCommand("gateway", {
		description: "Manage Hermes-style messaging gateway",
		getArgumentCompletions: (prefix: string) => {
			const cmds = [
				"start",
				"start -d",
				"stop",
				"status",
				"restart",
				"pair",
				"allow",
				"revoke",
				"admin",
				"sessions",
				"tasks",
				"config",
				"tool-policy",
			];
			return cmds.filter((c) => c.startsWith(prefix)).map((c) => ({ value: c, label: c }));
		},
		handler: async (args, ctx) => {
			const parts = args.split(/\s+/).filter(Boolean);
			const subcmd = parts[0]?.toLowerCase();

			switch (subcmd) {
				case "start": {
					const isDetached = parts.includes("-d") || parts.includes("--detached");

					if (isDetached) {
						const daemonSpawn = await spawnDetachedDaemon();
						if (daemonSpawn.kind === "already-running") {
							ctx.ui.notify(
								`Gateway daemon is already ${daemonSpawn.healthRunning ? "running" : "initializing"}.`,
								"info",
							);
							return;
						}
						if (daemonSpawn.kind === "refusing") {
							ctx.ui.notify(
								`A live process owns the gateway PID file (PID ${daemonSpawn.pid}), but its daemon API is unavailable. Refusing to start another daemon.`,
								"error",
							);
							return;
						}
						if (daemonSpawn.kind === "failed-pid") {
							ctx.ui.notify("Failed to spawn gateway daemon", "error");
							return;
						}
						if (daemonSpawn.kind === "failed-verify") {
							ctx.ui.notify(
								`Gateway daemon spawn could not be verified (PID ${daemonSpawn.pid}). Check the gateway log.`,
								"error",
							);
							return;
						}

						ctx.ui.notify(
							`🔌 Gateway daemon ${daemonSpawn.running ? "started" : "is initializing"} (PID ${daemonSpawn.pid}).\n\n` +
								"It will keep running after pi closes.\n" +
								"Use /gateway status to check, /gateway stop to kill.",
							"info",
						);
						return;
					}

					if (runtime.state.running) {
						ctx.ui.notify("Gateway already running", "info");
						return;
					}

					// Reload config fresh on every start so users can edit
					// ~/.pi/gateway/config.json without restarting pi
					runtime.config = loadConfig();
					const port = parseInt(parts[1]) || runtime.config.port;

					await startGatewayServer(port);

					ctx.ui.notify(
						`✅ Gateway started on http://${runtime.config.host}:${port}\n\n` +
							`Platforms: ${runtime.state.adapters.size > 0 ? Array.from(runtime.state.adapters.keys()).join(", ") : "none"}\n` +
							`Sessions: Idle reset every ${runtime.config.sessions.idleMinutes} min`,
						"info",
					);
					return;
				}

				case "stop": {
					// Never signal a PID until the daemon API confirms the same identity.
					const daemonPid = readDaemonPid();
					if (daemonPid !== null) {
						const health = await waitForGatewayHealth(
							readDetachedHealthConfig(),
							daemonPid,
							1500,
						);
						if (!health) {
							ctx.ui.notify(
								"Refusing to signal an unverified daemon PID. Check /gateway status.",
								"error",
							);
							return;
						}
						try {
							process.kill(daemonPid, "SIGTERM");
						} catch {
							ctx.ui.notify("Failed to stop daemon", "error");
							return;
						}

						for (let attempt = 0; attempt < 40; attempt++) {
							await new Promise((resolve) => setTimeout(resolve, 250));
							if (readDaemonPid() !== daemonPid) {
								ctx.ui.notify("Gateway daemon stopped", "info");
								return;
							}
						}
						ctx.ui.notify(
							`Stop signal sent, but daemon PID ${daemonPid} is still present.`,
							"warning",
						);
						return;
					}

					if (!runtime.state.running) {
						ctx.ui.notify("Gateway not running", "info");
						return;
					}

					await stopGatewayServer();
					ctx.ui.notify("Gateway stopped", "info");
					return;
				}

				case "restart": {
					if (runtime.state.running) {
						await stopGatewayServer();
					}

					// Reload config and start
					runtime.config = loadConfig();
					const port = parseInt(parts[1]) || runtime.config.port;
					await startGatewayServer(port);

					ctx.ui.notify(
						`✅ Gateway restarted on http://${runtime.config.host}:${port}\n\n` +
							`Platforms: ${runtime.state.adapters.size > 0 ? Array.from(runtime.state.adapters.keys()).join(", ") : "none"}\n` +
							`Sessions: Idle reset every ${runtime.config.sessions.idleMinutes} min`,
						"info",
					);
					return;
				}

				case "status": {
					const lines: string[] = [];
					const daemonPid = runtime.state.running ? null : readDaemonPid();
					const daemonHealth =
						daemonPid === null ? null : await getDetachedGatewayHealth(daemonPid);
					const report = createGatewayStatusReport({
						inlineRunning: runtime.state.running,
						inlineAdapters: runtime.state.adapters.size,
						inlineClients: runtime.state.clients.size,
						inlineSessions: runtime.state.sessions.size,
						inlineAgentConnected: isAgentRunning(),
						daemonProcessRunning: daemonPid !== null,
						daemonHealth,
					});
					const displayConfig =
						daemonPid === null ? runtime.config : readDetachedHealthConfig();
					const metric = (value: number | null) => value ?? "unknown";

					if (daemonPid !== null) {
						lines.push(
							daemonHealth?.running
								? `Daemon: 🟢 Verified (PID ${daemonPid})`
								: daemonHealth
									? `Daemon: 🟡 Initializing (PID ${daemonPid})`
									: `Daemon: 🟡 Unavailable (PID ${daemonPid})`,
						);
						lines.push("");
					}

					lines.push(`Mode: ${report.mode}`);
					lines.push(`Port: ${displayConfig.port}`);
					lines.push(`Adapters: ${metric(report.adapters)}`);
					lines.push(`Clients: ${metric(report.clients)}`);
					lines.push(`Sessions: ${metric(report.sessions)}`);
					lines.push(
						`Agent: ${report.agentConnected === null ? "Unknown" : report.agentConnected ? "✅ Connected" : "❌ Disconnected"}`,
					);
					lines.push("");
					lines.push(`Session Reset: ${displayConfig.sessions.resetPolicy}`);
					lines.push(`  - Daily at ${displayConfig.sessions.dailyHour}:00`);
					lines.push(`  - Idle after ${displayConfig.sessions.idleMinutes} min`);
					lines.push("");
					const adminCount =
						listAdmins().length +
						Object.values(displayConfig.security.adminUids ?? {}).reduce(
							(sum, uids) => sum + uids.length,
							0,
						);
					lines.push(
						`Security: ${displayConfig.security.allowAll ? "Allow all" : "Allowlist only"}${Object.values(displayConfig.security.allowedUids ?? {}).reduce((sum, uids) => sum + uids.length, 0) > 0 ? ` (+${Object.values(displayConfig.security.allowedUids ?? {}).reduce((sum, uids) => sum + uids.length, 0)} config UIDs)` : ""}`,
					);
					lines.push(`Admins: ${adminCount}`);

					// Phase 3 (S6, §14): media stats for inline status.
					if (daemonPid === null && runtime.media) {
						const mediaEnabled = displayConfig.media?.enabled ?? true;
						if (mediaEnabled) {
							try {
								const mediaStats = await runtime.media.stats();
								const quota = displayConfig.media?.maxTotalBytes;
								lines.push("");
								lines.push(
									`Media: ${mediaStats.fileCount} files, ${formatMediaBytes(mediaStats.totalBytes)}${quota ? ` / ${formatMediaBytes(quota)}` : ""}`,
								);
							} catch (error) {
								logger.warn(
									"[pi-gateway] Media stats unavailable:",
									error instanceof Error ? error.message : String(error),
								);
							}
						}
					}

					ctx.ui.setWidget("gateway-status", lines, {
						placement: "belowEditor",
					});
					setTimeout(() => ctx.ui.setWidget("gateway-status", undefined), 15000);
					return;
				}

				case "pair": {
					const code = parts[1]?.toUpperCase();
					const pending = code ? null : listPendingPairingCodes();
					if (pending) {
						ctx.ui.notify(
							"Pending pairing codes:\n" +
								(pending.length > 0
									? pending
											.map(
												(p) =>
													`${p.code} - ${p.platform} (${Math.round(p.expiresIn / 60000)}min)`,
											)
											.join("\n")
									: "None"),
							"info",
						);
						return;
					}

					if (approvePairingCode(code)) {
						ctx.ui.notify("Pairing code approved", "info");
					} else {
						ctx.ui.notify(`❌ Invalid or expired pairing code`, "error");
					}
					return;
				}

				case "allow": {
					// Narrow via isPlatform instead of a blind cast — unknown
					// platforms fall through to the list-display branch below.
					const platform: Platform | undefined = isPlatform(parts[1])
						? parts[1]
						: undefined;
					const userId = parts[2];
					const list = listAllowlistedUsers();
					const configUids = runtime.config.security.allowedUids ?? {};
					const configLines: string[] = [];
					for (const [plat, uids] of Object.entries(configUids)) {
						for (const uid of uids) {
							configLines.push(`${plat}:${uid} (config)`);
						}
					}
					if (!platform || !userId) {
						ctx.ui.notify(
							"Allowlisted users:\n" +
								(list.length > 0 || configLines.length > 0
									? [
											...list.map((u) => `${u.platform}:${u.userId}`),
											...configLines,
										].join("\n")
									: "None"),
							"info",
						);
						return;
					}

					addToAllowlist(platform, userId);
					ctx.ui.notify(`Added ${userId} to allowlist`, "info");
					return;
				}

				case "revoke": {
					const platform: Platform | undefined = isPlatform(parts[1])
						? parts[1]
						: undefined;
					const userId = parts[2];
					if (!platform || !userId) {
						ctx.ui.notify(
							"Usage: /gateway revoke <platform> <userId>\n" +
								"Removes a user from the DB allowlist.",
							"info",
						);
						return;
					}

					const removed = revokeUserAccess(platform, userId);
					ctx.ui.notify(
						removed
							? `Removed ${userId} from allowlist`
							: `${userId} was not in the allowlist`,
						removed ? "info" : "error",
					);
					return;
				}

				case "admin": {
					const action = parts[1]?.toLowerCase();

					switch (action) {
						case "list": {
							const dbAdmins = listAdmins();
							const configAdmins = runtime.config.security.adminUids ?? {};
							const configLines: string[] = [];
							for (const [plat, uids] of Object.entries(configAdmins)) {
								for (const uid of uids) {
									configLines.push(`${plat}:${uid} (config)`);
								}
							}
							const dbLines = dbAdmins.map((a) => `${a.platform}:${a.userId}`);
							ctx.ui.notify(
								"Admin users:\n" +
									([...dbLines, ...configLines].length > 0
										? [...dbLines, ...configLines].join("\n")
										: "None"),
								"info",
							);
							return;
						}

						case "add": {
							const plat = isAdminPlatform(parts[2]) ? parts[2] : undefined;
							const uid = parts[3];
							if (!plat || !uid) {
								ctx.ui.notify(
									"Usage: /gateway admin add <platform|*> <userId>\n" +
										"Use * for platform to make admin on all platforms.\n" +
										"Admins bypass all tool restrictions and have full access.",
									"info",
								);
								return;
							}
							addAdmin(plat, uid);
							ctx.ui.notify(
								`✅ ${uid} is now admin on ${plat === "*" ? "all platforms" : plat}`,
								"info",
							);
							return;
						}

						case "remove": {
							const plat = isAdminPlatform(parts[2]) ? parts[2] : undefined;
							const uid = parts[3];
							if (!plat || !uid) {
								ctx.ui.notify(
									"Usage: /gateway admin remove <platform|*> <userId>",
									"info",
								);
								return;
							}
							if (removeAdmin(plat, uid)) {
								ctx.ui.notify(`Removed admin: ${plat}:${uid}`, "info");
							} else {
								ctx.ui.notify(`${uid} was not an admin on ${plat}`, "error");
							}
							return;
						}

						default: {
							ctx.ui.notify(
								"/gateway admin commands:\n\n" +
									"  list                  - Show all admins (DB + config)\n" +
									"  add <platform|*> <uid>  - Grant admin privileges\n" +
									"  remove <platform|*> <uid> - Revoke admin privileges\n\n" +
									"Admins bypass all tool restrictions and have full access.\n" +
									"Use * as platform to grant admin on all platforms.\n" +
									"Config-file admins: set adminUids in gateway-security.json",
								"info",
							);
						}
					}
					return;
				}

				case "sessions": {
					const sessions = listSessions();
					ctx.ui.notify(
						"Active sessions:\n" +
							sessions
								.slice(0, 10)
								.map((s) => `${s.platform}:${s.channelId} (${s.id.slice(0, 8)}...)`)
								.join("\n"),
						"info",
					);
					return;
				}

				case "tasks": {
					const tasks = listTasks();
					ctx.ui.notify(
						"Background tasks:\n" +
							tasks
								.slice(0, 10)
								.map(
									(t) => `${t.id.slice(0, 12)}... - ${t.status} (${t.progress}%)`,
								)
								.join("\n"),
						"info",
					);
					return;
				}

				case "config": {
					const configUidCount2 = Object.values(
						runtime.config.security.allowedUids ?? {},
					).reduce((sum, uids) => sum + uids.length, 0);
					ctx.ui.notify(
						`Gateway Config:\n\n` +
							`Port: ${runtime.config.port}\n` +
							`Sessions: ${runtime.config.sessions.resetPolicy}\n` +
							`Security: ${runtime.config.security.allowAll ? "Allow all" : "Allowlist"}` +
							` (${configUidCount2} config UIDs)\n` +
							`Discord: ${runtime.config.platforms.discord?.enabled ? "Enabled" : "Disabled"}`,
						"info",
					);
					return;
				}

				case "tool-policy": {
					const action = parts[1]?.toLowerCase();

					switch (action) {
						case "list": {
							const platform = parts[2];
							const userId = parts[3];
							const policies = listToolPolicies(platform, userId);
							if (policies.length === 0) {
								ctx.ui.notify(
									"No explicit tool policies — only defaults active.\n" +
										"Use /gateway tool-policy defaults to see them.",
									"info",
								);
								return;
							}
							ctx.ui.notify(
								"Tool policies:\n" +
									policies
										.map(
											(p) =>
												`#${p.id} ${p.platform ?? "*"}:${p.userId ?? "*"} → ${p.toolName} [${p.action}]`,
										)
										.join("\n"),
								"info",
							);
							return;
						}

						case "defaults": {
							const summary = getEffectivePolicySummary("*", "*");
							ctx.ui.notify(
								"Default Tool Policy (all external users):\n\n" +
									`✅ ALLOWED:\n  ${summary.allowed.join("\n  ")}\n\n` +
									`🚫 DENIED:\n  ${summary.denied.join("\n  ")}\n\n` +
									"Use /gateway tool-policy set to override.",
								"info",
							);
							return;
						}

						case "set": {
							const plat = parts[2] || null;
							const uid = parts[3] || null;
							const tool = parts[4];
							const act = parts[5]?.toLowerCase();

							if (!tool || (act !== "allow" && act !== "deny")) {
								ctx.ui.notify(
									"Usage: /gateway tool-policy set [platform] [userId] <toolName> allow|deny\n\n" +
										"Examples:\n" +
										"  /gateway tool-policy set discord * bash deny\n" +
										"  /gateway tool-policy set discord U123 bash allow\n" +
										"  /gateway tool-policy set * * write allow\n" +
										"  (Use * for platform/userId to mean all)",
									"info",
								);
								return;
							}

							setToolPolicy({
								platform: plat === "*" ? null : plat,
								userId: uid === "*" ? null : uid,
								toolName: tool,
								action: act as "allow" | "deny",
								priority: 50, // Explicit policies override default (priority 0)
							});

							ctx.ui.notify(
								`Policy set: ${plat ?? "*"}:${uid ?? "*"} → ${tool} [${act}]`,
								"info",
							);
							return;
						}

						case "remove": {
							const id = parseInt(parts[2]);
							if (isNaN(id)) {
								ctx.ui.notify(
									"Usage: /gateway tool-policy remove <id>\n" +
										"Use /gateway tool-policy list to see IDs.",
									"info",
								);
								return;
							}
							if (removeToolPolicy(id)) {
								ctx.ui.notify(`Removed tool policy #${id}`, "info");
							} else {
								ctx.ui.notify(`Policy #${id} not found`, "error");
							}
							return;
						}

						case "reset": {
							resetToolPolicies();
							ctx.ui.notify("All tool policies reset to defaults.", "info");
							return;
						}

						default: {
							ctx.ui.notify(
								"/gateway tool-policy commands:\n\n" +
									"  list [platform] [userId]  - List explicit policies\n" +
									"  defaults                   - Show default policy\n" +
									"  set <p> <u> <tool> allow|deny - Add/update policy\n" +
									"  remove <id>                - Delete a policy\n" +
									"  reset                      - Clear all, back to defaults\n\n" +
									"Use * for platform/userId to match all.\n" +
									"Tool names support globs: bash, gateway_*, wiki_*",
								"info",
							);
						}
					}
					return;
				}

				default: {
					ctx.ui.notify(
						"pi Gateway Commands:\n\n" +
							"  /gateway start [port]  - Start gateway\n" +
							"  /gateway stop         - Stop gateway\n" +
							"  /gateway restart      - Restart gateway\n" +
							"  /gateway status       - Show status\n" +
							"  /gateway pair <code>  - Approve pairing\n" +
							"  /gateway allow <p> <u>- Add user to allowlist\n" +
							"  /gateway revoke <p> <u>- Remove user from allowlist\n" +
							"  /gateway admin list   - List admin users\n" +
							"  /gateway admin add <p|*> <u> - Grant admin\n" +
							"  /gateway admin remove <p|*> <u> - Revoke admin\n" +
							"  /gateway sessions     - List sessions\n" +
							"  /gateway tasks        - List background tasks\n" +
							"  /gateway config       - Show config\n" +
							"  /gateway tool-policy  - Manage tool policies\n\n" +
							"Hermes-style features:\n" +
							"  - Per-chat sessions with reset policies\n" +
							"  - Platform adapters (Discord, etc.)\n" +
							"  - Background task support\n" +
							"  - Allowlist security (DB + config UIDs)\n" +
							"  - Tool policy (per-user tool allow/deny)",
						"info",
					);
				}
			}
		},
	});
}

export { registerGatewayCommand };
