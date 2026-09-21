# Anti-slop paydown: what the five `warn` rules are actually catching

Research date: 2026-09-12

Status: the three mechanical fixes landed on 2026-09-12 (1,056 -> 963). The
test/script scoping and the seam typing are proposed, not applied.

## The question

Five vendored `anti-slop` rules sit at `warn` and carry live violations. The
working theory was that the tree is full of low-evidence TypeScript written by
agents: redundant casts, cargo-culted `SAFETY:` comments, `unknown` contracts,
and vague `shape` names. This note measures whether that theory holds, so the
next change pays down the right debt instead of suppressing noise.

## Decision

Do not treat the 1,056 live warnings as 1,056 agent mistakes. Roughly half are
outside product source (`test/`, `evals/`, `scripts/`), and two of the five rules
are vendored at a revision that predates upstream fixes which the repo's own
README describes as correct. Land the two upstream ports first; they are
mechanical and provably remove 93 warnings. Then decide, per rule, between a
product-code fix, a scoped test/script exemption, and an honest rule rejection —
using the ownership questions below rather than the raw count.

## Method

- `pnpm exec oxlint --config .oxlintrc.json --format json .` on a clean
  `refactor/deepen-boss-turn` tree.
- Bucketed each diagnostic by rule and by surface: `src`, `test/eval`, `script`.
- Re-ran with two prototype changes to isolate their effect: the upstream
  exemptions for `no-shape-in-symbol-names` and `no-runtime-typeof`, and the
  `allowInTypeGuards` option.
- Read the vendored rule source and the current upstream source side by side.

Counts drift with every commit; they are a snapshot for prioritisation, not a
gate.

## Inventory (1,056 warnings)

| Rule | Total | `src` | `test`/`eval` | `scripts` |
| --- | ---: | ---: | ---: | ---: |
| `no-runtime-typeof` | 427 | 290 | 64 | 73 |
| `require-safety-comment-for-type-assertion` | 219 | 8 | 211 | 0 |
| `no-shape-in-symbol-names` | 164 | 84 | 40 | 40 |
| `no-unsafe-dictionary-type` | 152 | 64 | 81 | 7 |
| `no-unknown-returns` | 94 | 82 | 11 | 1 |
| **Total** | **1,056** | **528** | **407** | **121** |

The four `error` rules are already clean. Nothing here touches them.

**The single most important row is the split.** 528 of 1,056 warnings (50%) are
in `test/`, `evals/`, or `scripts/`, where the rule's premise — "external values
must be decoded at their I/O boundary" — mostly does not apply. A test that
casts a fixture or a Node script that probes `typeof` a parsed JSON field is not
the code these rules exist to police.

## Per-rule findings

### `no-runtime-typeof` — 427

What it rejects: a `typeof` check that narrows an unparsed value instead of
parsing it at the boundary.

What it actually matches here, by source-line shape:

| Shape | Count |
| --- | ---: |
| `typeof x === "string"` | 204 |
| `typeof x !== "string"` | 55 |
| `typeof x === "number"` | 41 |
| other / multiline | 36 |
| `typeof x === "undefined"` | 34 |
| `typeof x === "object"` | 24 |
| `typeof x !== "object"` | 21 |
| `typeof x === "function"` | 10 |
| `typeof x === "boolean"` | 2 |

Two findings:

1. **The vendored rule lacks upstream's existence-probe exemption.** Current
   upstream returns early for `typeof x === "undefined"` because that probes
   whether a binding exists, not what representation a value has. The vendored
   copy at `446268e` has no such arm. Porting it removes **30** warnings with no
   policy change.
2. **`allowInTypeGuards` is available and off.** The rule already ships the
   option; enabling it removes **44** warnings for checks inside a `value is T`
   predicate — exactly where `typeof` is the correct implementation. Together
   the two changes take this rule from 427 to **353** (`-74`).

The remaining ~353 are real narrowing checks. A large fraction are the
repository's own boundary modules (`packages/contracts/src/guards.ts`,
`packages/env/src/server.ts`, `packages/contracts/src/tool-schemas.ts`), where
`typeof` *is* the parse. That is the same conflict that kept
`no-unknown-parameters` out of the vendored set: the rule rejects the signature
of the validators the root rules mandate. Do not drive this rule to zero; scope
it away from the boundary modules or accept it as a `hint`.

### `no-shape-in-symbol-names` — 164

What it rejects: the case-insensitive substring `shape` in a symbol name.

The vendored rule flags **every** `Identifier`, including static member reads.
Current upstream adds `isBorrowedMemberName`, which exempts `schema.shape` and
every other non-computed member read whose name belongs to another value and
cannot be renamed locally. Porting it removes **19** warnings (164 → 145).

The remaining 145 split three ways:

- **Genuine rule targets.** `packages/contracts/src/integrations/registry.ts`
  and `types.ts` name a credential field `shape` (`{ shape: "google_oauth" }`).
  "Shape" is exactly the vague structural noun the rule wants replaced with a
  domain role (`credentialKind`, `credentialType`). This is a contract rename,
  not lint noise.
- **Legitimate domain names.** `DayShape`, `day_shape`, `gatherDayShape`,
  `DAY_SHAPE_BUSY_AT`. These are a real product concept (how a day looks),
  well-named, and used by a tool literally called `get_day_shape`. Renaming them
  to satisfy a substring ban is the tail wagging the dog.
- **Test/script helper names.** `nestedShapeFailures`, `shapeFails`,
  `isCodeShaped`, `shapeKey`, `shapeFor`. Pure noise.

Verdict: this rule is the worst signal-to-noise ratio in the set. Options, in
order of preference: (a) scope it off for test/eval/script paths, (b) rename the
credential `shape` field and exempt the `DayShape` domain, or (c) drop the rule
and state the naming preference in `code-style.md` instead.

### `require-safety-comment-for-type-assertion` — 219

What it rejects: a non-const assertion without a nearby `SAFETY:` comment.

**211 of 219 are in tests/evals.** The 8 source warnings are ordinary. The
repository has 236 `SAFETY:` comments, and the ones in production source are
specific and load-bearing (e.g. `packages/ai/src/tool-name-codec.ts`,
`packages/sync/src/sync-model.ts`). So the rule works where it has signal.

The noise is structural: a test that does `fixture as AgentTranscriptMessage`
to feed a seam is entitled to that cast without narrating an invariant TypeScript
cannot see. Exempt `**/*.test.ts` and `evals/`, fix the 8 source sites, then
consider promotion. This is the cheapest large win in the set (`-211`).

The user-observed "redundant safety comments" are real but distinct: 34 sites
carry the byte-identical suppression
`-- boundary cast: source type is structurally incompatible with target` on
`anti-slop/no-chained-type-assertions`. A template justification repeated 34
times is not a described invariant. It satisfies the rule and teaches nothing.
The `no-chained-type-assertions` `error` ratchet is what forces these; that
rule's own fixtures should carry the debt, not 34 production files with the same
sentence.

### `no-unsafe-dictionary-type` — 152

What it rejects: a dictionary whose value type is `unknown`, `any`, `object`,
`{}`, or a union containing one. All 152 live violations are the `unknown`
value.

Two clusters:

- **Canonical boundary surface (keep).** `isRecord`/`toRecord` in
  `packages/contracts/src/guards.ts`, `safeJsonParse`, `getPath`,
  `pruneToBudget`, `log-redaction.walk`, `sanitize`, MCP argument bags,
  `packages/sync` normalization. `docs/research/narrow-record-types-2026-08-09.md`
  already adjudicated these: an honest dynamic dictionary with a validated value
  is not debt, and "zero `Record<string, unknown>` spellings" is explicitly the
  wrong success metric. The rule flags the helpers the repo tells everyone to
  use.
- **Test seams (scope out).** `packages/auth/test/encrypted-auth-adapter.test.ts`
  alone carries 21; the rest are mock rows, `asRecord` test helpers, and
  `Record<string, unknown>` capture buffers. Same reasoning as the safety rule.

Verdict: this rule cannot be driven to zero without replacing honest types with
aliases. The paydown is (1) a test/eval exemption, and (2) a small, named set of
production sites to narrow per the `narrow-record-types` decision table. Keep
the rule as a `hint`, not a gate.

### `no-unknown-returns` — 94

What it rejects: an explicit `unknown` / `Promise<unknown>` return contract.

This is the rule with the highest signal in product code — 82 of 94 are `src` —
and it points straight at the seam the user flagged:

- `packages/assistant/src/tool-runtime/index.ts` carries **34** of the 94**,**
  almost all of it the nine `bootPort` adapters: every method of
  `SystemToolKnowledgeAdapter`, `SystemToolTaskAdapter`,
  `SystemToolAgentAdapter`, and `SystemToolChatHistoryAdapter` returns
  `Promise<unknown>`.
- Boundary parsers legitimately return `unknown` (`safeJsonParse`, `getPath`,
  `canonicalize`, `parseBody`, `walk`, `pruneToBudget`), and BullMQ job
  processors (`processIngestionJob`, `processMemoryJob`, …) return
  `Promise<unknown>` because that is the queue's contract.

The user's read is correct: `SystemToolKnowledgeAdapter` is a grab-bag. Its
header says it owns "knowledge reads, standing-instruction writes, and live web
search" — six unrelated operations behind one 6-method port, every one of them
returning `unknown`. The seam exists to invert `tool-runtime -> knowledge`, and
its doc comment admits the reason each method returns `unknown` is to avoid a
type crossing the seam, not because the caller has no contract. The caller
(`internal/tools/system.ts`) immediately returns that `unknown` into a tool
result, so the erased contract propagates into the model-facing surface.

Two honest resolutions, to be decided in the ADR that owns the seam (ADR-0089):

1. **Split the port by product owner** (`knowledge` reads vs `web search` vs
   suppression write) and give each method its real result type. `tool-runtime`
   may `import type` from the owner without creating a runtime edge; type-only
   imports are erased. The current "unknown so nothing crosses" rule is stronger
   than the module cycle it guards against.
2. **Keep `unknown` and own it.** Then this is a rule the repo rejects on
   purpose, like `no-unknown-parameters`, and the doc comment should say so
   instead of framing `unknown` as the design.

Either way, `SystemToolKnowledgeAdapter` should not stay as six `unknown`s in
one interface.

## Cross-cutting root causes

1. **The vendored rules are older than the README describes.** The README states
   that the second upstream revision "carries upstream fixes to rules we keep at
   the first; porting those is a separate change." The two ports measured here
   are that change. This alone accounts for 49 warnings that are rule bugs, not
   code bugs.
2. **Several rules conflict with repo invariants.** `no-unknown-parameters`,
   `no-reflect-get`, and `no-conditional-empty-object-spread` are already
   excluded for exactly this reason. `no-runtime-typeof` on boundary validators
   and `no-unsafe-dictionary-type` on the canonical guards are the same shape of
   conflict; they were kept because they are only `warn`, but the conflict is
   identical.
3. **Three of the five rules mostly police tests and scripts.** 407 warnings are
   test/eval, 121 are scripts. A rule at `warn` that never fires on product code
   is a rule that has not been scoped.
4. **A substring ban is not a naming policy.** `no-shape-in-symbol-names`
   cannot distinguish `DayShape` from `ResponseShape`; it mechanically flags
   `schema.shape`, `nestedShapeFailures`, and a real domain type with one test.
5. **Real contract erosion lives in the seams.** The one rule that is mostly
   product code (`no-unknown-returns`) points at adapter interfaces that erase
   their result types. That is the debt worth paying.
6. **Suppression boilerplate is a smell.** 34 identical `boundary cast` disables
   show an `error` ratchet being satisfied by a repeated sentence. Invariants
   that need 34 copies are usually one missed abstraction.

## Measured fix catalogue

| Change | Removes | Risk |
| --- | ---: | --- |
| Port existence-probe exemption to `no-runtime-typeof` | 30 | None; upstream behavior |
| Enable `allowInTypeGuards` for `no-runtime-typeof` | 44 | None; documented option |
| Port `isBorrowedMemberName` to `no-shape-in-symbol-names` | 19 | None; upstream behavior |
| Exempt `*.test.ts` + `evals/` from the safety-comment rule | 211 | Policy; rule keeps 8 source sites |
| Exempt tests from `no-unsafe-dictionary-type` | ~81 | Policy; matches `narrow-record-types` |
| Exempt `scripts/**` from `no-runtime-typeof` | 73 | Policy; scripts are not typed product code |
| Type the tool-runtime adapter results | up to 34 | Design; needs an ADR-0089 amendment |

The first three are mechanical and take the tree from 1,056 to 963. The
test/script scoping takes it to roughly 600. The remaining ~600 are the
irreducible set to adjudicate by ownership, not by count.

## Ownership questions for the irreducible set

Use these instead of the spelling, consistent with
`docs/research/narrow-record-types-2026-08-09.md`:

1. Is this a true `unknown` boundary (unparsed JSON, webhook, provider trace,
   driver error)? Then `typeof`/`getPath`/`isRecord` is the correct parse and the
   rule should not fire.
2. Does a schema, Drizzle row, or SDK instance already own the type? Then the
   `unknown` is erasure and should be narrowed.
3. Does the value cross a boot seam? Then the seam's interface should carry the
   owner's result type or state up front why it does not.
4. Is the code a test fixture or a Node script? Then the rule's premise does not
   apply; scope it out rather than suppressing per line.

## Phased plan

1. **Port the two upstream exemptions.** Update the two rule files, add the
   upstream valid fixtures, and note the revision in the anti-slop README. Run
   `pnpm check:oxlint-plugin`. (`-49`)
2. **Enable `allowInTypeGuards`.** One config line. (`-44`)
3. **Scope the three rules by surface.** Add overrides for `**/*.test.ts`,
   `**/*.eval.ts`, and `apps/**/evals/**`, plus the safety rule in `scripts/`.
   Then fix the surviving source warnings. (`~-365`)
4. **Adjudicate `no-shape-in-symbol-names`.** Decide rename vs exempt vs drop;
   the `DayShape` domain and the credential `shape` field are the test cases.
5. **Type or own the tool-runtime seams.** Amend ADR-0089 and either give the
   adapters real result types or document `unknown` as the interface.
6. **Only then promote anything to `error`.** A rule is promoted when its
   *product* findings are zero, not its total.

## Open questions

- Should the safety-comment rule apply to tests at all, or is a test's intentional
  cast self-justifying?
- Is the credential `shape` field worth renaming to `credentialKind` to keep the
  naming rule honest?
- Does `tool-runtime` accept type-only imports from owners, or is the boot seam
  required to stay structurally type-free?

## Sources

- Vendored rules and provenance: `scripts/oxlint/anti-slop/README.md`.
- Repo adjudication of open dictionaries:
  `docs/research/narrow-record-types-2026-08-09.md`.
- Enforcement split: `docs/reference/code-asserts.md`, `.oxlintrc.json`.
- Current upstream rule behavior:
  [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) —
  `no-shape-in-symbol-names` (`isBorrowedMemberName`) and `no-runtime-typeof`
  (`isExistenceProbe`).
- Seam ownership: `docs/reference/tool-runtime-map.md`, ADR-0089.
