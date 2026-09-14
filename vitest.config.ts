import { defineConfig } from "vitest/config";

/**
 * Vitest configuration for pi-gateway.
 *
 * Test Isolation:
 * - Each test file runs in its own worker process (isolate: true), giving
 *   module-level singletons (e.g. `src/security/auth.ts` / `src/sessions/store.ts`)
 *   a fresh per-file environment out of the box.
 * - Within a file, the singleton DB modules expose `reset*Store()` helpers so
 *   each `describe` block can re-point the DB to its own temporary directory.
 * - Native `better-sqlite3` is a dependency, not mocked; tests use the real driver
 *   against isolated temp databases.
 */
export default defineConfig({
	test: {
		globals: true,
		// One worker process per test file => per-file singleton isolation.
		isolate: true,
		include: ["tests/**/*.test.ts"],
		environment: "node",
		setupFiles: ["./tests/setup.ts"],
		// Keep fallback: serial execution to keep shared singletons predictable.
		fileParallelism: true,
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.d.ts", "src/cli.ts", "src/index.ts"],
			reporter: ["text", "html", "json-summary"],
			reportsDirectory: "coverage",
		},
	},
});
