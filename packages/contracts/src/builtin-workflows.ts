/**
 * Live builtin workflow slugs that the web presents. The server registers these slugs, and the web keys its card art on them.
 * A resume-only slug stays in assistant as `LEGACY_*`; the web must not present it.
 */

export const DAILY_BRIEFING_WORKFLOW_SLUG = "daily-briefing";

export const TRIAGE_WORKFLOW_SLUG = "email-triage";

export const COLD_START_WORKFLOW_SLUG = "cold-start-research";

export const REPLY_DRAFTING_WORKFLOW_SLUG = "reply-drafting";
