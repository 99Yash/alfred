/**
 * Loop/entity keys for briefing continuity (#283).
 *
 * `previouslySurfaced` used to key purely on the Gmail thread id. That misses
 * the dominant repetition pattern: collaboration tools (ClickUp, GitHub, Linear,
 * Jira) re-notify about the *same underlying work item* by sending a **new**
 * email — a comment, a status change, a re-assignment — each on its own thread.
 * Every such email is a fresh, never-surfaced document, so it slips past a
 * thread-keyed dedup and the briefing restates the item as if it were new.
 *
 * `deriveLoopKey` collapses those re-notifications onto one stable key so the
 * continuation signal recognizes them as the same loop:
 *
 *   1. **GitHub** notification subjects carry both the repo and the PR/issue
 *      number verbatim — `Re: [owner/repo] Title (PR #786)` — so two emails
 *      about PR #786 (a review + a comment) collapse to `gh:owner/repo#786`.
 *   2. **Linear / Jira** embed an issue key (`ENG-123`, `PROJ-45`) in brackets
 *      or at the start of the subject → `issue:eng-123`.
 *   3. Everything else falls back to a **normalized subject**. ClickUp is the
 *      motivating case: its notification subject *is* the task title
 *      (`Netsmart: Save view issues`), which repeats verbatim across the
 *      comment / assignment / reminder emails for that task, so the normalized
 *      subject already collapses them.
 *
 * Pure and deterministic — subject text only, no network, no model, no body
 * read. Keying on the subject (which both the live `documents` row and the
 * persisted `gather` item carry) is what lets the read side compare a
 * current-window email against a prior briefing's items without re-fetching
 * anything. A provider whose notification subject carries neither an entity id
 * nor the item's title (e.g. ClickUp's occasional actor-name / space-name
 * subjects) still degrades safely to the thread-id signal.
 */

/** Owner/repo bracket in a GitHub notification subject: `[owner/repo]`. */
const GITHUB_REPO_RE = /\[([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\]/;
/** Trailing PR/issue number GitHub appends: `(PR #786)`, `(Issue #12)`, `(#12)`. */
const GITHUB_NUMBER_RE = /\((?:PR|Issue)?\s*#(\d+)\)/i;
/**
 * Linear / Jira issue key, either bracket/paren-enclosed or at the very start
 * of the subject. Anchoring keeps it from matching version-ish tokens buried
 * mid-sentence; the `{2,}` prefix avoids single-letter false positives.
 */
const ISSUE_KEY_ENCLOSED_RE = /[[(]([A-Z][A-Z0-9]{1,9}-\d+)[\])]/;
const ISSUE_KEY_LEADING_RE = /^([A-Z][A-Z0-9]{1,9}-\d+)\b/;

/** Reply / forward prefixes across a few common locales, stripped repeatedly. */
const REPLY_PREFIX_RE = /^\s*(?:re|fwd|fw|aw|sv|vs)\s*:\s*/i;

/** Gather persists this sentinel for a subject-less email; never a real loop. */
const NO_SUBJECT_SENTINEL = "(no subject)";
const MAX_KEY_LENGTH = 200;

/**
 * Resolve a stable loop key for an email from its subject, or `null` when the
 * subject carries no usable signal (empty / subject-less). Callers treat two
 * items sharing a non-null key as the same underlying loop.
 */
export function deriveLoopKey(subject: string | null | undefined): string | null {
  if (!subject) return null;
  const raw = subject.trim();
  if (raw.length === 0) return null;

  const github = githubLoopKey(raw);
  if (github) return github;

  const issue = issueLoopKey(raw);
  if (issue) return issue;

  const normalized = normalizeSubject(raw);
  if (!normalized || normalized === NO_SUBJECT_SENTINEL) return null;
  return `subj:${normalized.slice(0, MAX_KEY_LENGTH)}`;
}

function githubLoopKey(subject: string): string | null {
  const repo = subject.match(GITHUB_REPO_RE)?.[1];
  const number = subject.match(GITHUB_NUMBER_RE)?.[1];
  if (!repo || !number) return null;
  return `gh:${repo.toLowerCase()}#${number}`;
}

function issueLoopKey(subject: string): string | null {
  const key = subject.match(ISSUE_KEY_ENCLOSED_RE)?.[1] ?? subject.match(ISSUE_KEY_LEADING_RE)?.[1];
  return key ? `issue:${key.toLowerCase()}` : null;
}

/** Lowercased, reply-prefix-stripped, whitespace-collapsed subject. */
function normalizeSubject(subject: string): string {
  let out = subject;
  // Strip stacked prefixes ("Re: Fwd: …") one layer at a time.
  let prev: string;
  do {
    prev = out;
    out = out.replace(REPLY_PREFIX_RE, "");
  } while (out !== prev);
  return out.replace(/\s+/g, " ").trim().toLowerCase();
}
