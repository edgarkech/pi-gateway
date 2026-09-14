/**
 * Phase 3 (File-Attachments) — public exports of the media module.
 *
 * S2/S3 scope: SQLite registry, cleanup/retention, and the MediaManager
 * orchestration singleton (initMediaManager).
 */

export type { ImageContent, MediaAttachment, MediaIngestRequest, MediaKind } from "./types.js";
export { MediaError } from "./types.js";

export type { ValidatedMedia } from "./validate.js";
export {
	DEFAULT_ALLOWED_MIME_TYPES,
	deriveKind,
	isMimeAllowed,
	sanitizeFilename,
	sniffMimeType,
	validateMedia,
} from "./validate.js";

export type { MediaRegistryRow, MediaRegistryRow as MediaFileRow } from "./registry.js";
export {
	count as countMediaRows,
	deleteMedia as deleteMediaRow,
	get as getMediaRow,
	getExpired as getExpiredMediaRows,
	getForDedup,
	getTotalBytes,
	initMediaRegistry,
	insert as insertMediaRow,
	listOldestFirst,
	pruneMissingFiles,
	resetMediaRegistry,
} from "./registry.js";

export type { CleanupStats } from "./cleanup.js";
export { cleanupStaleParts, evictOldestForQuota, pruneRegistry, sweepExpired } from "./cleanup.js";

export type { MediaManager, MediaOptions } from "./manager.js";
export { initMediaManager, resetMediaManager, shutdownMediaManager } from "./manager.js";

export type { ManifestOptions } from "./manifest.js";
export {
	DEFAULT_MAX_IMAGE_BYTES,
	buildAttachmentManifest,
	formatBytes,
	readAttachmentImage,
	renderAttachmentEntry,
} from "./manifest.js";

export { bootstrapMediaManager } from "./bootstrap.js";
