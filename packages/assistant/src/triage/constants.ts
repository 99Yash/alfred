/** Email-triage limits and thresholds. */

/** Maximum rows read when deriving thread state. */
export const TRIAGE_THREAD_STATE_ROW_LIMIT = 500;

/** Maximum prior messages included in the bounded thread observation. */
export const TRIAGE_RECENT_MESSAGE_LIMIT = 6;

/** Maximum characters included from each prior thread message. */
export const TRIAGE_RECENT_MESSAGE_MAX_CHARS = 220;

/** Structured classifier output budget. */
export const TRIAGE_MAX_OUTPUT_TOKENS = 400;

/** Total wall-clock budget for one classifier request, including retries. */
export const TRIAGE_REQUEST_TIMEOUT_MS = 30_000;

/** Maximum length of the optional hard-fact fragment on a suggested todo. */
export const TRIAGE_TODO_ASSIST_MAX_CHARS = 40;

/**
 * The most characters of standing-instruction lines in one classifier prompt (slice 4a). Over
 * it, the newest instructions that fit go in, and the trace counts the ones left out.
 */
export const TRIAGE_INSTRUCTION_BLOCK_MAX_CHARS = 12_000;
