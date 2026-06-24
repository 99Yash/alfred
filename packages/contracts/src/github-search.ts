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
  "no",
  "sort",
  "created",
  "updated",
  "closed",
  "merged",
  "archived",
]);

/**
 * Tokenize a GitHub search string into top-level tokens, keeping a
 * double-quoted run (e.g. `label:"good first issue"`) as one token so its
 * spaces don't split it.
 */
const SEARCH_TOKEN_RE = /(?:-?[\w-]+:)?"[^"]*"|\S+/g;
/** A token shaped like `qualifier:` (optionally negated `-qualifier:`). */
const QUALIFIER_RE = /^-?([A-Za-z][\w-]*):/;

export interface ParsedQualifier {
  /** Qualifier name as written, e.g. `merged-by`. */
  raw: string;
  /** Lower-cased name for whitelist lookup. */
  key: string;
}

/** Pull the `qualifier:` heads out of a free-form query; bare words are skipped. */
export function parseSearchQualifiers(query: string): ParsedQualifier[] {
  const out: ParsedQualifier[] = [];
  for (const token of query.match(SEARCH_TOKEN_RE) ?? []) {
    const match = QUALIFIER_RE.exec(token);
    if (!match) continue; // bare free-text term — fine
    out.push({ raw: match[1]!, key: match[1]!.toLowerCase() });
  }
  return out;
}

/** Human-readable name of the structured field that owns each managed qualifier. */
const MANAGED_BY_FIELD: Record<string, string> = {
  is: "the `state` field",
  author: "the `author` field",
  closed: "the `closedWithinDays` field",
  created: "the `createdWithinDays` field",
  merged: "the `mergedWithinDays` field",
};

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
    ...new Set(
      qualifiers.filter((q) => !GITHUB_PR_SEARCH_QUALIFIERS.has(q.key)).map((q) => q.raw),
    ),
  ];
  if (unknown.length > 0) {
    issues.push(
      `Unknown GitHub search qualifier(s) in \`query\`: ${unknown.join(", ")}. ` +
        "GitHub silently ignores qualifiers it doesn't recognize and returns zero matches, " +
        "so an invented qualifier reads as a real but empty result. Use only real qualifiers " +
        "(e.g. repo:, label:, review:); for author, state, and recency use the structured fields.",
    );
  }

  // 2. `is:` / `author:` are always emitted from the structured fields — any
  //    free-form occurrence duplicates or conflicts with them.
  for (const key of ["is", "author"] as const) {
    if (qualifiers.some((q) => q.key === key)) {
      issues.push(
        `Don't put \`${key}:\` in \`query\` — set ${MANAGED_BY_FIELD[key]} instead (it is applied automatically).`,
      );
    }
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
