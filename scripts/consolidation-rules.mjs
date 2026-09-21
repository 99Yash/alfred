// The single table of "we already have a helper for this" facts.
//
// One table, two consumers, so the fact cannot drift between them:
//   - `check-consolidation-drift.mjs` runs the `gate` rules in `pnpm check`.
//     A match fails the build the same way a type error does.
//   - `.claude/hooks/helper-hints.mjs` runs *every* rule against the text an
//     agent is about to write, and injects `fix` before the edit lands.
//
// Two severities, because the two consumers can afford different strictness:
//   - "gate": fully consolidated to one owner, so a match is unambiguously
//     drift rather than un-migrated legacy. Fails `pnpm check`.
//   - "hint": the canonical helper exists and is preferred, but enough legacy
//     call sites remain (or the pattern is broad enough) that banning it would
//     gate on a migration. Advisory at edit time only; never fails a build.
//
// A row here replaces a row in the root CLAUDE.md "reach for…" table. That is
// the point: a fact enforced by a check does not also need to be prose that
// every session pays for and nothing keeps current. When a "hint" row's legacy
// call sites reach zero, promote it to "gate" and delete its prose row too.
//
// Escape hatch: append `// drift-ok: <reason>` to a line. An empty marker is
// itself drift: exemptions must explain the lock/property that makes them safe.

/**
 * @typedef {object} ConsolidationRule
 * @property {string}   id        Stable slug, used in hook output.
 * @property {RegExp}   re        Matched per line, or against whole file text
 *                                when `scope` is "chain".
 * @property {"gate"|"hint"} severity
 * @property {"line"|"chain"} [scope] Default "line". "chain" for an idiom that
 *                                a formatter splits across lines — see
 *                                {@link matchChains}.
 * @property {string}   fix       What to reach for instead.
 * @property {string[]} [owners]  Repo-relative files that legitimately contain
 *                                the idiom (the helper's own definition, its
 *                                doc-comment example, or the sanctioned reader).
 *                                Scoped per rule: owning `toStringArray` does
 *                                not license every other idiom in that file.
 *                                Prefer a per-line `// drift-ok: <reason>` when
 *                                the file holds both sanctioned and new call
 *                                sites — a whole-file exemption blinds the rule
 *                                exactly where the next mistake will be made.
 * @property {RegExp}   [paths]   The files this rule applies to, INSTEAD of the
 *                                global {@link isSkippedPath} filter. A rule
 *                                that names `paths` sees exactly the files that
 *                                regex admits; a rule that omits it sees exactly
 *                                the files `isSkippedPath` admits. This is how a
 *                                rule reaches a test tree without handing every
 *                                other rule the same file population — see
 *                                {@link isScannedPath}.
 */

/**
 * The slug and provider unions the integration registry derives (ADR-0093):
 * `IntegrationSlug` and every `*IntegrationSlug`, the status and kind unions,
 * the credential-shape unions, the passthrough unions, and the two provider
 * unions. `SupportedIntegrationSlug` and `BearerProvider` are the transition
 * aliases PR 4 of the registry plan deletes. Exported for the self-test, which
 * proves every `export type …Slug` in `slugs.ts` matches it.
 */
export const REGISTRY_UNION = String.raw`(?:(?:\w*Integration|LiveProvider|Planned|Catalog|Google|GithubApp|Bearer|TokenPaste|Supported\w*)Slug|(?:Bearer|Credential)Provider)`;

/** @type {ConsolidationRule[]} */
export const RULES = [
  {
    id: "unfiltered-event-receipt-read",
    re: /\.(?:from|(?:left|right|inner|full)Join)\(\s*eventReceipts\b/,
    scope: "chain",
    severity: "gate",
    owners: [
      "packages/db/src/schema/integrations.ts",
      "packages/assistant/src/connections/ingestion/inbound-receive.ts",
      "packages/assistant/src/connections/ingestion/inbound-deliver.ts",
      "packages/assistant/src/connections/raw-receipt-inventory.ts",
      "packages/assistant/src/connections/ingestion/receipt-corpus-backfill.ts",
    ],
    fix: "Read typedEventReceipts from @alfred/db/schemas. Only the view definition, receipt conflict read-back, the deliver job (publishes both tiers), raw inventory, and corpus backfill may read both tiers of eventReceipts.",
  },
  {
    id: "humanize-integration-slug",
    // `humanizeSlug(tool.integration)` / `humanizeSlug(integration)` — title-casing
    // an integration slug renders `github` as "Github" and `imessage` as "Imessage".
    re: /\bhumanizeSlug\(\s*[\w.]*\bintegration\b/,
    severity: "gate",
    fix: "Index INTEGRATION_DISPLAY_NAMES[slug] from @alfred/contracts with a typed IntegrationSlug, or call integrationDisplayName(value) for an unchecked string. humanizeSlug is for action and field slugs, not integration names.",
  },
  {
    id: "partial-integration-slug-record",
    // `Partial<Record<IntegrationSlug, …>>` / `new Map<string, LoadableIntegrationSlug>` —
    // a table keyed by integration slug that the compiler cannot prove complete.
    // Three web tables shipped without `notion`/`railway`/`vercel` rows this way
    // (PR #943); the registry (ADR-0093) exists so a missing row is a type error.
    // Every union the registry derives (`packages/contracts/src/integrations/slugs.ts`)
    // and its two transition aliases are the same bug as the key of a Partial,
    // or as the key or value of a Map written as a literal (`new Map<…>([`).
    // A Map filled at request time is a lookup index, not a table, and is left
    // alone; so is a union that is not an integration slug (`GatherSourceSlug`).
    // The self-test reads `slugs.ts` and fails when a union there escapes
    // REGISTRY_UNION, so this alternation cannot lag the registry.
    re: new RegExp(
      String.raw`Partial<Record<${REGISTRY_UNION}\b|new Map<${REGISTRY_UNION},.*?>\(\[|new Map<string,\s*${REGISTRY_UNION}\b.*?>\(\[`,
    ),
    severity: "gate",
    fix: "Derive the table from INTEGRATIONS in @alfred/contracts (a projection over the record), or key it `satisfies Record<…Slug, T>` on a derived union (LiveProviderSlug, CatalogSlug, SupportedPassthroughSlug) so a missing integration is a compile error. If an absent slug genuinely means something (a sparse per-user override), append `// drift-ok: <what absence means>`.",
  },
  {
    id: "as-string-array",
    // `x as string[]` — the unchecked element-type assertion. `as string[] | ...`
    // (a union) is a different, narrower shape and is left alone.
    re: /\bas\s+string\[\](?!\s*[|&])/,
    severity: "gate",
    owners: ["packages/contracts/src/guards.ts"],
    fix: "Use toStringArray(x) from @alfred/contracts — it checks the element type at runtime instead of asserting it.",
  },
  {
    id: "sql-any-of-interpolated-list",
    // `= ANY(${list})` inside a drizzle sql`` template. Drizzle expands an
    // interpolated JS array to a tuple (`($1, $2, $3)`), so Postgres rejects it
    // with "op ANY/ALL (array) requires array on right side". The briefing
    // sender-significance read failed on every run for weeks this way, and a
    // best-effort catch hid it.
    re: /\bANY\(\$\{/,
    severity: "gate",
    fix: "Use inArray(expr, list) from drizzle-orm inside the template (`WHERE ${inArray(sql`lower(alias)`, list)}`), or pass one array parameter with a cast: `ANY(${sql.param(list)}::text[])`.",
  },
  {
    id: "hand-rolled-object-closure",
    // "Did this object's lifecycle close an already-open ask?" is a PER-KIND
    // policy, not a global category list. A pull request closes on `resolved`
    // and `abandoned`; a CI run and a deployment close on neither, because
    // their state is the outcome of the latest attempt (#1093). A call site
    // that compares `stateCategory` to the two literals, or re-implements the
    // membership test over LOOP_CLOSING_STATE_CATEGORIES, freezes the
    // pull-request policy into itself and reads the next kind wrong.
    // `failed` is the trap that makes this sharp: it is terminal for the
    // object but it OPENS a CI loop, so a hand-rolled "terminal means closed"
    // inverts the meaning of every failing build.
    //
    // The anchor is `\w*[Cc]ategory`, not `stateCategory`, because a local
    // rename is enough to walk out of the fence: the sanctioned reader itself
    // binds `const category = object.stateCategory ?? …` one line before it
    // asks the registry. The anchor is never DROPPED, though — `"resolved"`
    // alone is overloaded about ten times in this tree by an MCP identity
    // status and a join result kind. Every live `*category` comparison tests a
    // triage word (`action_needed`, `awaiting_reply`, `meeting`, `payment`,
    // `urgent`) or a tool lane (`source`, `action`), so the widened anchor
    // costs zero false positives today.
    //
    // Six spellings, because each is a plausible thing to write and each used
    // to pass:
    //   1. `category === "resolved"`, either operand order. No `"` may stand
    //      between the identifier and the literal, or one line holding two
    //      unrelated comparisons matches across the pair — the measured shape
    //      is the ternary `category === "triage" ? "Email" : s === "resolved"`.
    //   2. `category !== "active"` — the inversion, and the worst reading of
    //      the six: it calls a FAILED build closed. Only the negated form is
    //      matched; `=== "active"` is an honest activeness test.
    //   3. the tuple fed to a membership test THROUGH A CAST —
    //      `(LOOP_CLOSING_STATE_CATEGORIES as readonly string[]).includes(x)`
    //      was verbatim the idiom the deleted `isTerminalCategory` used next
    //      to the tuple, so it is the spelling a reader copies first. `.has(`
    //      and `.find(` join `.includes(`, `.indexOf(` and `.some(`, because
    //      `new Set(LOOP_CLOSING_STATE_CATEGORIES).has(category)` is the same
    //      test one character away.
    //   4. an inline array holding BOTH closing literals, fed to the same
    //      membership test. Both literals are required, so the tuple
    //      declarations stay legal.
    //   5. `isTerminalCategory(category)` — a CALL, not a spelling of the
    //      comparison, and shorter than the sanctioned reader. It was a sibling
    //      export over a DIFFERENT tuple, it returned `true` for `failed`, and
    //      it sat in autocomplete at every call site this row protects, so a
    //      row that refused six comparisons and admitted this one call fenced
    //      nothing. The arm stays as a tombstone against reintroduction: the
    //      `function` lookbehind exempts the declaration itself; a caller who
    //      genuinely means "terminal for the object" writes a
    //      `// drift-ok:` marker.
    //   6. `switch (category) { case "resolved": }`, which code-style.md §2
    //      actively prefers for a closed union. This one is why the rule is
    //      `scope: "chain"`: the header and the case land on separate lines,
    //      which a per-line regex cannot see.
    //
    // What the `switch` arm guarantees, exactly: the span between the header
    // and the `case` may not cross a second `switch` keyword, which is what
    // keeps an ADJACENT and a NESTED switch out of the match. The 1500-character
    // bound does something weaker and unrelated — it limits how far apart the
    // header and the case may sit. A bound alone cannot say which `switch` a
    // `case` belongs to. The temper reads `switch` WITH its paren
    // (`switch\s*\(`), because a bare-word temper is evaded by its own keyword
    // inside a string literal in an earlier case body — and a paren-less temper
    // would re-admit the adjacent/nested false positives. A log line holding
    // `switch (` with a paren still breaks the span; that copy is contrived
    // enough to stay a measured residual.
    //
    // The six spellings are the ones an author is most likely to write. They
    // are NOT exhaustive, and this row must not be read as a fence: it is a
    // tier-2 gate, and a novel spelling still compiles. Review round 2
    // measured nine escapes. Closed since, each swept tree-wide at zero false
    // positives before landing:
    //   - a rename to an identifier that does not end in `category` (the
    //     destructuring form included): the `stateCategory` arm below. A rename
    //     almost always happens at an assignment that still reads the field,
    //     which is what the arm exploits — the repo-specific field name, not
    //     `\w+`, because `"resolved"` comparisons are overloaded elsewhere.
    //     The arm as first measured missed the `!== "active"` inversion (its
    //     literal is `active`, not a closing literal), so the inversion rides
    //     its own tail, in both operand orders, as does the reversed
    //     `"resolved" === closed` form.
    //   - a `?? "active"` default under a renamed identifier: the same arm,
    //     because the middle span crosses `;` and quotes to reach the later
    //     `=== "resolved"`.
    //   - a comparison that prettier wraps across two lines: the `"` ban stays
    //     (the two-comparison ternary guard) but `\n` is allowed in the
    //     comparison tails.
    //   - a lookup table (`const CLOSES = { resolved: true, … }`) composed
    //     with a subscript read: the table-then-read arm. A table defined
    //     AFTER the subscript is not covered — use-before-def of a const
    //     table throws, and reassignment-after-read is unobserved.
    //   - a `case "resolved":` past the old 600-character bound: the bound is
    //     1500, and the selftest switch fixture sits past 600 so the cliff is
    //     tested either way.
    // Still residue, measured through `matchChains` (review round 0). The row
    // covers the measured-spelling subset below, not every spelling of the
    // comparison — it is a tier-2 gate, and a novel spelling still compiles:
    //   - a helper-extracted comparison with no nearby `stateCategory` token,
    //     e.g. `isClosed(s: string) { return s === "abandoned"; }`. The rename
    //     bridge needs the field token within 300 chars; a bare annotation
    //     such as `cat: StateCategory` matches only via its own anchor text.
    //   - a single-literal membership: `["resolved"].includes(category)`,
    //     a single-key `Set.has`, or a single-key lookup table plus
    //     subscript. The tuple/inline-array arms require both closing
    //     literals (or both keys).
    //   - a header/case gap: `switch (s)` whose header names no `*Category`,
    //     or `switch (stateCategory)` whose `case` is `"failed"`. The header
    //     needs `*Category`; the case alternation names only
    //     `resolved`/`abandoned` (`failed` opens a CI loop, so fencing it
    //     would conflate openers with closers).
    //   - a 300-char bridge cliff: filler past 300 chars between the
    //     `stateCategory` read and the comparison walks out of the rename
    //     arm. Widening any of these buys the overload the `*Category`
    //     anchor exists to refuse (`"resolved"` is an MCP identity status
    //     and a join result kind elsewhere), so each stays residue with
    //     this reason until its own item probes it.
    // A formatter-split tuple or inline-array membership
    // (`LOOP_CLOSING…\n.includes(`) misses too — queued as its own
    // item, since the fix touches arms this item does not own.
    scope: "chain",
    re: /\b\w*[Cc]ategory\b[^;"]*(?:===|!==)[^;"]*"(?:resolved|abandoned)"|"(?:resolved|abandoned)"[^;"]*(?:===|!==)[^;"]*\b\w*[Cc]ategory\b|\b\w*[Cc]ategory\b\s*!==\s*"active"|"active"\s*!==\s*\w*[Cc]ategory\b|\bLOOP_CLOSING_STATE_CATEGORIES\b[^;\n]*\.\s*(?:includes|indexOf|some|has|find)\(|\[[^\]\n]*"(?:resolved|abandoned)"[^\]\n]*"(?:resolved|abandoned)"[^\]\n]*\][^;\n]*\.\s*(?:includes|indexOf|some|has|find)\(|(?<!function )\bisTerminalCategory\s*\(|\bstateCategory\b[\s\S]{0,300}?(?:===|!==|\.\s*(?:includes|some|indexOf)\(|\bcase\s+)[^;"\n]{0,60}?"(?:resolved|abandoned)"|\bstateCategory\b[\s\S]{0,300}?(?:!==[^;"\n]{0,60}?"active"|"active"[^;"\n]{0,60}?!==)|\bstateCategory\b[\s\S]{0,300}?"(?:resolved|abandoned)"[^;"\n]{0,60}?(?:===|!==)|\{\s*[^};]*\bresolved\b[^};]*\babandoned\b[^};]*\}\s*;?[\s\S]{0,300}?\[\s*\w*[Cc]ategory\s*\]|switch\s*\([^)\n]*\b\w*[Cc]ategory\b[^)\n]*\)\s*\{(?:(?!\bswitch\s*\()[\s\S]){0,1500}?\bcase\s+"(?:resolved|abandoned)"\s*:/,
    severity: "gate",
    fix: "Call closesOpenAsk(provider, kind, category) from @alfred/contracts for a projection row, or evidenceObjectClosesAsk(card.object) for an evidence card. Both read the registry's per-kind closesAskOn, so a kind that closes on neither category stays correct, and both return the closing category rather than a boolean. `failed` closes nothing: it is terminal for the object but it opens a CI loop, which is why a terminal-means-closed helper is not the reader either — if you truly mean terminal for the object and not closed, say so in a `// drift-ok:` marker.",
  },
  {
    id: "canonical-param-key",
    // The `.toLowerCase().replace(/[_-]/g, "")` key-canonicalization idiom.
    re: /\.toLowerCase\(\)\.replace\(\s*\/\[_-\]\/g\s*,\s*""\s*\)/,
    severity: "gate",
    owners: ["packages/contracts/src/tool-schemas.ts"],
    fix: "Use canonicalParamKey(key) from @alfred/contracts — the one canonical key-folding function.",
  },
  {
    id: "hand-split-oauth-scope",
    // The OAuth `scope` response field, split by hand. Two copies existed with
    // two grammars: `/\s+/` in the MCP provider and `/[,\s]+/` in the GitHub
    // App. GitHub returns a COMMA list, so the whitespace-only copy read
    // `repo,read:org` as one opaque scope and every "already granted?" test
    // answered no forever.
    re: /\bscope\w*\b[^;\n]*\.split\(/i,
    severity: "gate",
    owners: ["packages/contracts/src/oauth-scopes.ts"],
    fix: "Use parseOAuthScopeList(scope) from @alfred/contracts — the one grammar that accepts both RFC 6749 space lists and GitHub's comma list.",
  },
  {
    id: "read-write-github-mcp-endpoint",
    // ADR-0094: read-only is a property of the RESOURCE, so the whole rule is
    // the value of one constant. The `/mcp` root and `/mcp/readonly` are two
    // protected resources with two catalogs for the SAME token; the measured
    // counts live on `GITHUB_MCP_ENDPOINT_HREF` and in ADR-0094, and are
    // deliberately not copied here. Nothing in the protocol reports the
    // difference, and the catalog only changes at run time. Without this row, a
    // one-character edit hands the boss a write catalog and every check still
    // passes.
    //
    // `BuiltInDefinition.readOnlyCatalog` now adds a run-time condition on the
    // per-tool `annotations.readOnlyHint`, which catches a write tool served AT
    // the read-only path. It does not replace this row: an edited constant
    // moves Alfred to a resource where every write tool honestly reports
    // `readOnlyHint: false`, and the run-time refusal then reads as an outage
    // instead of a review comment.
    re: /api\.githubcopilot\.com\/mcp(?!\/readonly)/,
    severity: "gate",
    fix: "Use GITHUB_MCP_ENDPOINT_HREF from @alfred/assistant — Alfred pins GitHub's read-only resource `/mcp/readonly` (ADR-0094). The `/mcp` root also serves write tools.",
  },
  {
    id: "hand-rolled-timezone-validator",
    // A hand-rolled `function isValidTimezone` — this exact `Intl.DateTimeFormat`
    // trial was copied verbatim into web, sync, and api before consolidation.
    re: /\bfunction\s+isValidTimezone\b/,
    severity: "gate",
    fix: "Use isIanaTimezone from @alfred/contracts — the one memoized, alias-aware timezone validator. Don't hand-roll an Intl.DateTimeFormat trial.",
  },
  {
    id: "as-tool-name",
    // Zero production call sites: every `as ToolName` left in the tree is in a
    // test fixture, which this check already skips.
    re: /\bas\s+ToolName\b/,
    severity: "gate",
    fix: "Narrow the string with isToolName from @alfred/contracts before indexing a ToolName record or dispatching. Don't assert it.",
  },
  {
    id: "as-loose-record",
    // An assertion from unknown/object to an open record, either directly or
    // inside an Array/ReadonlyArray. Declarations and generic constraints do
    // not match because this is anchored on `as`.
    re: /\bas\s+(?:(?:Readonly)?Array\s*<\s*)?Record\s*<\s*string\s*,\s*unknown\s*>/,
    scope: "chain",
    severity: "gate",
    fix: "Use isRecord/toRecord from @alfred/contracts for a genuine open object, or parse the known projection with its owning schema. An assertion does not validate the boundary.",
  },
  {
    id: "raw-process-env",
    // The repo invariant, promoted out of prose. Only the env package's own
    // schema readers and Drizzle's standalone config may touch process.env;
    // tests//scripts/ are skipped by the path filter, not listed here.
    re: /\bprocess\.env\b/,
    severity: "gate",
    owners: [
      "packages/env/src/server.ts",
      "packages/env/src/database.ts",
      "packages/db/drizzle.config.ts",
    ],
    fix: "Use serverEnv() from @alfred/env/server — the only sanctioned reader of process env. It validates the whole environment once against a schema.",
  },
  {
    id: "error-to-message",
    // `err instanceof Error ? err.message : String(err)`, exactly. Deliberately
    // does NOT match the stack-preferring variant
    // (`err instanceof Error ? (err.stack ?? err.message) : String(err)`) or a
    // domain-specific fallback (`: "Invalid JSON"`), which are different calls.
    re: /instanceof\s+Error\s*\?\s*\w+\.message\s*:\s*String\(/,
    severity: "gate",
    owners: ["packages/contracts/src/errors.ts"],
    fix: "Use toMessage(err) from @alfred/contracts — the one caught-error-to-string helper.",
  },
  {
    id: "hand-built-api-error",
    // Ten `class XError extends ApiError` subclasses re-encoded API_ERROR_CODES
    // and each had to be imported by name; the codes are now the only encoding
    // and `Errors` is the only door. Both drift shapes: a fresh subclass, and a
    // direct `new ApiError(...)` that pairs a message with a code by hand.
    re: /\bnew\s+ApiError\s*\(|\bextends\s+ApiError\b/,
    severity: "gate",
    owners: ["packages/contracts/src/api-errors.ts"],
    fix: 'Throw an Errors.* factory from @alfred/contracts — `throw Errors.NotFoundError("…")`. It owns the code-to-status pairing. Catch with isApiError(err, "NOT_FOUND") rather than a per-kind class.',
  },
  {
    id: "boot-error-plain-extends",
    // A handler-registry "not registered" boot error named `No…RegisteredError`
    // must extend TriggerConsumerBootError, not plain Error. The publish seam
    // (triggers/internal/consumer-registry.ts) swallows a `best-effort`
    // consumer's rejection UNLESS it is a TriggerConsumerBootError — so a boot
    // error that forgot the base is silently downgraded to a no-op'd wiring
    // failure, the exact "a wiring failure no-ops instead of failing the job"
    // bug the best-effort seam exists to prevent. Membership was Tier-5
    // (convention only); this gates the `No…RegisteredError` naming convention +
    // the default `extends Error` form. Safe against the members:
    // `extends TriggerConsumerBootError` has a non-`Error` token after
    // `extends `, and the base class is named `TriggerConsumerBootError`, not
    // `No…RegisteredError`, so it never self-matches.
    re: /class\s+No\w*RegisteredError\s+extends\s+Error\b/,
    severity: "gate",
    fix: 'A handler-registry boot error must `extends TriggerConsumerBootError` (import it from the triggers barrel, `from "@alfred/assistant/triggers"`), not plain Error — the publish seam only exempts a TriggerConsumerBootError from the best-effort swallow, so a plain-Error boot failure is silently no-op\'d instead of failing the job. If this No…RegisteredError is a runtime not-found rather than a registry-wiring boot error, append `// drift-ok: <reason>`.',
  },

  // ---- hints: canonical helper exists, legacy call sites remain -------------
  {
    id: "hand-rolled-record-guard",
    re: /typeof\s+(\w+)\s*===\s*["']object["']\s*&&\s*\1\s*!==\s*null/,
    severity: "hint",
    fix: "isRecord(x) from @alfred/contracts is this check. Use toRecord(x) if you want a Record or {} back rather than a boolean.",
  },
  {
    id: "raw-json-parse",
    re: /\bJSON\.parse\(/,
    severity: "hint",
    fix: "parseJsonWith(raw, schema, fallback?) from @alfred/contracts parses AND validates in one step; safeJsonParse(raw) handles malformed input without a try/catch. Reach for those before JSON.parse + a cast.",
  },
  {
    id: "raw-intl-timezone",
    re: /new\s+Intl\.DateTimeFormat\(/,
    severity: "hint",
    owners: ["packages/assistant/src/time/local-time.ts"],
    fix: '@alfred/assistant/time owns every date/zone reading, split by one question: does the reading need a zone? NEEDS ONE — inZone(tz) binds it once and every reading is a method: .day() mints the LocalDateKey, .hour(), .offsetMs(), .clock(), .startOf(key, hour?), .dayBounds(), .format(instant). DOESN\'T — a free function on the key: addDays (day math on the key, never in ms), weekdayIndex (day-of-week DECISIONS — never string-match a rendered weekday name), formatDay(key, "short"|"long"|"weekday"). Zones are IanaTimezone (settings.resolveTimezone, parseIanaTimezone); day keys are LocalDateKey (parseLocalDateKey / isLocalDateKey at a persistence or wire boundary) — both branded, so a plain string won\'t type-check. A bare Intl trial once broke briefings on "UTC", and a per-call-site UTC reading dated triage todos a day early.',
  },
  {
    id: "hand-rolled-utc-offset-parse",
    // The `longOffset` → "GMT-05:00" parse. One reader owns it; a second copy
    // is how the same zone got three different offset answers.
    re: /timeZoneName:\s*["']longOffset["']|GMT\(\?:/,
    severity: "gate",
    owners: ["packages/assistant/src/time/local-time.ts"],
    fix: "Use inZone(timezone).offsetMs(instant) from @alfred/assistant/time — the one place the longOffset string is parsed. inZone(tz).clock(instant).utcOffset gives the signed ISO fragment.",
  },
  {
    id: "stale-google-access-token",
    re: /\brefreshAccessToken\b|\bcredential(?:s)?\.accessToken\b/,
    severity: "hint",
    fix: "Resolve Google tokens with getFreshAccessToken from @alfred/integrations/google. The persisted accessToken and a manual refresh are both the stale path — and the token is a secret, so never log or persist it on an error.",
  },
  {
    id: "raw-provider-client",
    re: /new\s+Anthropic\(|createAnthropic\(|createGoogleGenerativeAI\(/,
    severity: "hint",
    fix: "Use getChatModel / getCheapModel / getBossModel from @alfred/ai instead of constructing a provider client — they carry the retry wrapper, metering, and per-model capability map.",
  },
  {
    id: "raw-email-normalize",
    re: /\.match\(\s*\/<\s*\(\?/,
    severity: "hint",
    fix: "Use parseEmailAddress(value) from @alfred/contracts to pull an address out of a `Name <addr>` header and normalize it. It is also the single source of self-mail matching.",
  },
  {
    id: "hand-rolled-no-reply-regex",
    // A `no[-_.]?reply` / `no[-_]?reply` alternation inside a regex literal.
    // `hint`, not `gate`: two SERVICE_LOCAL_PREFIX_RE declarations legitimately
    // hold this literal, and a whole-file exemption on them would blind the
    // rule exactly where the next copy would be written.
    re: /no\[[-_.]+\]\??reply/,
    severity: "hint",
    owners: ["packages/contracts/src/identity-affiliation.ts"],
    fix: "hasServiceWordSuffix(localPart) from @alfred/contracts owns the SUFFIX half of the no-reply family (`messages-noreply`, `nse_alerts`, `store-news`) and carries the prod measurement behind it. Reach for it before re-spelling the alternation. A PREFIX test (`^noreply-…`) is a different question and stays in its owning module.",
  },
  {
    id: "spread-over-defaults",
    // `{ ...DEFAULT_X, ...overrides }` — a defaults object (SCREAMING_CASE or
    // `defaultFoo`) with a second spread layered on top. A *present* `undefined`
    // wins a spread, so one explicitly-undefined override key zeroes the default
    // it was meant to fall back to. `exactOptionalPropertyTypes` only catches
    // that while the override type stays narrow (`{ k?: T }`), which makes
    // narrowness load-bearing at a site that never says so — and every
    // `AttributedCall` field is already widened, so the flag catches nothing
    // there. Anchored on the defaults-naming convention: `{ ...input,
    // ...sanitized }` and friends are overlays, not defaults resolution.
    re: /\{\s*\.\.\.(?:[A-Z][A-Z0-9_]{2,}|default[A-Z]\w*|defaults)\s*,\s*\.\.\./,
    severity: "gate",
    fix: "Use withDefaults(DEFAULTS, overrides) from @alfred/contracts — it ignores override keys whose value is undefined, so a default can't be zeroed by a present-undefined.",
  },
  {
    id: "hand-rolled-nested-transaction",
    // `.transaction(` on a handle you already hold is the savepoint-on-nest
    // contract restated in prose instead of through `runAtomic` — push.ts and
    // execution/service.ts each carried one. The ~40 root-client sites cannot
    // match: `\w+\.` needs a word char immediately before the `.`, and the
    // sanctioned `db().transaction(` puts a `)` there (the receiver is `db()`),
    // so the rule discriminates on the receiver, not the call.
    //
    // A DIFFERENT interface with the same method name is the escape hatch's job:
    // the Better-Auth/DI adapter `transaction` (credential-adapter.ts:331,
    // google-credential-lifecycle.ts:100,138) is not a Drizzle handle and wraps
    // `db().transaction` itself, so those sites carry a `// drift-ok:` comment
    // block directly above the call. That is why this is `scope: "chain"`: the
    // marker needs multi-line prose, and a line rule only reads one physical
    // line — the adapter call is too long to fit the marker as a trailing
    // comment. `helpers.ts` is the one whole-file owner: `runAtomic` is the
    // helper this rule points at, and `runner.transaction(body)` IS it.
    re: /\b\w+\.transaction\s*\(/,
    scope: "chain",
    severity: "gate",
    owners: ["packages/db/src/helpers.ts"],
    fix: "Use runAtomic(runner, body) from @alfred/db/helpers — `.transaction()` on a handle you already hold is a hand-rolled savepoint. `db().transaction(` is the sanctioned root-client spelling and does not match; a Better-Auth/DI adapter's own `transaction` method is a different interface and carries a `// drift-ok:` comment block above the call.",
  },
  {
    id: "unguarded-agent-run-status-write",
    // A status write to `agent_runs` outside the executor's guarded door: a bare
    // `.where(eq(agentRuns.id, ...))` compiles, reads fine, and silently
    // resurrects a run a concurrent cancel just took terminal (#530, and review
    // finding D1 — which was exactly this shape, thirty lines below the door).
    //
    // "chain", because this is the idiom a per-line regex cannot see. Prettier
    // puts `.update(agentRuns)`, `.set({`, `status:` and `.where(…)` on four
    // separate lines, so the earlier one-line version of this rule matched
    // exactly zero of the repo's six write sites — it could only ever have
    // fired on a hand-collapsed one-liner. The span is bounded by `;` so it
    // cannot run past the end of the statement into an unrelated
    // `update(agentSteps).set({ status: … })`, and `status:` is matched anywhere
    // inside the payload so a nested `error: { … }` before it does not hide it.
    //
    // Known limit: only a `.set({ … })` object *literal* is visible. The door's
    // own `.set(set)` (a `PgUpdateSetSource` parameter) is opaque to any regex —
    // that one is covered by the door being the thing every caller goes
    // through, not by this rule.
    //
    // No `owners`: every legitimate writer carries an inline `// drift-ok:` with
    // its reason instead. A whole-file exemption for executor.ts and service.ts
    // is what made the previous version unable to catch D1, which lived in
    // executor.ts. This is a build-time detector for the common direct-write
    // shapes, not a type-level proof that every possible SQL construction goes
    // through the guarded door.
    re: /\bupdate\(\s*agentRuns\s*\)[^;]*?\.set\(\s*\{[^;]*?(?:\bstatus\s*(?::|(?=[,}]))|\[\s*["']status["']\s*\]\s*:)/,
    scope: "chain",
    severity: "gate",
    fix: "Route `agent_runs.status` writes through commitGuardedRunUpdate in packages/api/src/modules/agent/executor.ts — it takes the row lock, refuses a superseded attempt, and refuses to write a live status over a terminal one. A bare .where(eq(agentRuns.id, …)) resurrects cancelled runs (#530). If the transaction already holds FOR UPDATE on the row and has checked the status under that lock (leaseRun's backstop), append `// drift-ok: <that reason>` to the `.update(agentRuns)` line.",
  },
  {
    id: "unguarded-agent-run-status-upsert",
    re: /\binsert\(\s*agentRuns\s*\)[^;]*?\.onConflictDoUpdate\(\s*\{[^;]*?\bset\s*:\s*\{[^;]*?(?:\bstatus\s*(?::|(?=[,}]))|\[\s*["']status["']\s*\]\s*:)/,
    scope: "chain",
    severity: "gate",
    fix: "Do not upsert agent_runs.status. Route lifecycle transitions through the owning agent service/executor door so terminal-state and attempt guards cannot be bypassed.",
  },
  {
    id: "raw-agent-run-status-sql",
    re: /\bUPDATE\s+(?:"?agent_runs"?)\s+SET\b[^;]*?\bstatus\s*=/i,
    scope: "chain",
    severity: "gate",
    fix: "Do not write agent_runs.status with raw SQL. Route lifecycle transitions through the owning agent service/executor door.",
  },
  {
    id: "raw-ioredis-construction",
    // A hand-built ioredis client. The default import is spelled `IORedis`
    // here and `Redis` in ioredis' own docs, so both spellings are banned.
    // Zero call sites outside the owner, hence "gate" on day one.
    re: /\bnew\s+(?:IORedis|Redis)\s*\(/,
    severity: "gate",
    owners: ["packages/db/src/redis.ts"],
    fix: 'Use createRedisConnection(kind) from @alfred/db/redis. Its RedisConnectionKind table is the one place that decides what a connection does during an outage — a hand-built client silently picks "waits forever".',
  },
  {
    id: "db-backed-skip-hand-rolled",
    // A test tree's own reader of a SERVICE variable. The idiom it replaces is
    // `const SKIP = process.env.DATABASE_URL ? false : "…"`, whose failure mode
    // is silence: `node:test` prints `# skipped 0` for a suite-level skip,
    // because the subtests inside a skipped `describe` are never registered. So
    // a CI job that reached no Postgres exits 0 and reads exactly like a job
    // that did. `dbBackedSkip` throws instead when `CI` is set.
    //
    // VOCABULARY. `DATABASE_URL` and `REDIS_URL` only — the two variables whose
    // absence makes a whole suite disappear. A provider variable (a mail
    // sender, an API key) stays a convention, because the guards that read one
    // sit on `test(…, { skip })`, which `node:test` does register and count.
    //
    // The sanctioned call site, `dbBackedSkip("database")`, names neither
    // variable, so it never matches and no allowlist is needed. Two populations
    // are spared for the same reason — a reader and a name must share one line:
    // the helper's own `REQUIRED_VARIABLES` table (names, no reader) and its
    // `!process.env[name]` loop (a reader, no name), and every env-fixture seed
    // block (`DATABASE_URL: "postgres://…"` carries no reader).
    //
    // The pair is written as two lookaheads, NOT as `reader .* name`, because a
    // sequential regex is order-sensitive and `const { DATABASE_URL } =
    // process.env;` puts the name first. That destructured form is a live escape
    // the repo already names in prose
    // (`packages/assistant/test/barrel-load.test.ts`), so the rule must see it
    // whichever side the reader sits on. `matchChains` rebuilds the source with a
    // `g` flag and keeps the rest, so `m` survives and `^…$` stays per-line.
    //
    // RESIDUE — at least two shapes. An author can build the variable name at
    // runtime. And the rule reads ONE line, so a reader and a name on DIFFERENT
    // lines escape it whatever order each line reads in. The plausible shape is
    // an alias — `const env = process.env;` near the top of a file, and a bare
    // `env.DATABASE_URL` later. No such alias sits in any tree this rule polices
    // — every `packages/<name>/test/` and `apps/<name>/test/` — but the shape is
    // LIVE outside them: `packages/db/src/index.ts` binds `databaseEnv()` to
    // `env` and reads `env.DATABASE_URL` two lines down. So read the absence as
    // "not here yet", not as "it cannot happen", and treat widening the rule
    // past one line as a separate decision, not a regex tweak.
    //
    // `packages/db/test` follows the convention like every other tree: it ships
    // `packages/db/test/support/db-backed.ts`, and its two Postgres-backed suites
    // call `dbBackedSkip("database")`. Its Redis suites are the exception, and
    // they are not exempt from the rule so much as stronger than it: they FAIL
    // LOUDLY when Redis is absent instead of skipping (see
    // `packages/db/test/redis-cold-command.test.ts`). Those readers carry
    // `// drift-ok:` markers.
    re: /^(?=.*(?:\bprocess\.env\b|\b(?:databaseEnv|serverEnv)\(\)))(?=.*\b(?:DATABASE_URL|REDIS_URL)\b).*$/m,
    scope: "chain",
    paths: /(^|\/)(?:packages|apps)\/[^/]+\/test\//,
    severity: "gate",
    fix: 'Use dbBackedSkip("database") from ./support/db-backed in this test tree — it skips on a laptop with no Postgres and THROWS when CI is set, so a job that reached no service cannot exit 0. Do not hand-roll a `{ skip }` on a service variable. If this line is not a skip guard, append `// drift-ok: <reason>`.',
  },
  {
    id: "sha256-over-json-stringify",
    // `createHash("sha256").update(JSON.stringify(v))` — a content hash whose
    // pre-image depends on object key INSERTION order. Three copies fed the
    // `observations` dedup index `(user_id, family_key, evidence_hash)` (#571):
    // the same logical payload built along two code paths hashes differently,
    // so dedup silently misses and an append-only log double-counts. Chain
    // scope, because a formatter splits `.update(` onto its own line. Hashing
    // raw bytes (`createHash("sha256").update(rawString)`) is a different
    // operation and is left alone.
    re: /createHash\(\s*["']sha256["']\s*\)\s*\.update\(\s*JSON\.stringify\(/,
    scope: "chain",
    severity: "gate",
    fix: "Use sha256Canonical(value) from @alfred/db/hash — SHA-256 over canonicalJson (keys sorted, present-undefined skipped), prefixed `sha256:`. It is the one content hash for observations.evidence_hash and every other dedup / change-detection digest. If the digest is audit-only and never compared, append `// drift-ok: <why order-dependence is safe here>`.",
  },
  {
    id: "no-constants-re-export",
    // The single-owner rule for module constants. `constants.ts` owns the fact,
    // `index.ts` (the barrel) is the only sanctioned re-exporter. A logic file
    // that does `import { X } from "./constants"; export { X }` creates a second
    // door — two places answer the same fact and nothing makes them agree.
    // The chain form catches the two-line shim; the barrel is allowlisted.
    re: /import\s*\{[^}]*\}\s*from\s*["'][^"']*\/constants["'][^;]*;[^;]*export\s*\{[^}]*\}/,
    scope: "chain",
    severity: "gate",
    owners: [
      "packages/extraction/src/index.ts",
      "packages/assistant/src/chat/compaction/index.ts",
      "packages/assistant/src/chat/index.ts",
      "packages/http/src/sync/model.ts",
    ],
    fix: "Do not re-export a constant through a logic file. Import from ./constants where you use it, or export from the barrel (index.ts) if it is a public contract. A logic file that imports then exports the same name is a second door.",
  },
  {
    id: "no-type-re-export-shim",
    // `import type { Foo } from "./constants"; export type { Foo }` — same
    // second-door problem for types. Also catches `export type { Foo } from "./constants"`
    // outside the barrel.
    re: /export\s+type\s*\{[^}]*\}\s*from\s*["'][^"']*\/constants["']/,
    severity: "gate",
    owners: ["packages/extraction/src/index.ts", "packages/assistant/src/chat/compaction/index.ts"],
    fix: "Do not re-export a type through a logic file. Import it from ./constants where you use it. Only the barrel (index.ts) may re-export a constants type.",
  },
  {
    id: "no-type-alias-shim",
    // `import type { Foo } from "./constants"; export type Bar = Foo` — a shim
    // that adds a name without adding a fact. Only the constants seam is gated
    // here; generic `Pick<>` / `Exclude<>` / `z.infer` aliases are not.
    re: /import\s+type\s*\{[^}]*\}\s*from\s*["'][^"']*\/constants["'][^;]*;[^;]*export\s+type\s+\w+\s*=\s*\w+\s*;/,
    scope: "chain",
    severity: "gate",
    owners: ["packages/extraction/src/index.ts", "packages/assistant/src/chat/compaction/index.ts"],
    fix: "Do not alias an imported constants type with `export type X = Y`. Import Y directly where you need it, or define X in its owning module. An alias that only renames is a second door.",
  },
  {
    id: "no-function-wrapper-shim",
    // `export function foo(){ return bar }` where bar is an import — a
    // function that only forwards to a constant. Prefer the constant itself.
    // This is intentionally narrow: single return, no args handling, no logic.
    re: /export\s+function\s+\w+\s*\([^)]*\)\s*\{\s*return\s+\w+\s*;?\s*\}/,
    severity: "gate",
    fix: "Do not wrap a constant in a function that only returns it. Export the constant or import it directly. A forwarding function is a second door.",
  },
  {
    id: "object-state-row-lock-mode",
    // `.for("update")` inside the object-state module. The mode is load-bearing
    // there, not merely strong: `integration_object_keys.object_id` references
    // `integration_objects`, so every phase-2 key upsert runs a referential
    // check that takes `FOR KEY SHARE` on its parent object row. `FOR KEY SHARE`
    // waits behind `FOR UPDATE` and does not conflict with `FOR NO KEY UPDATE`,
    // so `FOR UPDATE` here re-opens the exact cross-table ABBA cycle the
    // two-phase lock order closes (#1203). `integration_object_relations` is a
    // second FK child with the same edge and no writer yet, so the next writer
    // in this directory lands on the same rule.
    //
    // `paths`-scoped: the surrounding package holds ~30 legitimate
    // `.for("update")` sites, and only this directory's object rows carry the
    // constraint. The directory holds exactly one `.for(` call site today.
    re: /\.for\(\s*["'](?!no key update)/,
    paths: /(^|\/)packages\/assistant\/src\/connections\/object-state\//,
    severity: "gate",
    fix: 'Lock an `integration_objects` row with `.for("no key update")`, through lockIdentityRow in ./store.ts. A key upsert takes `FOR KEY SHARE` on its parent object row, which waits behind `FOR UPDATE` and re-opens the cross-table deadlock the two-phase lock order closes. If this lock is over another table, append `// drift-ok: <table, and why its mode is free>`.',
  },
  {
    id: "hand-rolled-whitespace-collapse",
    // `.replace(/\s+/g, " ")` — folding a whitespace run to one space, for a
    // value a person or a model reads. It was hand-written in eleven display
    // places before `collapseWhitespace` existed, and each copy was free to
    // drift into a slightly different preview.
    //
    // The fold to EMPTY (`.replace(/\s+/g, "")`) is a length measure, not this
    // idiom, so the replacement argument must be a quoted single space.
    // `context-search/pack.ts`'s `oneLine` is a deliberately NARROW fold over
    // the four line terminators and must not match either — its regex does not
    // open with `\s`.
    //
    // Three spellings of the run, because an author reaches for all three:
    // `/\s+/`, `/\s{2,}/` and `/\s\s+/`, each with or without the character
    // class — and the doubled-atom form reads the class on either atom
    // independently, so `/[\s]\s+/` and `/[\s][\s]+/` are read too. The `{2,}`
    // form is NOT a near-miss — `/\s{2,}/g` differs from
    // `/\s+/g` only on a single whitespace character, which a display fold
    // wants normalized anyway. What it does catch besides display is a value a
    // provider must receive unchanged, and that site carries a marker.
    //
    // `scope: "chain"`: the formatter can split a `.replace(…)` call across
    // lines, and a chain rule's `drift-ok` marker must carry a reason, which
    // `matchLine` does not require. Chain scope also reaches the adjacent
    // `.split(/\s+/).join(" ")` spelling. The span is bounded by adjacency, not
    // by a `[^;]*` run, so it cannot swallow the next statement.
    //
    // No `paths` clause, so the rule inherits `isSkippedPath`: a copy landing in
    // `scripts/` or a test tree is unrefused. A `paths` clause would opt the
    // rule out of that filter entirely and then flag deliberate fixtures.
    re: /\.replace(?:All)?\(\s*\/(?:\[?\\s\]?(?:\+|\{2,\})|(?:\[?\\s\]?){2}\+)\/[a-z]*\s*,\s*(["'`]) \1\s*,?\s*\)|\.split\(\s*\/\[?\\s\]?\+\/[a-z]*\)\s*\.join\(\s*(["'`]) \2\s*,?\s*\)/,
    scope: "chain",
    severity: "gate",
    owners: [
      // `packages/assistant/src/knowledge/` belongs to a parallel campaign, so
      // this campaign may not edit the directory at all. THAT is why all three
      // are exempt — not because all three fold for a non-display reason. Two
      // do, and both pass the byte-for-byte test the `fix` string states.
      // `entity-kind-classifier` puts its folded name straight into a `Set`
      // (`names.add(normalized)`), so the fold IS the dedup token: two
      // spellings of one name merge or stay apart on its exact bytes.
      // `no-profile` never shows its folded copy; it compares the whole copy
      // against the anchored `NO_PUBLIC_PROFILE_RE`, whose `^…$` and
      // 20-character tail bound measure those bytes, so a wider fold silently
      // drops a real prior.
      //
      // `user-context-line` does NOT. Its folded value is returned as
      // `UserContextLine.text` and rendered into the triage prompt, so it is a
      // display fold that this rule would refuse on its merits. It is the one
      // entry here that must be MIGRATED to `collapseWhitespace` once the
      // parallel campaign releases the directory; the other two convert to
      // per-line `// drift-ok:` markers then.
      "packages/assistant/src/knowledge/entity-kind-classifier.ts",
      "packages/assistant/src/knowledge/user-context-line.ts",
      "packages/assistant/src/knowledge/cold-start/no-profile.ts",
    ],
    fix: 'Call collapseWhitespace(text) from @alfred/contracts — one fold for every display snippet, preview, title and summary. Keep a private fold, plus `// drift-ok: <what the value identifies>`, only when other code compares the value byte for byte: a key, a hash, a dedup token, a cache lookup, or a query a provider must receive unchanged. The row also fires on a fold that must NOT trim — `out += chunk.replace(/\\s+/g, " ")` builds one string from many pieces, and `collapseWhitespace` would eat the edge space that separates them — so mark that case the same way. Being stored is not that test and neither is being read by a classifier — prose a person or a model reads is a display fold either way.',
  },
];

/**
 * Path predicate → skip. Tests/evals/scripts/backfills legitimately use casts
 * and raw env reads for fixture ergonomics; generated + built output isn't
 * source. Shared so the gate and the edit-time hook agree on scope.
 * @param {string} file Repo-relative path.
 */
export const isSkippedPath = (file) =>
  /(^|\/)(dist|build|coverage|node_modules)\//.test(file) ||
  /\.(d|gen)\.ts$/.test(file) ||
  /\.test\.tsx?$/.test(file) ||
  /(^|\/)(test|__mocks__|evals)\//.test(file) ||
  file.endsWith(".eval.ts") ||
  /(^|\/)scripts\//.test(file);

/**
 * True for a file some rule can match, so a consumer knows whether to read it.
 *
 * This is a cheap narrowing of the file list, NOT the scoping decision. The
 * per-rule clause in {@link matchLine} / {@link matchChains} is what scopes a
 * rule; a `paths` rule would be silently unscanned if a consumer kept
 * pre-filtering on {@link isSkippedPath} alone. Both consumers call this.
 * @param {string} file Repo-relative path.
 */
export const isScannedPath = (file) =>
  !isSkippedPath(file) || RULES.some((rule) => rule.paths?.test(file));

/**
 * True when `rule` is in scope for `file`. A rule that names `paths` opts out of
 * the global skip filter entirely and sees exactly what its own regex admits.
 * @param {ConsolidationRule} rule
 * @param {string} file Repo-relative path.
 */
const coversFile = (rule, file) =>
  (rule.paths ? rule.paths.test(file) : !isSkippedPath(file)) && !rule.owners?.includes(file);

/**
 * Match one line against the rules in scope for a file.
 * @param {string} line
 * @param {string} file Repo-relative path, for per-rule owner exemptions.
 * @param {"gate"|"all"} lanes Which severities to report.
 * @returns {ConsolidationRule[]}
 */
export function matchLine(line, file, lanes) {
  if (line.includes("// drift-ok")) return [];
  // Skip whole-line comments — doc examples of a banned idiom are not drift.
  const trimmed = line.trim();

  if (trimmed.startsWith("//") || trimmed.startsWith("*")) return [];

  return RULES.filter(
    (rule) =>
      rule.scope !== "chain" &&
      (lanes === "all" || rule.severity === "gate") &&
      coversFile(rule, file) &&
      rule.re.test(line),
  );
}

/** True for a line that is only a comment, so a doc example is not drift. */
const isCommentLine = (line) => /^\s*(?:\/\/|\*|\/\*)/.test(line);

/**
 * Blank every comment-only line while preserving byte offsets of the rest, so a
 * chain match can span a commented gap (a `.set({ … })` payload with a comment
 * inside it is one statement) without a doc example counting as drift.
 * @param {string} text
 */
const codeOnly = (text) =>
  text
    .split("\n")
    .map((line) => (isCommentLine(line) ? " ".repeat(line.length) : line))
    .join("\n");

/**
 * Match the `scope: "chain"` rules against a whole file (or a whole edit body).
 *
 * `matchLine` is per-line, which is structurally blind to a formatted query
 * builder: `.update(agentRuns)`, `.set({`, and `.where(…)` land on separate
 * lines, so a single-line regex over the chain matches nothing. A chain rule's
 * `re` is run over the joined text instead, and is expected to bound its own
 * span (e.g. `[^;]*?`) so a match cannot silently swallow the next statement.
 *
 * `// drift-ok` suppresses a match when it appears on any line the match touches
 * OR in the run of comment lines directly above it — the reason for a
 * multi-line chain rarely fits as a trailing comment, so it lives in the
 * statement's own comment block.
 *
 * @param {string} text Full file contents, or the text an edit would add.
 * @param {string} file Repo-relative path, for per-rule owner exemptions.
 * @param {"gate"|"all"} lanes Which severities to report.
 * @returns {{rule: ConsolidationRule, line: number, text: string}[]} `line` is
 *   1-based and points at the first line of the match.
 */
export function matchChains(text, file, lanes) {
  const code = codeOnly(text);
  const lines = text.split("\n");
  /** @type {{rule: ConsolidationRule, line: number, text: string}[]} */
  const found = [];

  for (const rule of RULES) {
    if (rule.scope !== "chain") continue;

    if (lanes !== "all" && rule.severity !== "gate") continue;

    if (!coversFile(rule, file)) continue;
    const re = new RegExp(rule.re.source, `${rule.re.flags.replace(/g/g, "")}g`);

    for (let m = re.exec(code); m !== null; m = re.exec(code)) {
      // Widen the match to the whole lines it touches: that is the unit the
      // reported snippet works in.
      const start = code.lastIndexOf("\n", m.index) + 1;
      const lineEnd = code.indexOf("\n", m.index + m[0].length);
      const first = code.slice(0, start).split("\n").length - 1;

      const last =
        lineEnd === -1 ? lines.length - 1 : code.slice(0, lineEnd).split("\n").length - 1;

      // Then widen again, for the marker only, over the comment block above.
      let markerFrom = first;

      while (markerFrom > 0 && isCommentLine(lines[markerFrom - 1])) markerFrom--;

      const exempt = lines
        .slice(markerFrom, last + 1)
        .some((line) => /\/\/\s*drift-ok:\s*\S/.test(line));

      if (exempt) continue;
      found.push({
        rule,
        line: first + 1,
        text: lines
          .slice(first, last + 1)
          .map((l) => l.trim())
          .filter(Boolean)
          .join(" "),
      });
    }
  }

  return found;
}
