/**
 * Global FIFO prompt queue — Session-per-Room (docs/session-per-room.md §5).
 *
 * With `sessions.perRoom` enabled, prompts from all rooms funnel through the
 * ONE pi RPC process (no per-room processes). While the agent is busy,
 * incoming prompts are queued instead of being rejected by pi ("Agent is
 * already processing. Specify streamingBehavior"). At `agent_settled` the
 * next queued entry is processed (switch/new session → prompt).
 *
 * Busy tracking: the RPC layer reports agent_start (busy) and agent_settled
 * (idle) via `setAgentBusy()`. Entries carry a timeout of `promptTimeoutMs`
 * — an entry that sits in the queue longer expires with a timeout error so
 * callers (and their users) never hang forever.
 */

import { logger } from "../logger.js";

interface QueueEntry {
	run: () => Promise<unknown>;
	label: string;
	timer: ReturnType<typeof setTimeout>;
}

/** Serialize queue access — Node.js is single-threaded, but drain() is
 *  async; a simple `draining` flag guards against concurrent drains. */
let draining = false;
let busy = false;
const queue: QueueEntry[] = [];

/** Whether the pi agent is currently busy (between agent_start and agent_settled). */
export function isAgentBusy(): boolean {
	return busy;
}

/** Called by the RPC layer on agent_start (true) / agent_settled (false). */
export function setAgentBusy(value: boolean): void {
	busy = value;
	if (!value) {
		// Agent settled → try to process the next queued entry.
		drain();
	}
}

/**
 * Enqueue a prompt task (FIFO). Returns a promise that resolves with the
 * task's result once it has been executed (after switching to the room's
 * pi session), or rejects with a timeout error if the entry waited longer
 * than `timeoutMs` (default: the gateway's promptTimeoutMs).
 *
 * When the agent is idle, the task starts immediately (synchronous drain).
 * The settlement is registered BEFORE the first drain() so a synchronous
 * failure inside run() still settles the outer promise.
 */
export function enqueuePromptTask<T>(
	label: string,
	run: () => Promise<T>,
	timeoutMs: number,
): Promise<T> {
	const entry: QueueEntry = {
		run,
		label,
		timer: setTimeout(() => {
			const idx = queue.indexOf(entry);
			if (idx !== -1) {
				// Still queued (not started) → expire the entry.
				queue.splice(idx, 1);
				logger.warn(
					`[prompt-queue] Entry expired after ${Math.round(timeoutMs / 1000)}s: ${label}`,
				);
				const expired = settlements.get(entry);
				settlements.delete(entry);
				expired?.reject(
					new Error(
						`Queue timeout — entry waited longer than ${Math.round(timeoutMs / 1000)}s: ${label}`,
					),
				);
			}
		}, timeoutMs),
	};
	return new Promise<T>((resolve, reject) => {
		settlements.set(entry, { resolve: resolve as () => void, reject });
		queue.push(entry);
		drain();
	});
}

/** Outer-promise settlement per queue entry. Registered by enqueuePromptTask
 *  before the first drain(); consumed by drain()/rejectAllQueueTasks. */
const settlements = new Map<
	QueueEntry,
	{ resolve: (value: unknown) => void; reject: (err: Error) => void }
>();

/** Process the next queued entry when the agent is idle. */
function drain(): void {
	if (draining || busy) return;
	const entry = queue.shift();
	if (!entry) return;
	draining = true;
	clearTimeout(entry.timer);
	const settlement = settlements.get(entry);
	void (async () => {
		try {
			const result = await entry.run();
			settlement?.resolve(result);
		} catch (err) {
			logger.error(`[prompt-queue] Task failed: ${entry.label}`, err);
			settlement?.reject(err instanceof Error ? err : new Error(String(err)));
		} finally {
			settlements.delete(entry);
			draining = false;
			// If the agent went idle again while this task ran (it should end
			// with agent_settled, which also triggers drain), keep draining.
			if (!busy) drain();
		}
	})();
}

/** Reject and clear all queued entries (called when the pi process exits or
 *  is restarted — their sessions/agent are gone). Never throws. */
export function rejectAllQueueTasks(reason: string): void {
	const entries = queue.splice(0, queue.length);
	for (const entry of entries) {
		clearTimeout(entry.timer);
		const settlement = settlements.get(entry);
		settlement?.reject(new Error(`${reason}: ${entry.label}`));
		settlements.delete(entry);
	}
}

/** Number of currently queued (waiting) entries — for tests and status. */
export function queuedTaskCount(): number {
	return queue.length;
}

/** Test-only helper: reset module state between tests. */
export function resetPromptQueue(): void {
	queue.splice(0, queue.length);
	settlements.clear();
	draining = false;
	busy = false;
}
