/** Email-triage limits and thresholds. */

/** Maximum body evidence included in one classifier prompt. */
export const TRIAGE_BODY_MAX_CHARS = 6_000;

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

/** Minimum sender history needed before the bulk-prior recheck can fire. */
export const TRIAGE_STRONG_BULK_MIN_TOTAL = 5;

/** Minimum bulk-category share needed before the bulk-prior recheck can fire. */
export const TRIAGE_STRONG_BULK_MIN_SHARE = 0.8;

/** Service-prior `action_needed` recheck (#351): needs an established, skewed prior. */
export const TRIAGE_SERVICE_ACTION_LOOP_MIN_TOTAL = 8;

export const TRIAGE_SERVICE_ACTION_LOOP_MIN_SHARE = 0.5;

/**
 * The instruction allowance (ADR-0113): characters of scoped standing instructions in one
 * classifier prompt. Newest first. An instruction past it is `unknown`, and the trace counts it.
 */
export const TRIAGE_INSTRUCTION_BLOCK_MAX_CHARS = 12_000;

/** Extra output budget when the prompt carries scoped instructions, for `instructionMatches`. */
export const TRIAGE_INSTRUCTION_MATCH_OUTPUT_TOKENS = 300;

/** Maximum length of the model's reason for one instruction match. */
export const TRIAGE_INSTRUCTION_MATCH_REASON_MAX_CHARS = 200;
