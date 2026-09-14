/**
 * Phase 3 (File-Attachments) — cleanup / retention.
 *
 * Implements concept_phase_3_media.md §6.4. All mechanisms operate on the
 * isolation of registry row + physical file; deletion is always idempotent
 * (missing files are skipped, not errors). No sweep interval is started here —
 * the MediaManager (S3) owns the periodic timer via `initMediaManager()`.
 *
 * The helpers are split so the manager can compose the exact policy:
 * - `sweepExpired()`        → TTL cleanup (`expires_at < now`).
 * - `evictOldestForQuota()` → FIFO eviction until the store fits `maxTotalBytes`.
 * - `cleanupStaleParts()`   → orphan `.part` temp files (> threshold age).
 * - `pruneRegistry()`       → drop rows whose physical file is gone.
 */

import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { logger } from "../logger.js";
import { deleteMedia, getExpired, listOldestFirst, pruneMissingFiles } from "./registry.js";

export interface CleanupStats {
	deletedFiles: number;
	freedBytes: number;
}

/** Delete the physical file of a row if present; returns freed bytes. */
async function removeFileIfPresent(localPath: string): Promise<number> {
	if (!localPath || !existsSync(localPath)) return 0;
	try {
		const fileStat = await stat(localPath);
		await rm(localPath, { force: true });
		return fileStat.size;
	} catch (err) {
		logger.warn("[MediaCleanup] Could not remove file:", localPath, err);
		return 0;
	}
}

/**
 * TTL sweep: delete every registered file+row whose `expires_at` has passed.
 *
 * Deletes the physical file first (collecting freed bytes) and the registry
 * row second. A missing physical file is not an error — the row is pruned and
 * `deletedFiles` still increments (the entry is gone either way).
 */
export async function sweepExpired(now: number = Date.now()): Promise<CleanupStats> {
	const expired = getExpired(now);
	let deletedFiles = 0;
	let freedBytes = 0;

	for (const row of expired) {
		freedBytes += await removeFileIfPresent(row.localPath);
		deleteRowById(row.id);
		deletedFiles += 1;
		logger.info(
			`[MediaCleanup] TTL sweep removed ${row.id} (${row.mimeType}, ${row.sizeBytes} B)`,
		);
	}

	return { deletedFiles, freedBytes };
}

/**
 * FIFO quota-eviction: delete the oldest registered files until the summed
 * size of the REMAINING files no longer exceeds `targetBytes`.
 *
 * The manager passes `maxTotalBytes - newSize` as the target so that after
 * eviction there is room for the incoming file. Returns aggregate stats, or
 * a zeroed result when nothing had to be evicted.
 */
export async function evictOldestForQuota(
	targetBytes: number,
	currentTotalBytes: number,
): Promise<CleanupStats> {
	let changed = false;
	let deletedFiles = 0;
	let freedBytes = 0;
	let remaining = currentTotalBytes;

	while (remaining > targetBytes) {
		const oldest = listOldestFirst(1)[0];
		if (!oldest) break; // store is empty but still over target → caller reports QUOTA_EXCEEDED
		freedBytes += await removeFileIfPresent(oldest.localPath);
		deleteRowById(oldest.id);
		deletedFiles += 1;
		remaining -= oldest.sizeBytes;
		changed = true;
		logger.info(
			`[MediaCleanup] Quota eviction removed ${oldest.id} (${oldest.mimeType}, ${oldest.sizeBytes} B)`,
		);
	}

	if (!changed) {
		return { deletedFiles: 0, freedBytes: 0 };
	}
	return { deletedFiles, freedBytes };
}

/**
 * Startup cleanup: remove orphan `.part` temp files older than `staleAgeMs`
 * (concept §6.4 — consolidates crash left-overs). Returns the number removed.
 */
export async function cleanupStaleParts(rootDir: string, staleAgeMs: number): Promise<number> {
	if (!existsSync(rootDir)) return 0;

	const now = Date.now();
	let removed = 0;

	// Walk platform buckets one level deep (root/<platform>/<yyyy-mm>/*.part).
	for (const platformDir of await listSubdirs(rootDir)) {
		for (const monthDir of await listSubdirs(platformDir)) {
			const entries = await readdir(monthDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.name.endsWith(".part")) continue;
				const full = join(monthDir, entry.name);
				try {
					const fileStat = await stat(full);
					if (now - fileStat.mtimeMs > staleAgeMs) {
						await rm(full, { force: true });
						removed += 1;
						logger.info("[MediaCleanup] Removed stale .part file:", full);
					}
				} catch (err) {
					logger.warn("[MediaCleanup] Could not inspect .part file:", full, err);
				}
			}
		}
	}
	return removed;
}

/**
 * Startup consolidation: drop registry rows whose physical file no longer
 * exists (concept §6.4). Returns the number of pruned rows.
 */
export function pruneRegistry(): number {
	const missing = pruneMissingFiles((localPath) => existsSync(localPath));
	if (missing.length > 0) {
		logger.info(`[MediaCleanup] Pruned ${missing.length} registry row(s) with missing files`);
	}
	return missing.length;
}

// ── Internal helpers ───────────────────────────────────────────────────────

async function listSubdirs(parent: string): Promise<string[]> {
	const entries = await readdir(parent, { withFileTypes: true });
	return entries.filter((e) => e.isDirectory()).map((e) => join(parent, e.name));
}

/** Delete a registry row by id (guarded, idempotent). */
function deleteRowById(id: string): void {
	deleteMedia(id);
}
