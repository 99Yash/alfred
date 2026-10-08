/**
 * Subject-derived keys that dedup recurring notifications for briefings (#283)
 * and todos (#355). Trackers send a new email on a new thread for each comment,
 * so a thread-id key misses them. Keys: `gh:owner/repo#786`, `issue:eng-123`,
 * or a tracker-scoped normalized subject (ClickUp subjects are the task title).
 *
 * Interim (ADR-0092). Do not add vendors here: mint referent identities in
 * `packages/assistant/src/knowledge/referent-identity.ts`. Each vendor branch is
 * deleted once the shadow-projection probe shows coverage (ADR-0092 D5).
 */

import { parseEmailAddress } from "./guards";

const GITHUB_REPO_RE = /\[([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\]/;

/** `(PR #786)`, `(Issue #12)`, `(#12)`. */
const GITHUB_NUMBER_RE = /\((?:(PR|Issue)\s*)?#(\d+)\)/i;

/** An issue key only when enclosed or leading, so mid-sentence version tokens do not match. */
const ISSUE_KEY_ENCLOSED_RE = /[[(]([A-Z][A-Z0-9]{1,9}-\d+)[\])]/;

const ISSUE_KEY_LEADING_RE = /^([A-Z][A-Z0-9]{1,9}-\d+)\b/;

/** Reply and forward prefixes in a few locales. */
const REPLY_PREFIX_RE = /^\s*(?:re|fwd|fw|aw|sv|vs)\s*:\s*/i;

/** Gather stores this for a subject-less email. */
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

/**
 * Closed on purpose, next to the code that mints keys: a new spelling in an
 * MCP health-mapping response cannot become a provider.
 */
export const LOOP_ENTITY_PROVIDERS = [
  "clickup",
  "linear",
  "jira",
  "github",
  "asana",
  "trello",
  "notion",
  "issue",
  "monitoring",
] as const;

export type LoopEntityProvider = (typeof LOOP_ENTITY_PROVIDERS)[number];

const TRACKER_SENDER_PATTERNS = [
  { key: "clickup", re: /\bclickup\b|tasks\.clickup\.com/i },
  { key: "linear", re: /\blinear\b|linear\.app/i },
  { key: "jira", re: /\bjira\b|atlassian\.net|atlassian\.com/i },
  { key: "github", re: /\bgithub\b|github\.com/i },
  { key: "asana", re: /\basana\b|asana\.com/i },
  { key: "trello", re: /\btrello\b|trello\.com/i },
  { key: "notion", re: /\bnotion\b|notion\.so/i },
] as const satisfies ReadonlyArray<{
  key: Exclude<LoopEntityProvider, "issue" | "monitoring">;
  re: RegExp;
}>;

export type TrackerSenderKey = Exclude<LoopEntityProvider, "issue" | "monitoring">;

const MONITORING_SENDER_RE = /sns\.amazonaws\.com|pagerduty|opsgenie|grafana|datadog/i;

const MONITORING_ALARM_SUBJECT_RE = /^\s*(?:ALARM|ALERT)\s*:\s*(.+?)\s*$/i;

interface LoopKeyContext {
  sender?: string | null | undefined;
  /**
   * Return tracker keys only when the sender is that tracker. Set it for hard merge
   * keys: a human "Re: [owner/repo] ..." email must not merge todos.
   */
  requireTrackerSender?: boolean;
}

/**
 * Closed, so a new kind breaks every switch that persists a ref. A `subject` is
 * unique only per sender; a `pull_request` is unique everywhere.
 */
export type LoopEntityKind = "pull_request" | "issue" | "subject" | "alarm";

/** `provider` is `issue` when an issue key has no trusted tracker sender. */
export interface LoopEntityRef {
  key: string;
  provider: LoopEntityProvider;
  kind: LoopEntityKind;
  id: string;
}

/** Two items with the same non-null key are the same loop. */
export function deriveLoopKey(
  subject: string | null | undefined,
  context: LoopKeyContext = {},
): string | null {
  return deriveLoopEntityRef(subject, context)?.key ?? null;
}

/** Use this when the key is persisted as provenance. */
export function deriveLoopEntityRef(
  subject: string | null | undefined,
  context: LoopKeyContext = {},
): LoopEntityRef | null {
  if (!subject) return null;
  const raw = subject.trim();

  if (raw.length === 0) return null;
  const prefixStripped = stripReplyPrefixes(raw);

  const monitoring = monitoringAlarmLoopEntityRef(prefixStripped, context.sender);

  if (monitoring) return monitoring;

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
  tracker: TrackerSenderKey | null | undefined,
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

/**
 * The tracker a sender looks like. Use it before you mint a persisted key from
 * vendor-shaped text. It reads the display name too, so it is not authentication.
 */
export function trackerSenderKey(sender: string | null | undefined): TrackerSenderKey | null {
  if (!sender) return null;
  const parts = [sender];
  const address = parseEmailAddress(sender);

  if (address) parts.push(address, address.split("@")[1] ?? "");
  const haystack = parts.join(" ");

  return TRACKER_SENDER_PATTERNS.find((pattern) => pattern.re.test(haystack))?.key ?? null;
}

function monitoringAlarmLoopEntityRef(
  subject: string,
  sender: string | null | undefined,
): LoopEntityRef | null {
  const match = subject.match(MONITORING_ALARM_SUBJECT_RE);

  if (!match) return null;

  if (!sender || !MONITORING_SENDER_RE.test(sender)) return null;
  const remainder = (match[1] ?? "").trim();

  if (!remainder) return null;
  // CloudWatch: `ALARM: "Name" in region ...`. The quoted name is the entity.
  const quoted = remainder.match(/"([^"]+)"|'([^']+)'/);

  const rawName = quoted
    ? (quoted[1] ?? quoted[2] ?? "")
    : (remainder.split(/\s+in\s+|\s+-\s+/i)[0] ?? remainder);

  const trimmed = rawName.trim();

  if (!trimmed) return null;
  const normalized = normalizeSubject(trimmed);

  if (!normalized || normalized === NO_SUBJECT_SENTINEL) return null;

  // Short alarm names ("baserow-response-time") are still real entities.
  if (GENERIC_SUBJECTS.has(normalized)) return null;

  return {
    key: `alarm:${normalized}`,
    provider: "monitoring",
    kind: "alarm",
    id: normalized,
  };
}

function isSpecificFallbackSubject(normalized: string): boolean {
  if (GENERIC_SUBJECTS.has(normalized)) return false;
  const tokens = normalized.split(/\s+/).filter(Boolean);

  return tokens.length >= 3 || normalized.includes(":");
}

function stripReplyPrefixes(subject: string): string {
  let out = subject;
  let prev: string;

  do {
    prev = out;
    out = out.replace(REPLY_PREFIX_RE, "");
  } while (out !== prev);

  return out;
}

function normalizeSubject(subject: string): string {
  // drift-ok: a key normalizer. Changing it re-keys every stored row, so it must
  // not share `collapseWhitespace`, which can change for display reasons.
  return subject.replace(/\s+/g, " ").trim().toLowerCase();
}
