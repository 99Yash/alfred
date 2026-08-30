/**
 * Email-triage limits and thresholds.
 *
 * These values jointly bound classifier context, model requests, and the
 * narrowly gated second-pass policy. Keep semantic matchers and category
 * partitions beside the logic that explains them.
 */

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

/**
 * Thresholds for the service-prior `action_needed` recheck (#351).
 *
 * A task-tracker service with an action-heavy history can feed that history
 * back as a reason to repeat the category. Require an established, strongly
 * skewed prior before paying for the second pass. The model may still keep
 * `action_needed` when the body assigns the item to the user.
 */
export const TRIAGE_SERVICE_ACTION_LOOP_MIN_TOTAL = 8;

export const TRIAGE_SERVICE_ACTION_LOOP_MIN_SHARE = 0.5;

/** Confidence floor used only when the safety second pass itself fails. */
export const TRIAGE_SECOND_PASS_FAILURE_CONFIDENCE_FLOOR = 0.6;
