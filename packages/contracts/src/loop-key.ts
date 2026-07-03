/**
 * Loop/entity keys for recurring-notification dedup — shared across briefing
 * continuity (#283) and todo-rail recurrence dedup (#355).
 *
 * Keying on the Gmail thread id misses the dominant repetition pattern:
 * collaboration tools (ClickUp, GitHub, Linear, Jira) re-notify about the *same
 * underlying work item* by sending a **new** email — a comment, a status
 * change, a re-assignment — each on its own thread. Every such email is a fresh,
 * never-surfaced document, so it slips past a thread-keyed dedup and the loop is
 * restated as if it were new: the briefing re-surfaces it (#283), and the todo
 * rail re-mints a duplicate suggestion (#355).
 *
 * `deriveLoopKey` collapses those re-notifications onto one stable key so both
 * consumers recognize them as the same loop:
 *
 *   1. **GitHub** notification subjects carry both the repo and the PR/issue
 *      number verbatim — `Re: [owner/repo] Title (PR #786)` — so two emails
 *      about PR #786 (a review + a comment) collapse to `gh:owner/repo#786`.
 *   2. **Linear / Jira** embed an issue key (`ENG-123`, `PROJ-45`) in brackets
 *      or at the start of the subject → `issue:eng-123`.
 *   3. Known tracker senders can fall back to a **provider-scoped normalized
 *      subject**. ClickUp is the motivating case: its notification subject *is*
 *      the task title (`Netsmart: Save view issues`), which repeats verbatim
 *      across the comment / assignment / reminder emails for that task.
 *
 * Pure and deterministic — subject text only, no network, no model, no body
 * read. Keying on the subject (which both the live `documents` row and the
 * persisted `gather` item carry) is what lets the read side compare a
 * current-window email against a prior briefing's items without re-fetching
 * anything. A provider whose notification subject carries neither an entity id
 * nor a sufficiently specific item title (e.g. ClickUp's occasional actor-name
 * / space-name subjects) still degrades safely to the thread-id signal.
 *
 * This is the *interim* content/shape key. The durable form derives the entity
 * identity from the ADR-0067 observation-log projection (#218); this heuristic
 * is the same one both consumers share until that lands.
 */

import { parseEmailAddress } from "./guards.js";

/** Owner/repo bracket in a GitHub notification subject: `[owner/repo]`. */
const GITHUB_REPO_RE = /\[([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\]/;
/** Trailing PR/issue number GitHub appends: `(PR #786)`, `(Issue #12)`, `(#12)`. */
const GITHUB_NUMBER_RE = /\((?:(PR|Issue)\s*)?#(\d+)\)/i;
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

const GENERIC_SUBJECTS = new Set([
  "action required",
  "engineering",
  "fyi",
  "notification",
  "reminder",
  "update",
  "updates",
]);

const TRACKER_SENDER_PATTERNS: Array<{ key: string; re: RegExp }> = [
  { key: "clickup", re: /\bclickup\b|tasks\.clickup\.com/i },
  { key: "linear", re: /\blinear\b|linear\.app/i },
  { key: "jira", re: /\bjira\b|atlassian\.net|atlassian\.com/i },
  { key: "github", re: /\bgithub\b|github\.com/i },
  { key: "asana", re: /\basana\b|asana\.com/i },
  { key: "trello", re: /\btrello\b|trello\.com/i },
  { key: "notion", re: /\bnotion\b|notion\.so/i },
];

interface LoopKeyContext {
  /** Sender header, email address, or persisted sender display label. */
  sender?: string | null;
  /**
   * Require the sender to look like the provider before returning structured
   * tracker keys. Briefing uses loop keys as a soft continuation hint, so it can
   * accept subject-only GitHub/Jira shapes. Todos use them as hard merge keys,
   * so a human email with "Re: [owner/repo] ..." must not collapse unrelated
   * rail items.
   */
  requireTrackerSender?: boolean;
}

export interface LoopEntityRef {
  key: string;
  provider: string;
  kind: string;
  id: string;
}

/**
 * Resolve a stable loop key for an email from its subject, or `null` when the
 * subject carries no usable signal (empty / subject-less). Callers treat two
 * items sharing a non-null key as the same underlying loop.
 */
export function deriveLoopKey(
  subject: string | null | undefined,
  context: LoopKeyContext = {},
): string | null {
  return deriveLoopEntityRef(subject, context)?.key ?? null;
}

/**
 * Structured form of {@link deriveLoopKey}. Use this when the loop key becomes
 * persisted provenance, not just a read-side continuity hint.
 */
export function deriveLoopEntityRef(
  subject: string | null | undefined,
  context: LoopKeyContext = {},
): LoopEntityRef | null {
  if (!subject) return null;
  const raw = subject.trim();
  if (raw.length === 0) return null;
  const prefixStripped = stripReplyPrefixes(raw);
  const tracker = trackerSenderKey(context.sender);

  const github = githubLoopEntityRef(prefixStripped);
  if (github && (!context.requireTrackerSender || tracker === "github")) return github;

  const issue = issueLoopEntityRef(prefixStripped, tracker);
  if (issue && (!context.requireTrackerSender || tracker === "linear" || tracker === "jira")) {
    return issue;
  }

  const normalized = normalizeSubject(prefixStripped);
  if (!normalized || normalized === NO_SUBJECT_SENTINEL) return null;
  if (!isSpecificFallbackSubject(normalized)) return null;
  if (!tracker) return null;
  return {
    key: `subj:${tracker}:${normalized}`,
    provider: tracker,
    kind: "subject",
    id: normalized,
  };
}

function githubLoopEntityRef(subject: string): LoopEntityRef | null {
  const repo = subject.match(GITHUB_REPO_RE)?.[1];
  const numberMatch = subject.match(GITHUB_NUMBER_RE);
  const type = numberMatch?.[1]?.toLowerCase();
  const number = numberMatch?.[2];
  if (!repo || !number) return null;
  const normalizedRepo = repo.toLowerCase();
  return {
    key: `gh:${normalizedRepo}#${number}`,
    provider: "github",
    kind: type === "pr" ? "pull_request" : "issue",
    id: `${normalizedRepo}#${number}`,
  };
}

function issueLoopEntityRef(
  subject: string,
  tracker: string | null | undefined,
): LoopEntityRef | null {
  const key = subject.match(ISSUE_KEY_ENCLOSED_RE)?.[1] ?? subject.match(ISSUE_KEY_LEADING_RE)?.[1];
  if (!key) return null;
  const normalized = key.toLowerCase();
  return {
    key: `issue:${normalized}`,
    provider: tracker === "jira" || tracker === "linear" ? tracker : "issue",
    kind: "issue",
    id: normalized,
  };
}

function trackerSenderKey(sender: string | null | undefined): string | null {
  if (!sender) return null;
  const parts = [sender];
  const address = parseEmailAddress(sender);
  if (address) parts.push(address, address.split("@")[1] ?? "");
  const haystack = parts.join(" ");
  return TRACKER_SENDER_PATTERNS.find((pattern) => pattern.re.test(haystack))?.key ?? null;
}

function isSpecificFallbackSubject(normalized: string): boolean {
  if (GENERIC_SUBJECTS.has(normalized)) return false;
  const tokens = normalized.split(/\s+/).filter(Boolean);
  return tokens.length >= 3 || normalized.includes(":");
}

function stripReplyPrefixes(subject: string): string {
  let out = subject;
  // Strip stacked prefixes ("Re: Fwd: …") one layer at a time.
  let prev: string;
  do {
    prev = out;
    out = out.replace(REPLY_PREFIX_RE, "");
  } while (out !== prev);
  return out;
}

/** Lowercased, whitespace-collapsed subject. */
function normalizeSubject(subject: string): string {
  return subject.replace(/\s+/g, " ").trim().toLowerCase();
}
