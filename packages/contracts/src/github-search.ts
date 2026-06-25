/**
 * GitHub search query hardening (issue #213 + GROUND; extended by ADR-0071).
 *
 * The boss appends free-form qualifiers to `github.search`'s `query` field.
 * Two failure modes have bitten us in prod:
 *
 *  - **Invented qualifiers.** The model wrote `merged-by:@me` — GitHub has no
 *    `merged-by:` qualifier. GitHub does NOT error on an unknown qualifier; it
 *    silently demotes it to a free-text term, matches nothing, and returns
 *    `total_count: 0`. The tool call therefore "succeeds" with a zero count and
 *    the boss reports "0 PRs" with no signal that its query was malformed.
 *  - **Structured-field collisions.** The model free-typed `is:pr`, `author:`,
 *    `state:`, or a `closed:>` / `merged:>=` window that the structured fields
 *    already emit — producing duplicate or conflicting clauses and
 *    non-deterministic counts (the observed 19-vs-23 gap across two identical
 *    questions, #213). The boss **re-trips this every turn** (it re-derives the
 *    query from scratch and never carries the lesson forward).
 *
 * Two layers, per ADR-0071:
 *  - {@link sanitizeGithubSearchQuery} — **sanitize-and-merge**: strip the
 *    colliding `author:`/`is:`/`state:`/date qualifiers out of the freeform
 *    query and fold their intent into the structured fields, turning the
 *    re-tripped collision into *silent correctness* rather than a hard error +
 *    wasted retry. This is the robust lever #213 itself proposed.
 *  - {@link githubSearchQueryIssues} — **reject** only what sanitize can't
 *    safely fix: invented qualifier *keys* (the silent-zero trap), malformed
 *    date *values* (GitHub 422s), and genuinely contradictory structured
 *    field combinations. The boss reads the joined message and retries.
 *
 * Pure string logic — no Date, no server imports — so it lives in the web-safe
 * contracts package and is unit-testable in isolation.
 */

/**
 * Real GitHub issue/PR search qualifiers the boss may append verbatim to the
 * `query` field. Sourced from GitHub's "Searching issues and pull requests"
 * docs — spans both issues (`is:issue`, `label:`, `state:`, `reason:`) and PRs.
 * Anything not here is treated as invented and rejected.
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
  /**
   * Whether the qualifier was negated (`-author:octocat`). GitHub treats a
   * leading `-` as exclusion; the structured fields only express inclusion, so
   * a negated qualifier is never folded — it stays in the free-form query.
   */
  negated: boolean;
}

/**
 * Stable identity for a parsed token: `<negated?>-<key>:<value>`. Lets
 * {@link stripQualifiers} re-tokenize the query with the same scanner and drop
 * only the exact tokens that were folded, never a naive substring (so `is:pr`
 * cannot clip `is:private`) and never the opposite polarity.
 */
function qualifierIdentity(q: Pick<ParsedQualifier, "key" | "value" | "negated">): string {
  return `${q.negated ? "-" : ""}${q.key}:${q.value}`;
}

/** Pull the `qualifier:` heads out of a free-form query; bare words are skipped. */
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

const DATE_QUALIFIERS = new Set(["created", "closed", "merged"]);
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

export interface GithubSearchQueryContext {
  /** Whether the search targets issues, PRs, or both. Owns the `is:pr`/`is:issue` clause. */
  type?: GithubSearchType;
  author?: string;
  state?: GithubSearchState;
  query?: string;
  closedWithinDays?: number;
  createdWithinDays?: number;
  mergedWithinDays?: number;
}

/**
 * Validate the structured fields and the residue of the free-form `query` that
 * {@link sanitizeGithubSearchQuery} cannot safely auto-fix. Returns a list of
 * human-readable problems (empty when clean) — the schema joins them into one
 * `invalid_input` message the boss reads and retries against.
 *
 * Run this against the **sanitized** input: collisions the sanitizer strips
 * (free-typed `author:`/`state:`/`is:`/redundant date windows) are silently
 * corrected and never surface here; what remains is the genuinely
 * unresolvable class — invented keys, malformed date values, and contradictory
 * field combinations.
 */
export function githubSearchQueryIssues(input: GithubSearchQueryContext): string[] {
  const query = input.query?.trim();
  const issues: string[] = [];
  const qualifiers = query ? parseSearchQualifiers(query) : [];

  // Logical contradictions between structured fields — sanitize can't resolve
  // these (there is no single correct intent), so they stay hard rejections.
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
  // `is:unmerged` in `query` while merged filters are set is a true semantic
  // contradiction (a PR can't be both) — sanitize can't pick a side, so reject.
  const hasUnmergedFilter = qualifiers.some(
    (q) => q.key === "is" && normalizeQualifierValue(q.value) === "unmerged",
  );
  if (hasUnmergedFilter && (input.state === "merged" || input.mergedWithinDays !== undefined)) {
    issues.push(
      "`is:unmerged` conflicts with merged PR filters — remove it or search closed/unmerged PRs without `state:'merged'` or `mergedWithinDays`.",
    );
  }

  // 1. Invented qualifiers (the `merged-by:` bug) — the silent zero-count trap.
  //    Sanitize cannot guess the intent of a non-existent qualifier, so reject.
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

  // Malformed date comparison operators (`closed:>`, `merged:>=`) make GitHub
  // reject the whole request — catch them before the network call. (A valid
  // date window in `query` is legitimate for explicit ranges the relative
  // *WithinDays fields can't express.)
  const malformedDateQualifiers = qualifiers
    .filter((q) => DATE_QUALIFIERS.has(q.key) && !isValidDateQualifierValue(q.value))
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
  /** The input with colliding qualifiers folded into structured fields. */
  sanitized: GithubSearchQueryContext;
  /** The qualifier tokens lifted out of the free-form `query`, for logging. */
  stripped: string[];
}

const STATE_FROM_IS: Record<string, GithubSearchState> = {
  open: "open",
  closed: "closed",
  merged: "merged",
};

/**
 * Strip the structured-field collisions out of the free-form `query` and fold
 * their intent into the structured fields (ADR-0071 sanitize-and-merge):
 *
 *  - `author:X`           → set `author` (the explicit value the model typed
 *                            wins over the field default), drop from `query`.
 *  - `state:S` / `is:S`   → set `state` from `open`/`closed`/`merged`, drop.
 *  - `is:pr` / `is:issue` → set `type`, drop (owned by the `type` field now).
 *  - `created:`/`closed:`/`merged:` date window that **duplicates** a set
 *    *WithinDays field → drop the free-form one (the structured window wins).
 *    A date window with *no* corresponding field is a legitimate explicit
 *    range the relative fields can't express, so it is **kept**.
 *
 * Invented keys and malformed date values are left in place for
 * {@link githubSearchQueryIssues} to reject — they have no safe auto-fix.
 */
export function sanitizeGithubSearchQuery(
  input: GithubSearchQueryContext,
): SanitizedGithubSearchQuery {
  const sanitized: GithubSearchQueryContext = { ...input };
  const stripped: string[] = [];
  const query = input.query?.trim();
  if (!query) return { sanitized, stripped };

  const qualifiers = parseSearchQualifiers(query);
  // Tokens (qualifier:value, as written) to remove from the free-form query.
  const toRemove: ParsedQualifier[] = [];

  const windowFieldSet: Record<string, boolean> = {
    closed: input.closedWithinDays !== undefined,
    created: input.createdWithinDays !== undefined,
    merged: input.mergedWithinDays !== undefined,
  };

  for (const q of qualifiers) {
    // A negated qualifier is an exclusion (`-author:octocat`, `-label:wontfix`)
    // that the inclusion-only structured fields cannot represent. Folding it
    // would silently invert the user's intent, so leave it verbatim in the
    // free-form query — GitHub understands the `-` directly.
    if (q.negated) continue;
    if (q.key === "author") {
      sanitized.author = cleanQualifierValue(q.value) || sanitized.author;
      toRemove.push(q);
      continue;
    }
    if (q.key === "state") {
      const v = normalizeQualifierValue(q.value);
      if (STATE_FROM_IS[v]) sanitized.state = STATE_FROM_IS[v];
      toRemove.push(q);
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
      } else if (STATE_FROM_IS[v]) {
        sanitized.state = STATE_FROM_IS[v];
        toRemove.push(q);
      }
      // Other `is:` values (is:draft, is:queued, …) are valid extra filters; keep.
      continue;
    }
    if (DATE_QUALIFIERS.has(q.key) && windowFieldSet[q.key] && isValidDateQualifierValue(q.value)) {
      // Duplicates a structured window — the field wins; drop the free-form one.
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
 * Remove the given folded `qualifier:value` tokens from the query string and
 * tidy the leftover whitespace and now-empty boolean groups.
 *
 * Re-tokenizes with the SAME scanner the parse used and drops only whole
 * qualifier tokens whose identity is in `toRemove`. A naive `split(token)`
 * would clip prefixes (`is:pr` inside `is:private`) and miss/garble the `-`
 * negation; matching on the scanner's token boundaries + the negation-aware
 * identity avoids both.
 */
function stripQualifiers(query: string, toRemove: readonly ParsedQualifier[]): string | undefined {
  const drop = new Set(toRemove.map(qualifierIdentity));
  // A fresh regex instance: QUALIFIER_SCAN_RE is global and module-shared, so
  // reusing it in `.replace` could collide with another scan's `lastIndex`.
  const scanner = new RegExp(QUALIFIER_SCAN_RE.source, QUALIFIER_SCAN_RE.flags);
  const out = query.replace(scanner, (match, boundary: string, token: string, name: string) => {
    const negated = token.startsWith("-");
    const value = token.slice(token.indexOf(":") + 1);
    const identity = qualifierIdentity({ key: name.toLowerCase(), value, negated });
    // Keep the leading boundary char (space/`(`/start) so neighbouring tokens
    // don't fuse; drop the qualifier itself when it was folded.
    return drop.has(identity) ? boundary : match;
  });
  const cleaned = out
    // Collapse whitespace and drop dangling boolean operators / empty groups.
    .replace(/\s+(AND|OR|NOT)\s+/g, " ")
    .replace(/\(\s*\)/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^\s*(AND|OR|NOT)\s+/i, "")
    .replace(/\s+(AND|OR|NOT)\s*$/i, "")
    .trim();
  return cleaned.length > 0 ? cleaned : undefined;
}
