/** All compaction limits live here. Never inline a ratio or token cap. */

/** Synchronous chat compaction is the safety backstop, not the normal trigger. */
export const CHAT_SYNC_COMPACTION_RATIO = 0.85;

export const CHAT_MAX_OUTPUT_TOKENS = 16_000;

/** A fixed image allowance: counting base64 bytes as text overcounts by orders of magnitude. */
export const CHAT_HYDRATED_IMAGE_TOKENS = 2_000;
