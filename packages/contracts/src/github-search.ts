/**
 * Harden the boss's free-form `github.search` query (#213, ADR-0071).
 * GitHub silently treats an unknown qualifier (`merged-by:`) as text and returns 0.
 * Free-typed `is:`/`author:`/`state:`/date tokens collide with the structured fields.
 * `sanitizeGithubSearchQuery` folds collisions into the fields.
 * `githubSearchQueryIssues` rejects what it cannot fix.
 */
import { enumGuard } from "./guards";

/** Real GitHub issue and PR search qualifiers. Anything else counts as invented. */
export const GITHUB_PR_SEARCH_QUALIFIERS: ReadonlySet<string> = new Set([
  "type",
  "is",
  "in",
  "state",
  "reason",
  "author",
  "assignee",
  "mentions",
  "commenter",
  "involves",
  "team",
  "review-requested",
  "user-review-requested",
  "team-review-requested",
  "reviewed-by",
  "org",
  "repo",
  "user",
  "label",
  "milestone",
  "project",
  "status",
  "head",
  "base",
  "language",
  "comments",
  "interactions",
  "reactions",
  "draft",
  "review",
  "linked",
  "has",
  "no",
  "sort",
  "created",
  "updated",
  "closed",
  "merged",
  "archived",
]);

/** Finds qualifiers inside boolean groups too, such as `(label:bug OR review-requested:@me)`. */
const QUALIFIER_TOKEN = String.raw`-?([A-Za-z][\w-]*):(?:"[^"]*"|[^\s)]*)`;

const QUALIFIER_SCAN_RE = new RegExp(String.raw`(^|[\s(])(${QUALIFIER_TOKEN})`, "g");

/**
 * The same scan, plus the boolean operator that binds the token. A dropped token
 * takes its operator, because a dangling operator makes GitHub return 422.
 * Groups: 1 = boundary, 2 = operator (may be empty), 3 = token, 4 = name.
 */
const QUALIFIER_STRIP_RE = new RegExp(
  String.raw`(^|[\s(])((?:(?:AND|OR|NOT)\s+)?)(${QUALIFIER_TOKEN})`,
  "g",
);

export interface ParsedQualifier {
  raw: string;
  key: string;
  /** Interpreted only for managed qualifiers. */
  value: string;
  /** The structured fields only include, so a negated qualifier is never folded. */
  negated: boolean;
}

/** Lets {@link stripQualifiers} drop exact tokens, so `is:pr` cannot clip `is:private`. */
function qualifierIdentity(q: Pick<ParsedQualifier, "key" | "value" | "negated">): string {
  return `${q.negated ? "-" : ""}${q.key}:${q.value}`;
}

/** Bare words are skipped. */
export function parseSearchQualifiers(query: string): ParsedQualifier[] {
  const out: ParsedQualifier[] = [];

  for (const match of query.matchAll(QUALIFIER_SCAN_RE)) {
    const raw = match[3]!;
    const token = match[2]!;
    const negated = token.startsWith("-");
    const value = token.slice(token.indexOf(":") + 1);
    out.push({ raw, key: raw.toLowerCase(), value, negated });
  }

  return out;
}

/**
 * Each date qualifier and the `github.search` field that sets it. Read the window
 * length only through {@link githubSearchWindowDays}.
 */
export const GITHUB_SEARCH_WINDOWS = [
  { qualifier: "closed", field: "closedWithinDays" },
  { qualifier: "created", field: "createdWithinDays" },
  { qualifier: "merged", field: "mergedWithinDays" },
] as const;

export type GithubSearchWindow = (typeof GITHUB_SEARCH_WINDOWS)[number]["qualifier"];

export type GithubSearchWindowEntry = (typeof GITHUB_SEARCH_WINDOWS)[number];

const isWindowQualifier = enumGuard(GITHUB_SEARCH_WINDOWS.map((entry) => entry.qualifier));

function windowEntry(qualifier: string): GithubSearchWindowEntry | undefined {
  return GITHUB_SEARCH_WINDOWS.find((entry) => entry.qualifier === qualifier);
}

const ISO_DATE = String.raw`\d{4}-\d{2}-\d{2}`;

const ISO_DATE_TIME = String.raw`${ISO_DATE}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})`;

const DATE_BOUND = String.raw`(?:${ISO_DATE}|${ISO_DATE_TIME})`;

const DATE_COMPARISON_RE = new RegExp(String.raw`^(?:[<>]=?)?${DATE_BOUND}$`, "i");

const DATE_RANGE_RE = new RegExp(String.raw`^${DATE_BOUND}\.\.${DATE_BOUND}$`, "i");

function normalizeQualifierValue(value: string): string {
  return cleanQualifierValue(value).toLowerCase();
}

function cleanQualifierValue(value: string): string {
  return value
    .trim()
    .replace(/^[("']+/, "")
    .replace(/[)"']+$/, "");
}

function isValidDateQualifierValue(value: string): boolean {
  const clean = cleanQualifierValue(value);

  return DATE_COMPARISON_RE.test(clean) || DATE_RANGE_RE.test(clean);
}

export type GithubSearchType = "issue" | "pr" | "both";

export type GithubSearchState = "open" | "closed" | "merged" | "all";

const IS_STATE_VALUES = ["open", "closed", "merged"] as const;

const isRecognizedIsState = enumGuard(IS_STATE_VALUES);

/**
 * Qualifiers that name a place or person. With one, `github.search` must not add
 * the `author:@me` default: that would silently narrow the search (ADR-0071).
 */
const NARROWING_SCOPE_QUALIFIERS: ReadonlySet<string> = new Set([
  "repo",
  "org",
  "user",
  "author",
  "assignee",
  "mentions",
  "commenter",
  "involves",
  "review-requested",
  "user-review-requested",
  "team-review-requested",
  "reviewed-by",
  "team",
]);

/** When true, an unset author does not default to `@me`. */
export function queryHasNarrowingScope(query: string | undefined): boolean {
  if (!query?.trim()) return false;

  // A negated qualifier (`-author:octocat`) excludes; it does not scope.
  // Counting it turned "my PRs except octocat" into a broad search.
  return parseSearchQualifiers(query).some(
    (q) => !q.negated && NARROWING_SCOPE_QUALIFIERS.has(q.key),
  );
}

export interface GithubSearchQueryContext {
  /** Owns the `is:pr`/`is:issue` clause. */
  type?: GithubSearchType | undefined;
  author?: string | undefined;
  state?: GithubSearchState | undefined;
  query?: string | undefined;
  closedWithinDays?: number | undefined;
  createdWithinDays?: number | undefined;
  mergedWithinDays?: number | undefined;
  /** One window for every event this search can observe. See {@link githubActivityWindows}. */
  activeWithinDays?: number | undefined;
}

/**
 * The events `activeWithinDays` covers. Creation always counts; closed and merged
 * drop out when type or state rule them out, so the field cannot contradict them.
 */
export function githubActivityWindows(
  input: Pick<GithubSearchQueryContext, "type" | "state">,
): readonly GithubSearchWindow[] {
  // An open item has neither closed nor merged, so only creation is observable.
  if (input.state === "open") return ["created"];

  // An issue never merges.
  if (input.type === "issue") return ["closed", "created"];

  return ["closed", "created", "merged"];
}

/** The explicit `*WithinDays`, else `activeWithinDays` if it covers this event. `undefined`: no token. */
export function githubSearchWindowDays(
  input: GithubSearchQueryContext,
  window: GithubSearchWindowEntry,
): number | undefined {
  const explicit = input[window.field];

  if (explicit !== undefined) return explicit;

  if (input.activeWithinDays === undefined) return undefined;

  return githubActivityWindows(input).includes(window.qualifier)
    ? input.activeWithinDays
    : undefined;
}

/**
 * Problems the sanitizer cannot fix: invented keys, malformed dates, and
 * contradictory fields. Run it on the sanitized input. Empty when clean.
 */
export function githubSearchQueryIssues(input: GithubSearchQueryContext): string[] {
  const query = input.query?.trim();
  const issues: string[] = [];
  const qualifiers = query ? parseSearchQualifiers(query) : [];

  // No single correct intent, so these stay hard rejections.
  if (input.state === "open" && input.closedWithinDays !== undefined) {
    issues.push("`closedWithinDays` conflicts with `state:'open'` — open PRs have not closed.");
  }

  if (input.state === "open" && input.mergedWithinDays !== undefined) {
    issues.push("`mergedWithinDays` conflicts with `state:'open'` — merged PRs are closed.");
  }

  if (
    input.type === "issue" &&
    (input.state === "merged" || input.mergedWithinDays !== undefined)
  ) {
    issues.push(
      "`merged` filters conflict with `type:'issue'` — issues are never merged. Use `type:'pr'` (or `'both'`) to filter by merge.",
    );
  }

  // `is:unmerged` with merged filters is a contradiction. `-is:unmerged` is fine.
  const hasUnmergedFilter = qualifiers.some(
    (q) => !q.negated && q.key === "is" && normalizeQualifierValue(q.value) === "unmerged",
  );

  if (hasUnmergedFilter && (input.state === "merged" || input.mergedWithinDays !== undefined)) {
    issues.push(
      "`is:unmerged` conflicts with merged PR filters — remove it or search closed/unmerged PRs without `state:'merged'` or `mergedWithinDays`.",
    );
  }

  // `state:` accepts only open/closed; other values silently match nothing.
  // The sanitizer folds the valid ones, so any `state:` left here is bad.
  const badStateValues = [
    ...new Set(
      qualifiers
        .filter((q) => q.key === "state" && !isRecognizedIsState(normalizeQualifierValue(q.value)))
        .map((q) => `${q.raw}:${q.value}`),
    ),
  ];

  if (badStateValues.length > 0) {
    issues.push(
      `Unrecognized GitHub state value(s) in \`query\`: ${badStateValues.join(", ")}. ` +
        "GitHub's `state:` accepts only `open` or `closed`. Use the structured `state` field " +
        "(`open`/`closed`/`merged`/`all`) for the state filter.",
    );
  }

  // `type` always emits `is:pr` or `is:issue`, so `-is:pr` guarantees zero matches.
  // The sanitizer keeps negations, so reject here and point at `type`.
  const negatedTypeQualifiers = [
    ...new Set(
      qualifiers
        .filter(
          (q) =>
            q.negated &&
            q.key === "is" &&
            (normalizeQualifierValue(q.value) === "pr" ||
              normalizeQualifierValue(q.value) === "issue"),
        )
        .map((q) => `-is:${normalizeQualifierValue(q.value)}`),
    ),
  ];

  if (negatedTypeQualifiers.length > 0) {
    issues.push(
      `Negated type qualifier(s) in \`query\`: ${negatedTypeQualifiers.join(", ")}. ` +
        "The `type` field always emits an `is:pr`/`is:issue` clause, so a negated one " +
        "contradicts it and matches nothing. Use the structured `type` field instead " +
        "(to exclude PRs set `type:'issue'`; to exclude issues set `type:'pr'`).",
    );
  }

  // 1. Invented qualifiers (`merged-by:`): GitHub returns a silent zero.
  const unknown = [
    ...new Set(qualifiers.filter((q) => !GITHUB_PR_SEARCH_QUALIFIERS.has(q.key)).map((q) => q.raw)),
  ];

  if (unknown.length > 0) {
    issues.push(
      `Unknown GitHub search qualifier(s) in \`query\`: ${unknown.join(", ")}. ` +
        "GitHub silently ignores qualifiers it doesn't recognize and returns zero matches, " +
        "so an invented qualifier reads as a real but empty result. Use only real qualifiers " +
        "(e.g. repo:, label:, review:); for author, state, and recency use the structured fields.",
    );
  }

  // A free-form window joins with AND, but structured windows form one OR group,
  // so mixing them drops items. Duplicates were already stripped, and folding a
  // different event would widen the search. Reject and name the field.
  const setWindows = GITHUB_SEARCH_WINDOWS.filter(
    (entry) => githubSearchWindowDays(input, entry) !== undefined,
  );

  if (setWindows.length > 0) {
    const freeFormWindows = [
      ...new Set(
        qualifiers
          .filter(
            (q) => !q.negated && isWindowQualifier(q.key) && isValidDateQualifierValue(q.value),
          )
          .map((q) => `${q.raw}:${q.value}`),
      ),
    ];

    if (freeFormWindows.length > 0) {
      issues.push(
        `\`query\` mixes a free-form date window with a structured one: ${freeFormWindows.join(", ")}. ` +
          "GitHub joins top-level tokens with AND, while the *WithinDays fields combine as OR, so " +
          "the two together match only items that did BOTH. Express every window through the " +
          "structured fields (`activeWithinDays` for any activity), or set none of them and put " +
          "the whole range in `query`.",
      );
    }
  }

  // A malformed date operator (`closed:>`) makes GitHub reject the whole request.
  // A valid date window in `query` is fine for explicit ranges.
  const malformedDateQualifiers = qualifiers
    .filter((q) => isWindowQualifier(q.key) && !isValidDateQualifierValue(q.value))
    .map((q) => `${q.raw}:${q.value}`);

  if (malformedDateQualifiers.length > 0) {
    issues.push(
      `Malformed GitHub date qualifier value(s) in \`query\`: ${malformedDateQualifiers.join(", ")}. ` +
        "Use ISO 8601 dates/times such as `merged:>=2026-06-01`, " +
        "`closed:2026-06-01..2026-06-30`, or the structured *WithinDays fields for relative windows.",
    );
  }

  return issues;
}

export interface SanitizedGithubSearchQuery {
  sanitized: GithubSearchQueryContext;
  /** For logs. */
  stripped: string[];
}

/**
 * Fold colliding qualifiers into the structured fields (ADR-0071): `author:`,
 * `state:`/`is:` states, `is:`/`type:` pr or issue, and a date window that
 * duplicates a set `*WithinDays`. Other date windows stay. Invented keys and bad
 * dates stay for {@link githubSearchQueryIssues} to reject.
 */
export function sanitizeGithubSearchQuery(
  input: GithubSearchQueryContext,
): SanitizedGithubSearchQuery {
  const sanitized: GithubSearchQueryContext = { ...input };
  const stripped: string[] = [];
  const query = input.query?.trim();

  if (!query) return { sanitized, stripped };

  const qualifiers = parseSearchQualifiers(query);
  const toRemove: ParsedQualifier[] = [];

  const hasStructuredWindow = (entry: GithubSearchWindowEntry): boolean =>
    githubSearchWindowDays(input, entry) !== undefined;

  for (const q of qualifiers) {
    // Folding an exclusion would invert it. GitHub reads the `-` directly.
    if (q.negated) continue;

    if (q.key === "author") {
      sanitized.author = cleanQualifierValue(q.value) || sanitized.author;
      toRemove.push(q);
      continue;
    }

    if (q.key === "state") {
      const v = normalizeQualifierValue(q.value);

      if (isRecognizedIsState(v)) {
        sanitized.state = v;
        toRemove.push(q);
      }

      // Not folded and not stripped: `githubSearchQueryIssues` rejects it.
      continue;
    }

    if (q.key === "is") {
      const v = normalizeQualifierValue(q.value);

      if (v === "pr") {
        sanitized.type = sanitized.type === "issue" ? "both" : "pr";
        toRemove.push(q);
      } else if (v === "issue") {
        sanitized.type = sanitized.type === "pr" ? "both" : "issue";
        toRemove.push(q);
      } else if (isRecognizedIsState(v)) {
        sanitized.state = v;
        toRemove.push(q);
      }

      // Other `is:` values (`is:draft`) are valid filters.
      continue;
    }

    if (q.key === "type") {
      // `type:` is GitHub's synonym for `is:`. Left alone, it leaks through as text
      // beside the default `is:pr` and gives the wrong count (#276).
      const v = normalizeQualifierValue(q.value);

      if (v === "pr") {
        sanitized.type = sanitized.type === "issue" ? "both" : "pr";
        toRemove.push(q);
      } else if (v === "issue") {
        sanitized.type = sanitized.type === "pr" ? "both" : "issue";
        toRemove.push(q);
      }

      continue;
    }

    const entry = windowEntry(q.key);

    if (entry && hasStructuredWindow(entry) && isValidDateQualifierValue(q.value)) {
      // The structured window wins.
      toRemove.push(q);
      continue;
    }
  }

  if (toRemove.length > 0) {
    sanitized.query = stripQualifiers(query, toRemove);

    for (const q of toRemove) stripped.push(`${q.raw}:${q.value}`);
  }

  return { sanitized, stripped };
}

/**
 * Drop the folded tokens, matched by token identity, never by substring.
 * Each takes its binding operator with it, so a meaningful operator between two
 * kept tokens stays: `(NOT is:draft) closed:>=X` keeps the `NOT`.
 */
function stripQualifiers(query: string, toRemove: readonly ParsedQualifier[]): string | undefined {
  const drop = new Set(toRemove.map(qualifierIdentity));
  // A fresh instance: the shared global regex has its own `lastIndex`.
  const scanner = new RegExp(QUALIFIER_STRIP_RE.source, QUALIFIER_STRIP_RE.flags);

  const out = query.replace(
    scanner,
    (match, boundary: string, _operator: string, token: string, name: string) => {
      const negated = token.startsWith("-");
      const value = token.slice(token.indexOf(":") + 1);
      const identity = qualifierIdentity({ key: name.toLowerCase(), value, negated });

      // Keep the boundary so neighbouring tokens do not fuse.
      return drop.has(identity) ? boundary : match;
    },
  );

  return tidyBooleanResidue(out);
}

/**
 * Remove a leading `AND`/`OR` in a group and empty `()` groups, to a fixed point.
 * `NOT` is not listed: it can open a group.
 */
function tidyBooleanResidue(query: string): string | undefined {
  let cleaned = query;

  for (;;) {
    const next = cleaned
      .replace(/\(\s*(?:AND|OR)\s+/g, "(")
      .replace(/\(\s*\)/g, " ")
      // Whitespace beside a parenthesis means nothing to GitHub, and closing it keeps
      // the query identical to the one a clean input builds.
      .replace(/\(\s+/g, "(")
      .replace(/\s+\)/g, ")")
      // drift-ok: GitHub parses these bytes as query grammar, not display text.
      .replace(/\s{2,}/g, " ")
      .replace(/^\s*(AND|OR|NOT)\s+/i, "")
      .replace(/\s+(AND|OR|NOT)\s*$/i, "")
      .trim();

    if (next === cleaned) break;
    cleaned = next;
  }

  return cleaned.length > 0 ? cleaned : undefined;
}
