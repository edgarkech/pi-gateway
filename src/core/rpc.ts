import { join } from "node:path";
import { spawn, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";

import { logger } from "../logger.js";
import { getPackageRoot } from "../paths.js";
import { runtime, type RpcProcess } from "../state.js";
import type { ImageContent } from "../media/types.js";
import type { RpcConfig } from "../types.js";
import { setAgentBusy, rejectAllQueueTasks } from "./prompt-queue.js";
import {
	setStdinWriter,
	setActiveChannel,
	getActiveChannel,
	flushHandler,
	handleExtensionUiRequest,
	cleanupPendingUiRequests,
} from "../interactive.js";

// Pending RPC requests
interface PendingRequest {
	id: string;
	resolve: (msg: unknown) => void;
	reject: (err: Error) => void;
}
const pendingRequests: PendingRequest[] = [];

// Pending prompt completions — resolve when agent_end arrives with response text.
// Option B (Lightweight Multiplexing): keyed by sessionId instead of FIFO position,
// so that completions for different channels can be matched to the correct agent_end /
// text_delta event even when the pi process delivers them out of order.
interface PendingCompletion {
	/** Gateway session id (from sessions/store.ts) — used as the Map key. */
	sessionId: string;
	resolve: (text: string) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	/** Called with accumulated streaming text as deltas arrive */
	onStream?: (text: string) => void;
	/** Accumulated streamed text from text_delta events */
	streamedText: string;
}

/** sessionId → PendingCompletion. Replaces the old FIFO pendingCompletions[]. */
const pendingCompletions = new Map<string, PendingCompletion>();

/**
 * The session that most recently pushed a completion. Used as a backward‑compatible
 * fallback when an event does not carry a sessionId (or carries an unknown one),
 * so existing single‑stream callers keep working unchanged.
 */
let lastActiveSessionId: string | null = null;

/**
 * Look up a completion by sessionId, falling back to the most recently added
 * (currently active) completion when no/unknown sessionId is given.
 * Used for streaming (does NOT remove the entry from the Map).
 */
function findCompletion(sessionId?: string): PendingCompletion | undefined {
	if (sessionId) {
		const c = pendingCompletions.get(sessionId);
		if (c) return c;
	}
	// Fallback: most recently added session, else the last key in insertion order.
	const id =
		lastActiveSessionId ??
		(pendingCompletions.size > 0 ? Array.from(pendingCompletions.keys()).pop() : undefined);
	if (id) return pendingCompletions.get(id);
	return undefined;
}

/**
 * Resolve (and remove) the completion for an event. Falls back to the most recently
 * added completion when the event carries no/unknown sessionId, preserving the old
 * FIFO-ish behaviour for single‑stream callers (backward compatibility).
 */
function resolveCompletionForEvent(sessionId?: string): PendingCompletion | undefined {
	const completion = findCompletion(sessionId);
	if (completion) {
		pendingCompletions.delete(completion.sessionId);
		if (lastActiveSessionId === completion.sessionId) lastActiveSessionId = null;
	}
	return completion;
}

// RPC to pi agent

/**
 * rpc-persona (docs/rpc-persona.md §4): compose the pi spawn args and options
 * from the optional rpc config block. Empty fields keep today's behavior
 * (no --model/--system-prompt flag, no cwd option) — backward compatible.
 * Exported for unit testing (docs/rpc-persona.md §5.1).
 */
export function buildRpcSpawnArgs(
	extensionPath: string,
	rpcConfig?: RpcConfig,
): { args: string[]; spawnOptions: SpawnOptions } {
	const args = ["--mode", "rpc", "--extension", extensionPath];
	if (rpcConfig?.model) args.push("--model", rpcConfig.model);
	if (rpcConfig?.systemPrompt) args.push("--system-prompt", rpcConfig.systemPrompt);
	const spawnOptions: SpawnOptions = {
		stdio: ["pipe", "pipe", "pipe"],
		env: {
			...process.env,
			OLLAMA_HOST: process.env.OLLAMA_HOST || "localhost:11434",
		},
	};
	if (rpcConfig?.cwd) spawnOptions.cwd = rpcConfig.cwd;
	return { args, spawnOptions };
}

function startRpc(): RpcProcess {
	const extensionPath = join(
		getPackageRoot(import.meta.url),
		"dist",
		"extensions",
		"pi-gateway-ask-user-rpc.js",
	);
	// rpc-persona (docs/rpc-persona.md): model/system-prompt flags and the cwd
	// spawn option come from the optional rpc config block; empty fields keep
	// today's behavior (backward compatible).
	const { args, spawnOptions } = buildRpcSpawnArgs(extensionPath, runtime.config.rpc);
	// stdio is fully piped => typed as ChildProcessByStdio via the cast below,
	// which guarantees writable stdin and readable stdout/stderr (no nulls).
	const proc = spawn("pi", args, spawnOptions) as RpcProcess;

	// Give the interactive bridge a way to write to pi's stdin
	setStdinWriter((line: string) => {
		if (proc.stdin?.writable) {
			proc.stdin.write(line);
		}
	});

	let lineBuffer = "";
	proc.stdout?.on("data", (data: Buffer) => {
		lineBuffer += data.toString();
		const lines = lineBuffer.split("\n");
		// Keep the last (possibly incomplete) chunk in the buffer
		lineBuffer = lines.pop() || "";

		for (const line of lines) {
			if (!line) continue;
			try {
				const msg = JSON.parse(line);

				if (msg.id) {
					const idx = pendingRequests.findIndex((r) => r.id === msg.id);
					if (idx !== -1) {
						const req = pendingRequests.splice(idx, 1)[0];
						req.resolve(msg);
					}
				}

				// agent_end carries the full response — resolve the matching completion.
				// Match by sessionId when available; fall back to the most recently
				// added completion for backward compatibility.
				if (msg.type === "agent_end") {
					const text = extractAgentEndText(msg);
					logger.info(
						`[gateway] agent_end received, text length: ${text.length}${
							msg.sessionId ? `, session: ${msg.sessionId}` : ""
						}`,
					);
					const completion = resolveCompletionForEvent(
						msg.sessionId as string | undefined,
					);
					if (completion) {
						clearTimeout(completion.timer);
						completion.resolve(text);
					}
					// Clean up any pending interactive prompts
					cleanupPendingUiRequests();
					setActiveChannel(null);
				}

				// Handle extension UI requests (select, confirm, input, etc.)
				if (msg.type === "extension_ui_request") {
					const active = getActiveChannel();
					if (active) {
						const adapter = runtime.state.adapters.get(active.platform);
						if (adapter) {
							// Flush full accumulated text into the placeholder NOW
							flushHandler?.();
							handleExtensionUiRequest(msg, adapter).catch((err) => {
								logger.error(
									"[gateway] Failed to handle extension UI request:",
									err,
								);
							});
						}
					}
				}

				// Session-per-Room (docs/session-per-room.md §5): busy tracking
				// over the native agent events — the queue drains on agent_settled.
				if (msg.type === "agent_start") {
					setAgentBusy(true);
				}
				if (msg.type === "agent_settled") {
					setAgentBusy(false);
				}

				// Stream text deltas to the matching completion. Match by sessionId
				// when available; fall back to the most recently added completion.
				if (
					msg.type === "message_update" &&
					msg.assistantMessageEvent?.type === "text_delta" &&
					typeof msg.assistantMessageEvent.delta === "string"
				) {
					const completion = findCompletion(msg.sessionId as string | undefined);
					if (completion?.onStream) {
						completion.streamedText += msg.assistantMessageEvent.delta;
						completion.onStream(completion.streamedText);
					}
				}

				// Broadcast events
				if (msg.type === "response") {
					runtime.hooks.broadcast?.("response", msg);
				} else {
					runtime.hooks.broadcast?.("event", msg);
				}
			} catch {
				logger.debug("[gateway] Failed to parse RPC line:", line.slice(0, 200));
			}
		}
	});

	proc.stderr?.on("data", (data: Buffer) => {
		logger.info("[gateway] pi stderr:", data.toString().trim());
	});

	proc.on("exit", (code: number) => {
		logger.info("[gateway] pi process exited");
		// Flush any remaining line in the buffer (could be a large agent_end)
		if (lineBuffer.trim()) {
			try {
				const msg = JSON.parse(lineBuffer.trim());
				if (msg.type === "agent_end") {
					const text = extractAgentEndText(msg);
					logger.info(
						`[gateway] agent_end flushed from buffer on exit, text length: ${text.length}`,
					);
					const completion = resolveCompletionForEvent(
						msg.sessionId as string | undefined,
					);
					if (completion) {
						clearTimeout(completion.timer);
						completion.resolve(text);
					}
				}
			} catch {
				logger.debug("[gateway] Unparseable data in stdout buffer on exit");
			}
		}
		// Reject any remaining pending completions so they don't hang forever
		for (const completion of pendingCompletions.values()) {
			clearTimeout(completion.timer);
			completion.reject(new Error(`pi process exited with code ${code}`));
		}
		pendingCompletions.clear();
		lastActiveSessionId = null;
		// Session-per-Room: queued (not yet started) tasks have no agent left.
		rejectAllQueueTasks("pi process exited");
		// Clean up any pending interactive UI requests
		cleanupPendingUiRequests();
		setActiveChannel(null);
		runtime.rpcProcess = null;
		runtime.hooks.broadcast?.("agent_disconnected", { code });
	});

	return proc;
}

async function sendRpc(command: string, data: Record<string, unknown> = {}): Promise<unknown> {
	// Capture the process in a local const so TypeScript can narrow the
	// null check below (runtime.rpcProcess is a mutable field on the shared
	// `runtime` object, so narrowing across the property access would not hold).
	const proc = runtime.rpcProcess;
	if (!proc) throw new Error("pi agent not running");

	const id = randomBytes(8).toString("hex");
	const payload = { id, type: command, ...data };

	return new Promise((resolve, reject) => {
		pendingRequests.push({ id, resolve, reject });

		try {
			proc.stdin.write(JSON.stringify(payload) + "\n");
		} catch (err) {
			const idx = pendingRequests.findIndex((r) => r.id === id);
			if (idx !== -1) pendingRequests.splice(idx, 1);
			reject(err);
		}

		setTimeout(() => {
			const idx = pendingRequests.findIndex((r) => r.id === id);
			if (idx !== -1) {
				pendingRequests.splice(idx, 1);
				reject(new Error("Request timeout"));
			}
		}, 30000);
	});
}

// Extract assistant response text from agent_end.messages
function extractAgentEndText(agentEndMsg: Record<string, unknown>): string {
	const messages = agentEndMsg.messages as Array<Record<string, unknown>> | undefined;
	if (!messages) return "";

	const parts: string[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			const content = msg.content;
			if (Array.isArray(content)) {
				for (const block of content as Array<Record<string, unknown>>) {
					if (block.type === "text" && typeof block.text === "string") {
						parts.push(block.text as string);
					}
				}
			}
		}
	}
	return parts.join("\n");
}

// Send a prompt to pi and wait for agent_end to get the full response text.
// Unlike sendRpc (which resolves with the ACK), this resolves with the
// actual assistant response text after the agent finishes processing.
// If onStream is provided, it is called with accumulated text as deltas arrive.
// The completion is stored in a Map keyed by sessionId, enabling multiplexing
// of multiple channels within the single RPC process (Option B).
//
// Phase 3 (File-Attachments, concept §7.2): an optional `images` payload is
// forwarded into the pi-RPC `prompt.images` field natively. Overloads keep
// the pre-Phase-3 callers working: passing a stream callback as the 3rd
// argument (the historical form) is still honoured.
export function sendPromptRpc(
	message: string,
	sessionId: string,
	onStream?: (text: string) => void,
): Promise<string>;
export function sendPromptRpc(
	message: string,
	sessionId: string,
	images: ImageContent[] | undefined,
	onStream?: (text: string) => void,
): Promise<string>;
export async function sendPromptRpc(
	message: string,
	sessionId: string,
	images?: ImageContent[] | ((text: string) => void),
	onStream?: (text: string) => void,
): Promise<string> {
	if (!runtime.rpcProcess) throw new Error("pi agent not running");

	// Disambiguate the legacy 3rd-argument stream callback from the new images
	// array so existing callers keep working unchanged (backward compatibility).
	const stream: ((text: string) => void) | undefined =
		typeof images === "function" ? images : onStream;
	const imageList: ImageContent[] | undefined =
		typeof images === "function" || images === undefined ? undefined : images;

	// Send the prompt and wait for the ACK (so we know the prompt was accepted).
	// The `images` field is only set when non-empty (no protocol noise otherwise).
	const ackResponse = await sendRpc("prompt", {
		message,
		sessionId,
		...(imageList && imageList.length > 0 ? { images: imageList } : {}),
	});
	const ack = ackResponse as Record<string, unknown>;
	if (!ack.success) {
		throw new Error(`Prompt rejected: ${JSON.stringify(ackResponse)}`);
	}

	logger.info("[gateway] Prompt ACK received, waiting for agent_end...");

	// Wait for agent_end to deliver the full response
	const timeoutMs = runtime.config.promptTimeoutMs ?? 300000;
	const minutes = Math.round(timeoutMs / 60000);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			// Only reject if this completion is still pending (and this exact timer).
			const completion = pendingCompletions.get(sessionId);
			if (completion && completion.timer === timer) {
				pendingCompletions.delete(sessionId);
				if (lastActiveSessionId === sessionId) lastActiveSessionId = null;
				reject(
					new Error(
						`Prompt completion timeout — no agent_end received within ${minutes} minute${minutes === 1 ? "" : "s"}`,
					),
				);
			}
		}, timeoutMs);

		pendingCompletions.set(sessionId, {
			sessionId,
			resolve,
			reject,
			timer,
			onStream: stream,
			streamedText: "",
		});
		lastActiveSessionId = sessionId;
	});
}

// ── Session-per-Room primitives (docs/session-per-room.md §3/§5) ───────────
// Native pi-RPC building blocks, no pi-code changes. Exported for the
// message-pipeline orchestration and unit testing.

/** pi state snapshot (subset relevant for per-room session management). */
export interface PiSessionState {
	sessionFile: string | null;
	sessionId: string | null;
	sessionName: string | null;
}

/** Capture the current pi session state of the RPC child (native get_state). */
export async function getPiState(): Promise<PiSessionState> {
	const res = (await sendRpc("get_state")) as {
		success: boolean;
		data?: {
			sessionFile?: string | null;
			sessionId?: string | null;
			sessionName?: string | null;
		};
	};
	if (!res.success) {
		throw new Error(`get_state failed: ${JSON.stringify(res)}`);
	}
	return {
		sessionFile: res.data?.sessionFile ?? null,
		sessionId: res.data?.sessionId ?? null,
		sessionName: res.data?.sessionName ?? null,
	};
}

/**
 * Create a new pi session (native new_session — fires session_shutdown with
 * reason "new" for the previous session) and label it via set_session_name
 * (session_info entry in the JSONL, machine-readable for pi-brain).
 * Returns the new session file as reported by get_state.
 */
export async function newPiSession(name?: string): Promise<PiSessionState> {
	const res = (await sendRpc("new_session")) as {
		success: boolean;
		data?: { cancelled?: boolean };
	};
	if (!res.success) {
		throw new Error(`new_session failed: ${JSON.stringify(res)}`);
	}
	if (name) {
		const nameRes = (await sendRpc("set_session_name", { name })) as {
			success: boolean;
		};
		if (!nameRes.success) {
			throw new Error(`set_session_name failed: ${JSON.stringify(nameRes)}`);
		}
	}
	return getPiState();
}

/**
 * Switch the pi RPC child to an existing session file (native switch_session
 * — fires session_shutdown with reason "resume" for the current session).
 * Returns the pi-reported result (contains `cancelled` when an extension
 * blocked the switch — no such handlers are registered today).
 */
export async function switchPiSession(sessionPath: string): Promise<{ cancelled?: boolean }> {
	const res = (await sendRpc("switch_session", { sessionPath })) as {
		success: boolean;
		data?: { cancelled?: boolean };
	};
	if (!res.success) {
		throw new Error(`switch_session failed: ${JSON.stringify(res)}`);
	}
	return res.data ?? {};
}

/** Stops the pi RPC process (kill + clear). */
export function stopRpc(): void {
	if (runtime.rpcProcess) {
		runtime.rpcProcess.kill();
		runtime.rpcProcess = null;
	}
}

/** Restarts the pi RPC process: kill, reject pending completions, respawn. */
export function restartRpc(): void {
	if (runtime.rpcProcess) {
		runtime.rpcProcess.kill();
		runtime.rpcProcess = null;
	}
	// Reject any pending completions
	for (const c of pendingCompletions.values()) {
		clearTimeout(c.timer);
		c.reject(new Error("Agent restarted by admin"));
	}
	pendingCompletions.clear();
	lastActiveSessionId = null;
	// Session-per-Room: queued (not yet started) tasks have no agent left.
	rejectAllQueueTasks("Agent restarted by admin");
	runtime.rpcProcess = startRpc();
}

/** Whether the pi RPC process is currently running. */
export function isAgentRunning(): boolean {
	return runtime.rpcProcess !== null;
}

/** Returns the accumulated streamedText of the completion for the given session
 *  (or, if no sessionId is provided, the most recently added / active completion),
 *  or null if none is pending. Replaces external reads of pendingCompletions[0]. */
export function peekActiveCompletion(sessionId?: string): { streamedText: string } | null {
	const c = findCompletion(sessionId);
	return c ? { streamedText: c.streamedText } : null;
}

/** Resets the accumulated streamedText of the completion for the given session
 *  (or, if no sessionId is provided, the most recently added / active completion)
 *  to "". */
export function resetActiveStream(sessionId?: string): void {
	const c = findCompletion(sessionId);
	if (c) c.streamedText = "";
}

export { startRpc, sendRpc };

export type { ImageContent };
