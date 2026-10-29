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
 * classifier prompt, with {@link TRIAGE_INSTRUCTION_MATCH_MAX_ENTRIES} as the count limit.
 * Newest first. An instruction past either limit is `unknown`, and the trace counts it.
 */
export const TRIAGE_INSTRUCTION_BLOCK_MAX_CHARS = 12_000;

/**
 * The most scoped instructions in one classifier prompt. The output allowance below must hold a
 * match for each of them, so the count and the allowance change together.
 */
export const TRIAGE_INSTRUCTION_MATCH_MAX_ENTRIES = 24;

/**
 * The output budget for one `instructionMatches` entry: the id, a reason under 20 words, and
 * `covers`. About 30 tokens is typical; the rest is headroom for a long reason.
 */
const TRIAGE_INSTRUCTION_MATCH_ENTRY_TOKENS = 64;

/** Extra output budget when the prompt carries scoped instructions: every sent one can match. */
export const TRIAGE_INSTRUCTION_MATCH_OUTPUT_TOKENS =
  TRIAGE_INSTRUCTION_MATCH_MAX_ENTRIES * TRIAGE_INSTRUCTION_MATCH_ENTRY_TOKENS;

/** Maximum length of the model's reason for one instruction match. */
export const TRIAGE_INSTRUCTION_MATCH_REASON_MAX_CHARS = 200;

/**
 * The re-match window (ADR-0113, "Re-match after a change"): mail ingested this recently is
 * still read by a consumer. Briefing gather reads the last 24 hours on ingest time; the extra
 * day covers a missed briefing and a reply-draft run that waits.
 */
export const TRIAGE_REMATCH_WINDOW_HOURS = 48;

/** The most triage rows that one re-match job reads for one user, newest first. */
export const TRIAGE_REMATCH_MAX_ROWS = 200;

/** Match-only calls in flight at one time in one re-match job. */
export const TRIAGE_REMATCH_CONCURRENCY = 4;
