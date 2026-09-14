/**
 * Vitest global setup — runs BEFORE each test file's module imports are evaluated.
 *
 * Test Isolation strategy:
 * Vitest runs each test FILE in its own worker process (isolate: true), so any
 * module-level singletons already get a fresh per-file environment. On top of
 * that, this setup files:
 *   - points the DB-bearing modules at a per-file scratch directory (via the
 *     `GATEWAY_DB_DIR` env var), and
 *   - redirects HOME so the security config file (~/.pi/gateway/config.json) is
 *     also isolated.
 *
 * This guarantees tests never touch the real `~/.pi/gateway` data and cannot
 * interfere with one another. The module-level code relies on **top-level await**
 * so the environment is fully configured before the importing test file loads.
 */

import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

let scratchDir = "";
let originalHome: string | undefined;

// ── Phase 1: set up per-file scratch environment (before test imports) ──
scratchDir = await mkdtemp(join(tmpdir(), "pi-gateway-test-"));
process.env.GATEWAY_DB_DIR = scratchDir;
await mkdir(join(scratchDir, ".pi", "gateway"), { recursive: true });
originalHome = process.env.HOME;
process.env.HOME = scratchDir;

// ── Phase 2: tear down the scratch environment after the file finishes ──
afterAll(async () => {
	delete process.env.GATEWAY_DB_DIR;
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (scratchDir) {
		await rm(scratchDir, { recursive: true, force: true });
	}
});
