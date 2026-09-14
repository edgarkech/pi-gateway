/**
 * Shared test helpers for deterministic DB isolation.
 *
 * Each test that touches `better-sqlite3` should call `fresh{Security,Session}Store()`
 * in its `beforeEach`. The helpers close the module singleton and re-point it at
 * a BRAND-NEW temporary database file (not merely a reopened one), guaranteeing
 * that no rows leak between tests within the same worker.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSecurityStore, resetSecurityStore } from "../src/security/auth.js";
import { initSessionStore, resetSessionStore } from "../src/sessions/store.js";
import { resetToolPolicyCache } from "../src/security/tool-policy.js";

let securityTmpDirs = 0;
let sessionTmpDirs = 0;

/** Reset + re-init the security singleton against a fresh temp db. */
export function freshSecurityStore(): void {
	resetSecurityStore();
	// The tool-policy module caches its table-creation flag; forget it so it
	// re-created the tool_policies table on the new database.
	resetToolPolicyCache();
	securityTmpDirs += 1;
	initSecurityStore(mkdtempSync(join(tmpdir(), `pi-sec-${securityTmpDirs}-`)));
}

/** Reset + re-init the session singleton against a fresh temp db. */
export function freshSessionStore(): void {
	resetSessionStore();
	sessionTmpDirs += 1;
	initSessionStore(mkdtempSync(join(tmpdir(), `pi-sess-${sessionTmpDirs}-`)));
}
