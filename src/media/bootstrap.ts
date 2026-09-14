/**
 * Phase 3 (S6) — bootstrap wiring for the MediaManager.
 *
 * Bridges the `GatewayConfig.media` block (concept §10) to the manager's
 * `MediaOptions`, respecting the `enabled` master switch. Called from
 * `src/index.ts` (inline extension load) and `src/core/daemon.ts` (detached
 * daemon) so both bootstrap paths initialize media exactly once.
 */
import type { MediaConfig } from "../types.js";
import type { MediaManager } from "./manager.js";
import { initMediaManager } from "./manager.js";

/**
 * Wire the process-wide MediaManager singleton from the merged config.
 *
 * Returns `null` when media is disabled (or the block is absent) so adapters
 * and the pipeline fall back to the pre-Phase-3 "drop media" behaviour.
 */
export function bootstrapMediaManager(media?: MediaConfig): MediaManager | null {
	if (!media || media.enabled === false) return null;
	// MediaOptions and MediaConfig are structurally compatible on the fields
	// the manager consumes; passing the whole block keeps defaults central.
	return initMediaManager(media);
}
