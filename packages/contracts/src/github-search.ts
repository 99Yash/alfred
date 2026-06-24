/**
 * GitHub PR-search qualifier hardening (issue #213 + GROUND).
 *
 * The boss appends free-form qualifiers to `github.search_pull_requests`'s
 * `query` field. Two failure modes have bitten us in prod:
 *
 *  - **Invented qualifiers.** The model wrote `merged-by:@me` — GitHub has no
 *    `merged-by:` qualifier. GitHub does NOT error on an unknown qualifier; it
 *    silently demotes it to a free-text term, matches nothing, and returns
 *    `total_count: 0`. The tool call therefore "succeeds" with a zero count and
 *    the boss reports "0 PRs" with no signal that its query was malformed.
 *  - **Structured-field collisions.** The model free-typed `is:pr`, `author:`,
 *    or a `closed:>` / `closed:>=` window that the structured fields already
 *    emit — producing duplicate or conflicting clauses and non-deterministic
 *    counts (the observed 19-vs-23 gap across two identical questions, #213).
 *
 * We reject both at schema-validation time so the dispatcher returns an
 * actionable `invalid_input` the boss can correct, instead of a confidently
 * wrong answer. Pure string logic — no Date, no server imports — so it lives in
 * the web-safe contracts package and is unit-testable in isolation.
 */

/**
 * Real GitHub issue/PR search qualifiers the boss may append verbatim to the
 * `query` field. Sourced from GitHub's "Searching issues and pull requests"
 * docs. Anything not here is treated as invented and rejected.
 */
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

/**
 * Pull qualifier heads out of a GitHub search string. Qualifiers can appear in
 * nested boolean groups, e.g. `(label:bug OR review-requested:@me)`, so a
 * parser that only checks the beginning of a whitespace token would miss the
 * original failure class when the model wraps it in parentheses.
 */
const QUALIFIER_SCAN_RE = /(^|[\s(])(-?([A-Za-z][\w-]*):(?:"[^"]*"|[^\s)]*))/g;

export interface ParsedQualifier {
  /** Qualifier name as written, e.g. `merged-by`. */
  raw: string;
  /** Lower-cased name for whitelist lookup. */
  key: string;
  /** Raw value after the `:`. Only interpreted for known managed qualifiers. */
  value: string;
}

/** Pull the `qualifier:` heads out of a free-form query; bare words are skipped. */
export function parseSearchQualifiers(query: string): ParsedQualifier[] {
  const out: ParsedQualifier[] = [];
  for (const match of query.matchAll(QUALIFIER_SCAN_RE)) {
    const raw = match[3]!;
    const token = match[2]!;
    const value = token.slice(token.indexOf(":") + 1);
    out.push({ raw, key: raw.toLowerCase(), value });
  }
  return out;
}

/** Human-readable name of the structured field that owns each managed qualifier. */
const MANAGED_BY_FIELD: Record<string, string> = {
  is: "the `state` field",
  state: "the `state` field",
  author: "the `author` field",
  closed: "the `closedWithinDays` field",
  created: "the `createdWithinDays` field",
  merged: "the `mergedWithinDays` field",
};

const STRUCTURED_IS_VALUES = new Set(["pr", "issue", "open", "closed", "merged"]);

function normalizeQualifierValue(value: string): string {
  return value
    .trim()
    .replace(/^[("']+/, "")
    .replace(/[)"']+$/, "")
    .toLowerCase();
}

export interface PullRequestQueryContext {
  query?: string;
  closedWithinDays?: number;
  createdWithinDays?: number;
  mergedWithinDays?: number;
}

/**
 * Validate the free-form `query` against the structured fields. Returns a list
 * of human-readable problems (empty when the query is clean) — the schema joins
 * them into one `invalid_input` message the boss reads and retries against.
 */
export function pullRequestQueryIssues(input: PullRequestQueryContext): string[] {
  const query = input.query?.trim();
  if (!query) return [];
  const issues: string[] = [];
  const qualifiers = parseSearchQualifiers(query);

  // 1. Invented qualifiers (the `merged-by:` bug) — the silent zero-count trap.
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

  // 2. `author:` / `state:` are always represented by structured fields — any
  //    free-form occurrence duplicates or conflicts with them.
  for (const key of ["author", "state"] as const) {
    if (qualifiers.some((q) => q.key === key)) {
      issues.push(
        `Don't put \`${key}:\` in \`query\` — set ${MANAGED_BY_FIELD[key]} instead (it is applied automatically).`,
      );
    }
  }
  // `is:` is a broad GitHub qualifier. Only the type/state values collide with
  // this tool's structured fields; other values such as `is:draft` are valid
  // extra filters.
  if (
    qualifiers.some(
      (q) => q.key === "is" && STRUCTURED_IS_VALUES.has(normalizeQualifierValue(q.value)),
    )
  ) {
    issues.push(
      "Don't put `is:` PR/type/state filters in `query` — set the `state` field instead (`is:pr` is applied automatically).",
    );
  }

  // 3. A free-form date window AND its structured field both set => conflicting
  //    boundaries (the #213 19-vs-23 bug). The structured field wins; pick one.
  const windowFields: Array<[string, number | undefined]> = [
    ["closed", input.closedWithinDays],
    ["created", input.createdWithinDays],
    ["merged", input.mergedWithinDays],
  ];
  for (const [key, field] of windowFields) {
    if (field !== undefined && qualifiers.some((q) => q.key === key)) {
      issues.push(
        `\`${key}:\` in \`query\` conflicts with the \`${key}WithinDays\` field — use one, not both.`,
      );
    }
  }

  return issues;
}
