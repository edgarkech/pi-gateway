/**
 * Unit tests for `src/core/prompt-queue.ts` — the global FIFO prompt queue of
 * Session-per-Room (docs/session-per-room.md §5).
 *
 * Covers: FIFO ordering, immediate start when idle, agent_settled-triggered
 * drain (busy → settled), per-entry timeout, rejectAll (pi process exit), and
 * sequential serialization (no overlapping tasks).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	enqueuePromptTask,
	isAgentBusy,
	queuedTaskCount,
	rejectAllQueueTasks,
	resetPromptQueue,
	setAgentBusy,
} from "../../src/core/prompt-queue.js";

beforeEach(() => resetPromptQueue());
afterEach(() => {
	resetPromptQueue();
	vi.useRealTimers();
});

describe("prompt queue — immediate start when idle", () => {
	it("runs a task immediately when the agent is idle", async () => {
		expect(isAgentBusy()).toBe(false);
		let ran = false;
		const result = await enqueuePromptTask(
			"test",
			async () => {
				ran = true;
				return "ok";
			},
			1000,
		);
		expect(ran).toBe(true);
		expect(result).toBe("ok");
	});

	it("keeps the queue empty after a completed task", async () => {
		await enqueuePromptTask("test", async () => {}, 1000);
		// Let the finally-clause settle.
		await new Promise((r) => setTimeout(r, 0));
		expect(queuedTaskCount()).toBe(0);
	});
});

describe("prompt queue — FIFO + settled trigger", () => {
	it("queues tasks while busy and drains them FIFO on settled", async () => {
		const order: string[] = [];
		let releaseFirst!: () => void;
		const first = enqueuePromptTask(
			"first",
			async () => {
				order.push("first-start");
				await new Promise<void>((r) => {
					releaseFirst = r;
				});
				order.push("first-end");
			},
			5000,
		);

		// Give the first task time to start, then mark the agent busy.
		await new Promise((r) => setTimeout(r, 10));
		setAgentBusy(true);

		const second = enqueuePromptTask(
			"second",
			async () => {
				order.push("second");
			},
			5000,
		);
		const third = enqueuePromptTask(
			"third",
			async () => {
				order.push("third");
			},
			5000,
		);

		expect(queuedTaskCount()).toBe(2);
		expect(order).toEqual(["first-start"]);

		// First task ends — but the agent is still busy → no drain yet.
		releaseFirst();
		await first;
		await new Promise((r) => setTimeout(r, 10));
		expect(order).toEqual(["first-start", "first-end"]);
		expect(queuedTaskCount()).toBe(2);

		// agent_settled → next FIFO entry runs; the drain continues serially
		// (finally-clause) while the agent stays idle.
		setAgentBusy(false);
		await second;
		await third;
		expect(order).toEqual(["first-start", "first-end", "second", "third"]);
	});

	it("serializes tasks — no overlapping runs", async () => {
		let concurrent = 0;
		let maxConcurrent = 0;
		const tasks: Array<Promise<number>> = [];
		setAgentBusy(true);
		for (let i = 0; i < 3; i++) {
			tasks.push(
				enqueuePromptTask(
					`task-${i}`,
					async () => {
						concurrent++;
						maxConcurrent = Math.max(maxConcurrent, concurrent);
						await new Promise((r) => setTimeout(r, 20));
						concurrent--;
						return i;
					},
					5000,
				),
			);
		}
		setAgentBusy(false);
		const results = await Promise.all(tasks);
		expect(results).toEqual([0, 1, 2]);
		expect(maxConcurrent).toBe(1);
	});
});

describe("prompt queue — per-entry timeout", () => {
	it("expires a queued entry after timeoutMs and rejects it", async () => {
		vi.useFakeTimers();
		let release!: () => void;
		const blocked = new Promise<void>((r) => {
			release = r;
		});
		const running = enqueuePromptTask("running", () => blocked, 60000);
		setAgentBusy(true);

		const queued = enqueuePromptTask(
			"queued",
			async () => {
				throw new Error("must not run");
			},
			1000,
		);

		// Attach the rejection handler BEFORE advancing fake timers — the
		// rejection fires during advanceTimersByTimeAsync.
		const queuedRejection = expect(queued).rejects.toThrow(/Queue timeout/);

		// Advance past the queued entry's timeout.
		await vi.advanceTimersByTimeAsync(1500);
		await queuedRejection;

		// The running task is unaffected (already started).
		release();
		await expect(running).resolves.toBeUndefined();
	});

	it("expires multiple waiting entries FIFO-independently", async () => {
		vi.useFakeTimers();
		let release!: () => void;
		const blocked = new Promise<void>((r) => {
			release = r;
		});
		const running = enqueuePromptTask("running", () => blocked, 60000);
		setAgentBusy(true);

		const short = enqueuePromptTask("short", async () => {}, 500);
		const long = enqueuePromptTask("long", async () => {}, 5000);

		const shortRejection = expect(short).rejects.toThrow(/Queue timeout/);
		await vi.advanceTimersByTimeAsync(600);
		await shortRejection;
		expect(queuedTaskCount()).toBe(1);

		release();
		await expect(running).resolves.toBeUndefined();
		// long is still queued and runs after the settled trigger.
		const drained = long.then(() => "drained");
		setAgentBusy(false);
		await expect(drained).resolves.toBe("drained");
	});
});

describe("prompt queue — rejectAll (pi process exit)", () => {
	it("rejects all waiting entries with the given reason", async () => {
		let release!: () => void;
		const blocked = new Promise<void>((r) => {
			release = r;
		});
		const running = enqueuePromptTask("running", () => blocked, 60000);
		setAgentBusy(true);

		const waiting = enqueuePromptTask("waiting", async () => {}, 60000);
		rejectAllQueueTasks("pi process exited");
		await expect(waiting).rejects.toThrow(/pi process exited: waiting/);
		expect(queuedTaskCount()).toBe(0);

		// The running task is NOT rejected by rejectAll.
		release();
		await expect(running).resolves.toBeUndefined();
	});

	it("rejects with the task error when the run fails", async () => {
		await expect(
			enqueuePromptTask(
				"failing",
				async () => {
					throw new Error("boom");
				},
				5000,
			),
		).rejects.toThrow("boom");
	});
});
