/**
 * Chat compaction constants — pressure thresholds and output caps.
 *
 * This file is the single owner for hard coded compaction limits. Logic files
 * import from here; never hard code a compaction ratio or token cap inline.
 */

/** Synchronous chat compaction is the safety backstop, not the normal trigger. */
export const CHAT_SYNC_COMPACTION_RATIO = 0.85;
export const CHAT_MAX_OUTPUT_TOKENS = 16_000;

/**
 * Provider image accounting is dimension-dependent and unavailable after the
 * SDK content part has been hydrated to base64. Use a conservative fixed
 * allowance instead of treating base64 transport bytes as text tokens, which
 * would over-count a normal image by orders of magnitude.
 */
export const CHAT_HYDRATED_IMAGE_TOKENS = 2_000;
