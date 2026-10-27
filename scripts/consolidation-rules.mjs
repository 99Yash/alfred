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
//
// A gate that needs scope or AST structure (which binding a name resolves to)
// is an oxlint rule in scripts/oxlint/alfred/ instead, enforced by `pnpm lint`.
// `sha256-over-json-stringify`, `no-function-wrapper-shim`,
// `no-constants-re-export`, `no-type-re-export-shim` and `no-type-alias-shim`
// moved there.
// helper-hints.mjs does not read those rules; `.claude/hooks/lint-on-edit.mjs`
// runs oxlint on each file an agent writes, so they speak at edit time too.
// Both hooks are registered in `.claude/settings.json`.

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
 * @property {boolean}  [comments] True when the idiom IS a comment (a lint
 *                                directive), so {@link matchLine} reads a
 *                                whole-line comment for this rule instead of
 *                                skipping it as a doc example. Line scope only.
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

/**
 * Production web code that the design-token gates scan. The landing page, the
 * public legal pages that share its background, the styleguide and the
 * components only it renders, and `ui/legacy` keep the older dimension grammar
 * on purpose (components/ui/legacy/README.md).
 */
const WEB_APP_TOKEN_PATHS =
  /^apps\/web\/src\/(?!components\/landing\/|components\/ui\/legacy\/|components\/legal\/|routes\/-styleguide\/|routes\/-preview-landing\/|routes\/-legal\/|components\/(?:dimension-chat-thread|dimension-composer-shell|quick-access-rail|ui\/frost-panel|ui\/tabs|ui\/command-palette|ui\/icon-button|ui\/status-dot)\.tsx$)/;

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
      "packages/assistant/src/connections/ingestion/receipt-payload-reaper.ts",
    ],
    fix: "Read typedEventReceipts from @alfred/db/schemas. Only the view definition, receipt conflict read-back, the deliver job (publishes both tiers), raw inventory, corpus backfill, and payload retention may read both tiers of eventReceipts.",
  },
  {
    id: "humanize-integration-slug",
    // `humanizeSlug(tool.integration)` / `humanizeSlug(integration)` — title-casing
    // an integration slug renders `github` as "Github" and `imessage` as "Imessage".
    // `integrationSlug` is the same value under its longer name. A credential or
    // MCP identity `provider` and an event-trigger `source` hold the same slugs
    // (`humanizeSlug(provider)` showed "Github account", #1367), so the rule also
    // reads those names, bare, as a property, or camel-suffixed (`credentialProvider`).
    // The name must end the argument (`provider.slug` aside): `integration.action`
    // and `source.kind` are action and kind slugs, which humanizeSlug is for.
    // An optional-chain step (`row?.provider`, `source?.kind`) reads the same
    // as a `.` step on both sides of the name.
    // The compiler is the first guard: `humanizeSlug`'s parameter rejects a value whose
    // type is or includes an `IntegrationSlug` literal, whatever its name (`v`, `slug`), and
    // any open string type. This rule is the backstop for a closed provider union that holds
    // no registry slug (`clickup` is "ClickUp" through `loopEntityProviderName`).
    re: /\bhumanizeSlug\(\s*[\w.?]*?(?:\b(?:integration|provider|source)|(?<=[a-z\d])(?:Integration|Provider|Source))(?:Slug)?(?:\??\.slug)?(?![\w.]|\?\.)/,
    severity: "gate",
    fix: "Index INTEGRATION_DISPLAY_NAMES[slug] from @alfred/contracts with a typed IntegrationSlug, or call integrationDisplayName(value) for an unchecked string. A LoopEntityProvider (MCP identity provider) reads loopEntityProviderName(provider). humanizeSlug is for action and field slugs, not integration names.",
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
    // (a union) is a different, narrower shape and is left alone. The generic
    // spellings `as Array<string>` / `as ReadonlyArray<string>` are the same
    // assertion. `as readonly string[]` is not read here: it is the widening
    // cast `hand-rolled-enum-guard` owns.
    re: /\bas\s+(?:string\[\]|(?:Readonly)?Array\s*<\s*string\s*>)(?!\s*[|&])/,
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
    //
    // SQL is case-blind and allows a space before the paren, so `any (${list})`
    // is the same bug. The `sql.param(…)` form this row's fix names binds ONE
    // array parameter, so it is the cure and must not match.
    re: /\bANY\s*\(\s*\$\{(?!\s*sql\.param\()/i,
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
    //   6. `switch (category) { case "resolved": }`, which the exhaustive-switch
    //      rule actively prefers for a closed union. This one is why the rule is
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
    fix: "Call closesOpenAsk(provider, kind, category, proof) from @alfred/contracts for a projection row — `proof` is the reading you actually hold, and a sync reader with no IO holds `stored_projection` — or evidenceObjectClosesAsk(card.object) for an evidence card, or closureCandidate(provider, kind, category) when you only mean to nominate a candidate for a consumer that will go get the proof. All read the registry's per-kind closesAskOn and closesAskFrom, so a kind that closes on neither category stays correct, and both return the closing category rather than a boolean. `failed` closes nothing: it is terminal for the object but it opens a CI loop, which is why a terminal-means-closed helper is not the reader either — if you truly mean terminal for the object and not closed, say so in a `// drift-ok:` marker.",
  },
  {
    id: "unowned-live-confirmation-proof",
    // The fourth argument of `closesOpenAsk` is a SELF-REPORT. The caller
    // states which reading it holds, and no type separates a caller that just
    // took a live provider read from one holding a stored `integration_objects`
    // row. The registry half of the ADR-0103 split is tier 1 — a kind declares
    // `closesAskFrom` once, and the compiler keeps that record exhaustive — but
    // the caller half is tier 5 without this row: a site that types
    // `"live_confirmation"` over a stored row compiles, lints and passes
    // `pnpm check` while it asserts a closure it never proved.
    //
    // `hand-rolled-object-closure` above cannot see that site. It fences the
    // COMPARISON, and its own selftest records the four-argument registry call
    // as the intended form, so the argument's VALUE is outside its reach.
    //
    // The token is therefore owned rather than free. Two files may write it:
    // the registry that declares the vocabulary, and the one site that takes
    // the read (`dropClosedLoops`). A second confirmation site adds itself
    // here, which keeps every site that may assert a live proof readable in
    // one place. That is the only witness the registry's DEMAND has.
    //
    // Comment-only lines are already out of reach (`matchLine` skips them), so
    // the docstrings that name the token are not drift.
    re: /["'`]live_confirmation["'`]/,
    severity: "gate",
    owners: [
      "packages/contracts/src/integration-objects.ts",
      "packages/assistant/src/briefings/gather.ts",
    ],
    fix: "Pass the proof you actually hold to closesOpenAsk(provider, kind, category, proof) from @alfred/contracts. A reader over a stored integration_objects row holds `stored_projection`; only a caller that just took a live provider read of THIS object may name `live_confirmation`. If you mean to nominate a candidate for a consumer that will go get the read, call closureCandidate(provider, kind, category) and hand on its `proof` instead of naming one. A new site that genuinely takes the read joins this rule's `owners`; a one-off states the read it holds in a `// drift-ok:` marker.",
  },
  {
    id: "canonical-param-key",
    // The `.toLowerCase().replace(/[_-]/g, "")` key-canonicalization idiom, with
    // the class in either order and through `replaceAll`.
    re: /\.toLowerCase\(\)\.replace(?:All)?\(\s*\/\[(?:_-|-_)\]\/g\s*,\s*""\s*\)/,
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
    // answered no forever. The identifier may carry a prefix (`grantedScopes`,
    // `tokenScope`), because a word boundary before `scope` let those through.
    re: /\b\w*scope\w*\b[^;\n]*\.split\(/i,
    severity: "gate",
    owners: ["packages/contracts/src/oauth-scopes.ts"],
    fix: "Use parseOAuthScopeList(scope) from @alfred/contracts — the one grammar that accepts both RFC 6749 space lists and GitHub's comma list.",
  },
  {
    id: "oauth-state-primitive",
    // The OAuth state primitives, called outside the handshake. Each curated
    // callback once had to remember the step that makes the nonce a CSRF and
    // replay defense: compare the user that the nonce was minted for with the
    // user in the signed state. A route that calls `verifyOAuthState` alone
    // accepts a replayed state. The MCP flow uses the handshake too, as
    // `oauthHandshake("mcp")`, which namespaces each nonce by the connection
    // (`mcp:<connectionId>`). So the primitives are module-private, and the
    // only owner is the module that holds them.
    re: /\b(?:rememberOAuthNonce|consumeOAuthNonce|signOAuthState|verifyOAuthState)\b/,
    severity: "gate",
    owners: ["packages/assistant/src/connections/oauth-state.ts"],
    fix: 'Bind oauthHandshake(PROVIDER) — or oauthHandshake("mcp") for an MCP authorization — from @alfred/assistant/connections once per route module; call .begin({ userId }) on connect and .complete(state) on callback. It signs, remembers and consumes the nonce, and checks the user, in one operation.',
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
    // `isValidTimeZone` follows Intl's own `timeZone` casing, and an arrow bound
    // to a const is the same function. A const bound to another NAME
    // (`isValidTimezone = isIanaTimezone`) is an alias, not a hand-rolled trial.
    re: /\bfunction\s+isValidTime[Zz]one\b|\b(?:const|let|var)\s+isValidTime[Zz]one\b[^=]*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|\w+\s*=>)/,
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
    // tests//scripts/ are skipped by the path filter, not listed here. A named
    // `env` import from `node:process` reads the same object without the
    // `process.` prefix.
    re: /\bprocess\.env\b|\bimport\s*\{[^}]*\benv\b[^}]*\}\s*from\s*["'](?:node:)?process["']/,
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
    // `scope: "chain"`: the formatter breaks a long ternary before `?` and `:`.
    re: /instanceof\s+Error\s*\?\s*\w+\.message\s*:\s*String\(/,
    scope: "chain",
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
    // Both spellings of the same check, because an author reaches for both:
    //   - `typeof x === "object" && x !== null` (the positive narrow), and
    //   - `typeof x !== "object" || x === null` (the negated early-return).
    // The second used to pass silently — packages/contracts/src/errors.ts:76
    // (`causeOf`'s `data` read) is the measured escape. The backreference pins
    // both halves to the same identifier so an unrelated null test on the next
    // operand does not match across the pair.
    re: /typeof\s+(\w+)\s*===\s*["']object["']\s*&&\s*\1\s*!==\s*null|typeof\s+(\w+)\s*!==\s*["']object["']\s*\|\|\s*\2\s*===\s*null/,
    severity: "hint",
    owners: ["packages/contracts/src/guards.ts"],
    fix: "isRecord(x) from @alfred/contracts is this check. Use toRecord(x) if you want a Record or {} back rather than a boolean.",
  },
  {
    id: "hand-rolled-enum-guard",
    // `(TUPLE as readonly string[]).includes(value)` — the membership-test
    // boilerplate `enumGuard` in packages/contracts/src/guards.ts exists to
    // own. The tuple stays the single source of truth (the `typeof
    // TUPLE[number]` type, a `z.enum(TUPLE)` where parsing is needed, and the
    // guard are three projections of one declaration); a hand-spelled cast
    // plus `.includes` at each call site is a fourth spelling nothing keeps in
    // agreement, and it needs a SAFETY comment because `Set.has` cannot narrow
    // (see the telemetry `readCauses` pay SAFETY cast this row retires).
    //
    // `hint`, not `gate`: three legacy sites remain in files this campaign
    // does not own (contracts/event-triggers.ts `isEventTypeForSource`,
    // contracts/tool-schemas.ts `promoteWindowSynonym`, assistant
    // tool-runtime/internal/registry.ts `registerTool`), and a whole-file
    // `owners` entry would blind the rule exactly where the next copy will be
    // written. Promote to `gate` once those three carry `// drift-ok:` markers
    // or migrate to `enumGuard`.
    //
    // `scope: "chain"`: a formatter may split the cast from the `.includes(`
    // across lines. The span between them admits whitespace only (never `;`),
    // so it cannot run past the end of the statement into an unrelated
    // membership test — which is also why the declaration-then-use split
    // (`const windowValues = … as readonly string[];` …
    // `windowValues.includes(val)` chapters later) is NOT covered: two
    // statements are outside any sound span, and widening to reach them would
    // fence every cast in the file. That shape stays measured residue
    // alongside the `typeof x === "string" && isKnownX(x)` redundant- prefix
    // shape (the guard already takes `unknown`) and the bare
    // `SOME_SET.has(x)`-plus-SAFETY-cast shape, both too broad to fence.
    re: /as\s+readonly\s+string\s*\[\s*\]\s*\)\s{0,40}?\.includes\s*\(/,
    scope: "chain",
    severity: "hint",
    fix: "Build the guard once with enumGuard(TUPLE) from @alfred/contracts — it narrows `unknown` to `typeof TUPLE[number]` with no cast and no SAFETY comment. The tuple stays the single source of truth; a per-site `(TUPLE as readonly string[]).includes(value)` is a fourth spelling of it.",
  },
  {
    id: "hand-rolled-key-guard",
    // `Object.hasOwn(TABLE, value)` or `Object.prototype.hasOwnProperty.call(
    // TABLE, value)` over a SCREAMING_CASE table: the membership body of a
    // hand-written "is this string a key of TABLE?" guard. `keyGuard(TABLE)`
    // in packages/contracts/src/guards.ts owns it, and derives the predicate
    // type from the table, so a key added to the table widens the guard with
    // no second edit.
    //
    // Residue this regex cannot see: a lowercase table name
    // (`eventPayloadSchemas`, `serverMutators`) and the `value in TABLE`
    // form. Both stay catalog-only (docs/reference/shared-helpers.md).
    re: /Object\.(?:hasOwn|prototype\.hasOwnProperty\.call)\(\s*[A-Z][A-Z0-9_]*\s*,/,
    severity: "gate",
    owners: ["packages/contracts/src/guards.ts"],
    fix: "Build the guard once with keyGuard(TABLE) from @alfred/contracts — it narrows `unknown` to the table's own string keys, reads them with Object.hasOwn, and derives the predicate type from the table. The table must be a closed literal (`as const` or `satisfies Record<K, V>`), the same precondition as typedKeys.",
  },
  {
    id: "object-keys-cast",
    // `Object.keys(TABLE) as K[]`, `Object.entries(TABLE) as [K, V][]`, and
    // `Object.fromEntries(keys.map(…)) as Record<K, V>`: each widens a key to
    // `string` and then asserts it back, one SAFETY comment per site.
    // `packages/contracts/src/records.ts` owns the one assertion of each kind.
    //
    // `hint`, not `gate`: the `typescript/no-unsafe-type-assertion` campaign
    // still has these casts in packages it has not reached. Promote to `gate`
    // when that rule is on, or delete the row then, since the lint rule
    // reports the same casts with type information.
    //
    // `scope: "chain"`: a formatter splits a long `fromEntries(…)` from its
    // `as` across lines. The argument admits balanced parentheses two levels
    // deep and never a `;`, so the `as` must follow the call's own closing
    // parenthesis and cannot come from a later statement.
    re: /\bObject\.(?:keys|entries|fromEntries)\((?:[^;()]|\((?:[^;()]|\([^;()]*\))*\))*\)\s*as\s+(?!const\b)/,
    scope: "chain",
    severity: "hint",
    owners: ["packages/contracts/src/records.ts"],
    fix: 'Over a closed const table, use typedKeys(TABLE) / typedEntries(TABLE) from @alfred/contracts. To build a record over a key tuple, use recordFromKeys(KEYS, (key) => value); to project one field of each entry, use pluckField(TABLE, "field"). To close a record that a loop filled, declare it Partial<Record<K, V>> and check it with hasEveryKey(record, KEYS). For keys of a value that came from outside, narrow each key with a guard instead.',
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
    fix: '@alfred/assistant/time owns every date/zone reading, split by one question: does the reading need a zone? NEEDS ONE — inZone(tz) binds it once and every reading is a method: .day() mints the LocalDateKey, .hour(), .offsetMs(), .clock(), .startOf(key, hour?), .dayBounds(), .format(instant). DOESN\'T — a free function on the key: addDays (day math on the key, never in ms), weekdayIndex (day-of-week DECISIONS — never string-match a rendered weekday name), formatDay(key, "short"|"long"|"weekday"). Zones are IanaTimezone (settings({ userId }).timezone(), parseIanaTimezone); day keys are LocalDateKey (parseLocalDateKey / isLocalDateKey at a persistence or wire boundary) — both branded, so a plain string won\'t type-check. A bare Intl trial once broke briefings on "UTC", and a per-call-site UTC reading dated triage todos a day early.',
  },
  {
    id: "module-scope-settings-bind",
    // A `settings({ userId })` bind loads the user's preference rows once and
    // never expires them. Held at module scope, it serves the zone and flags of
    // the first read for the life of the process. Only a column-0 declaration
    // matches: a bind inside a function body is indented.
    re: /^(?:export\s+)?(?:const|let|var)\s+\w+\s*(?::[^=]+)?=\s*settings\(\s*\{/,
    severity: "gate",
    fix: "Bind settings({ userId }) inside the request, workflow step, or job item that reads it. A bind keeps its first load and never re-reads, so a module-scope bind serves a stale zone and stale flags until the process restarts.",
  },
  {
    id: "raw-user-preferences-query",
    // `settings({ userId })` is the one gateway to `user_preferences` (ADR-0089).
    // A raw query beside it pays a second SELECT the bind already loaded, and a
    // raw write skips the `row_version` bump and the key/value validation.
    re: /\.(?:from|(?:left|right|inner|full)Join|insert|update|delete)\(\s*userPreferences\b/,
    scope: "chain",
    severity: "gate",
    owners: [
      // The settings gateway's own read, upsert, insert-if-absent, and delete.
      "packages/assistant/src/settings/preferences.ts",
      // The Replicache pull diffs `row_version` per key inside the pull tx; it
      // reads the sync model, not the user's settings.
      "packages/http/src/sync/read/preferences.ts",
    ],
    fix: "Read and write user_preferences through settings({ userId[, exec: tx] }) from @alfred/assistant/settings: get / all / timezone / flags for reads (one SELECT per bind), set / setIfUnset / delete for writes. Pass the bind the flow already holds instead of taking a second one.",
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
    id: "raw-gmail-token-call",
    // The token-taking Gmail REST calls, imported or re-exported. Each one makes
    // its caller resolve a token and thread it through, which is how a token got
    // held across a batch or read before a refresh. `@alfred/integrations/google`
    // no longer exports them, and the package `exports` map refuses a deep
    // import, so other packages cannot reach them; this row fences the
    // integrations package's own files and a re-export that would reopen the door.
    //
    // A namespace import (`import * as gmail from "./gmail"`, `export * as g`)
    // and a dynamic `import("./gmail")` reach every token call without naming
    // one, so they match on the specifier alone. The specifier may carry a
    // `.ts` / `.js` extension. The path must be the sibling `./gmail` or end in
    // `google/gmail`, so the assistant's `./internal/tools/gmail` tool module is
    // not this file. A named import of the pure parsers (`extractMessageContent`,
    // the types) stays legal.
    re: /\b(?:import|export)\s*(?:\{[^}]*\b(?:listMessages|getMessage|getThreadMessageLabels|listHistory|startWatch|stopWatch|listLabels|createLabel|modifyMessageLabels|batchModifyMessages|sendMessage|getAttachment)\b[^}]*\}|\*(?:\s*as\s+\w+)?)\s*from\s*["'](?:[^"']*\/google\/|\.\.?\/)gmail(?:\.[cm]?[jt]s)?["']|\bimport\(\s*["'](?:[^"']*\/google\/|\.\.?\/)gmail(?:\.[cm]?[jt]s)?["']\s*\)/,
    scope: "chain",
    severity: "gate",
    owners: ["packages/integrations/src/google/mailbox.ts"],
    fix: "Call gmailMailbox({ credentialId }) from @alfred/integrations/google and use its methods (listMessages, getMessage, batchModifyMessages, …). Each call resolves a fresh token through getFreshAccessToken, so no caller holds one. Inside the package, gmailMailboxFor(resolver) binds another resolver.",
  },
  {
    id: "raw-provider-client",
    re: /new\s+Anthropic\(|createAnthropic\(|createGoogleGenerativeAI\(/,
    severity: "hint",
    fix: "Use route(name) from @alfred/ai instead of constructing a provider client — it carries the retry wrapper, metering, and per-model capability map.",
  },
  {
    id: "raw-email-normalize",
    // A `Name <addr>` header split: `.match(/<(?…` or the `<([^>]+)>` capture.
    // Seven copies of the second spelling read one `From:` header seven ways
    // until `parseMailbox`. `hint`, because a body scan for an address
    // (`<([^>]+@noreply.github.com)>`) or an organizer line is a fair use.
    re: /\.match\(\s*\/<\s*\(\?|<\(\[\^>\]\+\)>/,
    severity: "hint",
    owners: ["packages/contracts/src/domain.ts"],
    fix: "Use parseMailbox(value) from @alfred/contracts for the name, address, local part and domain of a `Name <addr>` header, or parseEmailAddress(value) for the address alone (the single source of self-mail matching). mailboxLabel(value) is the display label; splitAddressList(value) splits a To/Cc list.",
  },
  {
    id: "email-domain-split",
    // `address.split("@")[1]` takes the text after the FIRST `@`, so
    // `a@b@x.com` gives `b`. `parseMailbox` and `splitEmail` share one split
    // body (a single `@`, `normalizeDomain`), so the domain has one home.
    re: /\.split\(\s*["'`]@["'`]\s*\)\s*\[\s*1\s*\]/,
    severity: "gate",
    fix: "Use parseMailbox(value)?.domain from @alfred/contracts. A split on the first `@` reads the wrong domain when the local part holds one.",
  },
  {
    id: "sender-regex-test",
    // An inline regex literal run with `.test(` over a sender value:
    // `/railway\.(app|com)/i.test(from)`. A substring test on the raw header
    // also matches the display name and a look-alike host (`railway.app.evil.io`,
    // `"Railway" <x@evil.io>`); the Railway matcher shipped that way until #1360.
    // `raw-email-normalize` covers the `.match(` header-split spellings, so it
    // misses this `.test(` spelling.
    //
    // The argument is an identifier (or a property chain ending in one) named
    // `from`, `fromHeader`/`fromAddress`/`fromEmail`, `sender…` or `…Sender…`.
    // A bare `…From` suffix is left out: `validFrom` and `dateFrom` are dates,
    // not senders. Only a regex LITERAL matches: the named constants
    // (`MONITORING_SENDER_RE.test(sender)` and its siblings in triage) test an
    // address substring or a display word, which is a different question, and
    // they predate the helpers. `hint`, because a display-name test
    // (`/^alfred/i.test(sender)`) is a fair use too.
    re: /\/[dgimsuvy]*\.test\(\s*(?:\w+\??\.)*(?:from|from(?:Header|Address|Addr|Email)|sender\w*|\w+(?:Sender\w*|FromHeader|FromAddress|FromAddr|FromEmail))\b/,
    severity: "hint",
    fix: "Read the sender's domain with parseMailbox(from)?.domain from @alfred/contracts, then compare it with isDomainOrSubdomain(domain, base). A regex over the raw header also matches the display name and a look-alike host.",
  },
  {
    id: "hand-rolled-domain-match",
    // `host === base || host.endsWith(`.${base}`)` — "is this the domain or a
    // subdomain of it", with the base in a variable. Five copies existed (web
    // inbox brand, Railway sender, two in entity-kind-classifier) before
    // `isDomainOrSubdomain`. Either operand order of the `===` matches, and so
    // does the `"." + base` spelling. `scope: "chain"`, because the formatter
    // breaks the `||` across lines inside a `.some(` callback.
    //
    // A bare `x.endsWith(`.${base}`)` with no equality half is a different
    // question (a PROPER subdomain only), and `identity-affiliation.ts` asks it
    // on purpose: `squarespace.com` itself can be an employer, its children
    // cannot. The rule does not match that spelling.
    re: /\b([\w.]+)\s*===\s*([\w.]+)\s*\|\|\s*(?:\1\.endsWith\(\s*(?:`\.\$\{\s*\2\s*\}`|["']\.["']\s*\+\s*\2\s*\))|\2\.endsWith\(\s*(?:`\.\$\{\s*\1\s*\}`|["']\.["']\s*\+\s*\1\s*\)))/,
    scope: "chain",
    severity: "gate",
    owners: ["packages/contracts/src/domain.ts"],
    fix: "Use isDomainOrSubdomain(domain, base) from @alfred/contracts. It matches whole labels and expects normalized (lowercase) values, as emailDomain and normalizeDomain return them. For a proper subdomain only, keep the bare endsWith.",
  },
  {
    id: "hand-rolled-domain-literal-match",
    // The same idiom with the base written out: `domain === "sentry.io" ||
    // domain.endsWith(".sentry.io")`. `hint`, because six such sites predate
    // the helper: three in `triage/sender-context.ts`, and one each in
    // `object-state/sentry-adapter.ts`, `hosted-endpoint.ts` and the web
    // `briefing-link.tsx`. The backreference pins both
    // halves to one value and one host, so a different host on either side does
    // not match.
    re: /\b([\w.]+)\s*===\s*(["'])([\w.-]+)\2\s*\|\|\s*\1\.endsWith\(\s*(["'])\.\3\4\s*\)/,
    scope: "chain",
    severity: "hint",
    fix: 'Use isDomainOrSubdomain(domain, "sentry.io") from @alfred/contracts. It expects normalized (lowercase) values, as emailDomain and normalizeDomain return them.',
  },
  {
    id: "hand-rolled-no-reply-regex",
    // A sender-word list outside the one table: a `no[-_.]?reply` alternation
    // inside a regex literal, or a `Set`/`Map`/array literal that opens with a
    // no-reply word. Five readers once kept five drifted copies of these words.
    // Chain scope, because a formatter puts each `Set` member on its own line.
    re: /no\[[-_.]+\]\??reply|(?:new\s+(?:Set|Map)(?:<[^>]*>)?\(|=)\s*\[\s*["'](?:no[-_]?reply|donotreply|do[-_]not[-_]reply)["']/,
    scope: "chain",
    severity: "gate",
    owners: ["packages/contracts/src/sender-class.ts"],
    fix: "Call classifyLocalPart(localPart) from @alfred/contracts. It returns the sender class (automated, role, group, none) and how the word matched (whole, edge, token). Map that result to your output through a total `satisfies Record<MatchedSenderClass, Record<LocalPartMatch, …>>` table. Add a new word to SENDER_WORDS in sender-class.ts, not to a local list.",
  },
  {
    id: "bullmq-job-timestamp",
    // `job.timestamp` is when BullMQ CREATED the job. For a job scheduler
    // (`upsertJobScheduler`) the next job is created when the previous one runs,
    // so the field lags its fire time by one interval. A tick that read it as
    // "now" dated briefings and daily memory runs one interval early (#1358).
    // The receiver must be named `job` or end in `Job` (`bullJob`), so an
    // unrelated `.timestamp` (`key.timestamp` in mcp/recovery.ts) is not read.
    //
    // `job.id ?? job.timestamp` is an IDENTITY fallback for a request id, not a
    // time reading (knowledge/queue.ts). The lookbehind skips a `.timestamp`
    // that is the right side of an `id ??`, so that site needs no marker.
    re: /(?<!\bid\s*\?\?\s*(?:\w+\.)?)\b(?:job|\w+Job)\.timestamp\b/,
    severity: "gate",
    owners: ["packages/assistant/src/execution/job-scheduler.ts"],
    fix: "Use scheduledFireTime(job) from @alfred/assistant/execution for the time a job scheduler fired this job for. BullMQ sets job.timestamp when it creates the job, one interval before a scheduled job runs. For when the job really started, read job.processedOn. If the value is an identity, not a time, append `// drift-ok: <what it identifies>`.",
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
    // `scope: "chain"`: the formatter puts each spread of a long literal on its
    // own line.
    re: /\{\s*\.\.\.(?:[A-Z][A-Z0-9_]{2,}|default[A-Z]\w*|defaults)\s*,\s*\.\.\./,
    scope: "chain",
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
    // Zero call sites outside the owner, hence "gate" on day one. A cluster
    // client (`new Redis.Cluster(…)`) is a hand-built client too.
    re: /\bnew\s+(?:IORedis|Redis)(?:\.Cluster)?\s*\(/,
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
  {
    id: "suppression-without-reason",
    // An `eslint-disable` / `oxlint-disable` directive (block, `-line` or
    // `-next-line`) that does not name its rules and then give a reason after
    // ` -- `. A bare directive silences every rule on the line or block, and a
    // directive with no reason cannot say whether its exemption is still true.
    // `--report-unused-disable-directives-severity=error` in `pnpm lint` catches
    // a directive that suppresses nothing, not one that suppresses too much.
    // `eslint-enable` takes no reason and is not read.
    //
    // The directive is a whole comment on one line, so this is a single-token
    // fact (docs/reference/gate-design.md): `comments: true` reads the comment
    // lines every other row skips. `(?![\w-])` stops the bare `-disable` spelling
    // from matching the front of `-disable-next-line`.
    //
    // `paths` reaches tests and scripts, because a directive there is as live as
    // one in product source. A generated file (`routeTree.gen.ts` opens with a
    // bare `/* eslint-disable */`) is not authored, and the vendored anti-slop
    // plugin is outside the lint walk.
    re: /\b(?:eslint|oxlint)-disable(?:-next-line|-line)?(?![\w-])(?!\s+[@\w/-]+(?:\s*,\s*[@\w/-]+)*\s+--\s+\S)/,
    comments: true,
    paths: /^(?!scripts\/oxlint\/anti-slop\/)(?:apps|packages|scripts)\/(?!.*\.gen\.ts$)/,
    severity: "gate",
    // This row's own definition and its fixtures spell the directive as data.
    owners: ["scripts/consolidation-rules.mjs", "scripts/consolidation-rules.selftest.mjs"],
    fix: "Name every rule the directive suppresses, in the spelling the config uses, then give the reason after ` -- `: `// oxlint-disable-next-line <plugin>/<rule> -- <why this line is the exception>`. See docs/reference/gate-design.md § Suppressions and disarms.",
  },
  {
    id: "raw-radius-class",
    // A t-shirt or arbitrary radius class in app code. Each one was a local
    // guess, so a 36px thread row came out at 14px beside a 32px button at
    // 10px. The `--radius-*` role tiers in apps/web/src/index.css `@theme`
    // are now the only radius names; `rounded-full`, `rounded-none`, and
    // `rounded-[inherit]` stay legal because they are shapes, not sizes.
    //
    // The token edges are a class list's edges (space, quote, backtick, the
    // `:` after a variant, the `!` important prefix), so `rounded-control`
    // and an identifier like `roundedCorners` never match.
    //
    // `paths` keeps the rule on the production app (WEB_APP_TOKEN_PATHS).
    re: /(?:^|[\s"'`:!])rounded(?:-(?:[trblsexy]|tl|tr|bl|br|ss|se|es|ee))?(?:-(?:xs|sm|md|lg|xl|[234]xl|\[(?!inherit\])[^\]\s]+\]))?(?=[\s"'`]|$)/,
    paths: WEB_APP_TOKEN_PATHS,
    severity: "gate",
    fix: "Use a role tier from apps/web/src/index.css: `rounded-control-xs` (20px and smaller: kbd, checkbox, tag), `rounded-control-sm` (24-28px controls), `rounded-control` (32-40px buttons, rows, inputs, menu items), `rounded-surface` (cards, banners, menus, popovers), `rounded-panel` (shell, sidebar, rail, composer, dialogs), or `rounded-full` for pills. Pick by what the element is, and give a container its inner tier plus its padding.",
  },
  {
    id: "raw-palette-color",
    // A raw Tailwind hue or gray, or a white-alpha step, in app code. Status
    // text used `text-rose-600` in one file and `text-red-600` in the next,
    // because the light `-4` tokens failed contrast; and the surfaces over the
    // weather video used ten white-alpha steps for four roles. Now each light
    // `-4` hue is AA text, and `.app-media` gives a fixed dark surface the
    // dark token values, so the `app-*` tokens cover both cases.
    //
    // Solid `white` and `black`, and `black/N` scrims, stay legal: paper,
    // switch thumbs, and overlays do not change with the theme.
    re: /(?:^|[\s"'`:!])(?:text|bg|border(?:-[trblxyse])?|ring(?:-offset)?|outline|divide|fill|stroke|from|via|to|decoration|placeholder|caret|accent|shadow)-(?:(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,4}|white\/(?:\d+|\[[^\]\s]+\]))(?:\/(?:\d+|\[[^\]\s]+\]))?(?=[\s"'`]|$)/,
    paths: WEB_APP_TOKEN_PATHS,
    severity: "gate",
    fix: "Use an `app-*` token from apps/web/src/index.css. Status: `text-app-{red,amber,green}-4` for text and solid fills, `-1` for a tint fill, `-2` for its border or ring, and `text-app-bg-1` for ink on a solid `-4` fill. On a fixed dark surface (video, lightbox, overlay), add `app-media` to its root and use `text-app-fg-a{1..4}` / `bg-app-bg-a{1..4}` for white-alpha ink and fills.",
  },
  {
    id: "replicache-subscribe-outside-helper",
    // A Replicache subscription written outside the one hook. Each data hook
    // wrote its own `rep.subscribe` with one of two loading rules, so one cold
    // store showed "empty" on some pages and "loading" on others, and some
    // pages hid cached rows behind a sync error.
    re: /\b(?:rep|replicache)\.subscribe\(/,
    paths: /^apps\/web\/src\//,
    severity: "gate",
    owners: ["apps/web/src/lib/replicache/use-replicache-subscription.ts"],
    fix: "Use useReplicacheSubscription(query, select?, { isEmpty? }) from ~/lib/replicache/use-replicache-subscription. It owns the one loading rule and keeps cached rows through a sync error.",
  },
];

/**
 * Path predicate → skip. Tests/evals/scripts/backfills legitimately use casts
 * and raw env reads for fixture ergonomics; generated + built output isn't
 * source. Plain `.mjs` is tooling (repo scripts, Claude hooks), not product
 * source; only a rule that names its own `paths` reads it. Shared so the gate
 * and the edit-time hook agree on scope.
 * @param {string} file Repo-relative path.
 */
export const isSkippedPath = (file) =>
  /(^|\/)(dist|build|coverage|node_modules)\//.test(file) ||
  file.endsWith(".mjs") ||
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
  // Skip whole-line comments — doc examples of a banned idiom are not drift —
  // except for a rule whose idiom is itself a comment.
  const trimmed = line.trim();
  const commentOnly = trimmed.startsWith("//") || trimmed.startsWith("*");

  return RULES.filter(
    (rule) =>
      rule.scope !== "chain" &&
      (!commentOnly || rule.comments === true) &&
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
