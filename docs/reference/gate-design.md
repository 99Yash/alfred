# Gate design — which kind of check a rule gets

A reviewer misses a rule on the day the reviewer is tired. A check is only as good as the instrument it runs on. This doc tells which instrument a new rule gets, when a gate must move to a stronger instrument, and what proves that a gate is armed.

Each rule has its enforcement status in one place:

- A rule that a gate enforces is in [enforced-rules.md](./enforced-rules.md). A script generates that file from the gates.
- A rule that only review enforces is in [review-checklist.md](./review-checklist.md).
- The [queue](#queue-review-only-rules-and-the-mechanism-that-would-enforce-them) at the end of this doc tells which mechanism could enforce each review rule.

## Enforcement tiers

A rule that holds several edits together needs a mechanism. Name the mechanism, because it decides whether the gap is closed.

| Tier | Mechanism | Effect |
| --- | --- | --- |
| 1 | Static enforcement | Types, lint, or a boundary check reject the wrong structure before runtime. |
| 2 | Runtime validation | The wrong value cannot enter or persist. |
| 3 | Centralized ownership | One place owns the fact or the operation. |
| 4 | Tests | A test detects divergence after it occurs. |
| 5 | Convention or documentation | A document asks people not to diverge. |

Only tiers 1 to 3 close a structural gap. A test detects drift after it occurs. A convention only asks. The tiers do not replace each other: a static type cannot validate untrusted runtime data, and an owner does not stop a bypass unless a check closes the other doors. Use the earliest tier that can state the rule. Combine tiers when the rule crosses a static, runtime and ownership boundary.

Examples in this tree:

- Tier 1: the `const _exhaustive: never` switch guard, and `check:web-boundaries`, which rejects a forbidden import.
- Tier 2: a zod parse at a boundary, such as the `safeParse` in `setLocalStorageItem`.
- Tier 3: `parseEmailAddress` as the one email matcher.
- Tier 5: "do not call `window.localStorage` outside `storage.ts`". Only that sentence enforces it.

## The ladder inside tier 1

Take the first rung that can state the rule. Each lower rung reads less of the program, so it misses more cases.

| Rung | Instrument | States | Fails |
| --- | --- | --- | --- |
| 1 | The compiler: types, `tsc` flags | which values a function accepts, which cases a mapping must cover | `pnpm check-types` |
| 2 | Type-aware lint: `typescript/*` in `.oxlintrc.json`, run through tsgolint | a fact that needs the type of an expression but is not a signature | `pnpm lint` |
| 3 | AST rule: `scripts/oxlint/alfred/` | scope, nesting, binding, data flow inside one file | `pnpm lint` |
| 4 | Regex row: `scripts/consolidation-rules.mjs` | one identifier, one call spelling, or one import specifier, on one line | `pnpm check:consolidation` |

A fact that is not about source code goes to a check script. Examples: a document (`check:pr-body`, `check:plan-status`), a config (`check:oxlint-config`), a manifest or the bundle graph (`check:web-boundaries`, `check:web-bundle-graph`), or reachability (`check:knip`).

After you add, remove or change a gate rule, run `pnpm rules:catalog` and commit `docs/reference/enforced-rules.md`. `pnpm check` fails while the catalog is stale.

### 1. Prefer the compiler

Put a rule about accepted values or required cases in the types. The compiler reads every call site through every alias and rename, so a later PR has no hole to close.

The techniques in the tree:

- **Closed literal union.** A `const` tuple is the source. The type, the `z.enum` and the membership check derive from it.
- **`satisfies Record<Union, T>`.** A map keyed by the union does not compile when a member has no entry. `VERDICT_BY_VERCEL_STATE` in `packages/assistant/src/connections/verified-pull/vercel.ts` is the model. A state outside the tuple fails `z.enum(...).safeParse` and becomes an explicit fault.
- **Closed-domain parameter.** A generic parameter resolves to an uninhabited marker interface when the argument is outside the domain. No value has that type, so the call does not compile. The key of the marker interface is the error message. `humanizeSlug` in `packages/contracts/src/tools.ts` uses it to reject an `IntegrationSlug` and any open string type. `OpenStringMember` detects an open string.
- **Exhaustive switch.** A `default` assigns the value to `const _exhaustive: never`.

```ts
// The closed-domain shape, reduced. The marker interface is the error message.
interface UseTheRegistryNotThisFunction {
  readonly "Use INTEGRATION_DISPLAY_NAMES[slug]": never;
}
export function format<S extends string>(
  value: S & ([Extract<S, IntegrationSlug>] extends [never] ? unknown : UseTheRegistryNotThisFunction),
): string {
  /* … */
}
```

When a rule must see across files and a lint rule cannot, close the domain. Make one module the owner, and make every other module unable to reach the primitive. Example: `@alfred/db/hash` is the one hash owner, and `alfred/no-exported-hasher` rejects any other exported function whose parameter flows into a digest.

### 2. Then type-aware lint

Use a `typescript/*` rule for a fact that needs types but cannot be a signature. Examples: a promise that nobody awaits, or a switch that misses a union member. [typescript.md](./typescript.md#type-aware-lint) tells how to satisfy each rule at `error`.

Drive the tree to zero, then add the rule at `error`. Add one rule per change. A rule at `warn` enforces nothing, because `pnpm lint` does not fail on a warning.

### 3. Then an AST rule

Use a rule in `scripts/oxlint/alfred/` for scope, nesting, binding or data flow. Examples: which binding a name resolves to, whether a reference reads or writes, and what flows into a call. The plugin's `README.md` gives the layout, the fixture file and the three steps to register a rule. A rule that replaces a consolidation row keeps the file scope of that row through `inGateScope`.

An AST rule also speaks at edit time: `.claude/hooks/lint-on-edit.mjs` lints each file that an agent writes.

### 4. Regex only for single-token facts

A row in `scripts/consolidation-rules.mjs` is correct when the fact is one identifier, one call spelling, or one import specifier, on one line. A regex reads text, not code. It cannot tell which binding a name resolves to. It cannot count nesting. The formatter can split its idiom across lines. A row that needs `scope: "chain"`, a backreference to a binding, or a look-around for an import describes an AST rule.

A row has two strengths that the other rungs do not have. `.claude/hooks/helper-hints.mjs` shows its `fix` at edit time. Its `hint` severity advises without a failure while legacy call sites remain.

## Port trigger

**If a regex gate needs a second round of hole fixes, port it to the next rung up. Do not patch it again.**

The first round is normal: the row meets the tree. A second round shows that the instrument cannot read the shape. Each later round finds the next spelling that it cannot read. A compiler rule has no spelling to find, because it reads the type of the argument, not its text. The cases that taught this rule are in [gate-design-evidence-2026-10-18](../research/gate-design-evidence-2026-10-18.md).

## A green gate proves nothing about itself

A gate passes on a clean tree when it is armed and when it is dead. Each new rule ships with a planted-violation probe. The probe asserts the diagnostic text, not the exit code. See `.lessons/a-green-lint-run-cannot-tell-an-armed-fence-from-a-dead-one.md`, `.lessons/plant-a-violation-probe-assert-the-diagnostic-not-the-exit-code.md` and `.lessons/equality-probe-fails-open-prove-it-could-have-failed.md`.

The probe on each rung:

- **Regex row.** The self-test fails `pnpm check` when a `gate` row has no must-catch fixture that names it.
- **AST rule.** `pnpm check:oxlint-plugin` runs the RuleTester fixtures. Then it lints each `invalid` case through the root `.oxlintrc.json` and fails unless the rule reports it at `error`.
- **Type-aware rule.** No check drives a planted violation through the `typescript/*` rules. The PR that adds one shows the probe output in its body.
- **Compiler guard.** A type that rejects nothing is still green. Prove the guard once with a call that must fail to compile. Run it in the PR and report it in the PR body. `CLAUDE.md` forbids a committed `@ts-expect-error` fixture.

A gate built on a declared list proves only the rows in the list, not the next instance (`.lessons/a-declared-list-gate-cannot-see-the-instance-nobody-declared.md`). Prefer a rule that finds the instance because someone wrote it.

## Suppressions and disarms

A suppression says "this line is the one exception". The gates check its form. Review checks that its reason is still true.

- Name each rule in the spelling that the config uses, and give the reason after ` -- `. The `suppression-without-reason` row enforces this.
- `pnpm lint` runs with `--report-unused-disable-directives-severity=error`, so a directive that suppresses nothing fails the build. Delete it. Do not keep a directive "in case the rule comes back".
- An `overrides` entry that turns a rule `"off"` for authored source needs an `// oxlint-disarm: <rule> — <why>` comment beside the key. `pnpm check:oxlint-config` enforces this, except in test and eval scopes, where a blanket `"off"` is correct.
- An override REPLACES the options of a rule. A scoped `no-restricted-imports` entry therefore restates each root group, or names an omitted group with an `oxlint-omission:` marker.

## Queue: review-only rules and the mechanism that would enforce them

Each row is a smell that review owns, from [smells/](./smells/README.md), with the rung that would enforce it and a status. **Candidate**: a gate is planned, and the issue names the work. **High**: the rule exists or is small, and the tree is near zero. **Medium**: the tree needs a paydown, or the rule is a narrow first-party rule. **Low**: a check cannot separate the good case from the bad case without many false positives. **Stays review**: decided, with the reason. **PRs** counts the PRs where a review found the smell.

`node scripts/smells.mjs` writes this table from the smell files. Do not edit it here. When a smell gets a gate, set `status: gated` and `rule:` in its file. The smell then leaves this table and the checklist, and keeps its examples. When reviews find a `review` smell in two PRs and a check can state it, `pnpm check:smells` fails until the smell gets a decision.

<!-- smells:queue:start -->
<!-- Generated by scripts/smells.mjs from docs/reference/smells/. Run `node scripts/smells.mjs` after you change a smell. -->

| Smell (checklist section) | Mechanism | Status | PRs |
| --- | --- | --- | --- |
| [`guards-only-on-unknown`](./smells/guards-only-on-unknown.md) (Types) | Compiler: a closed-domain parameter that rejects an argument whose type is not `unknown`. | Candidate, #1629 | 7 |
| [`bind-credential-not-token`](./smells/bind-credential-not-token.md) (Backend) | Compiler: client factories that take a credential id and never a token, one provider at a time. | Medium | 1 |
| [`no-query-in-loop`](./smells/no-query-in-loop.md) (Backend) | AST: a query on a `db()` or transaction handle awaited inside a loop body or an async `.map`. | Medium | 1 |
| [`no-updated-at-queue-key`](./smells/no-updated-at-queue-key.md) (Backend) | AST: an `updatedAt` column inside an ordering or a comparison in a query chain. | Medium | 1 |
| [`accessible-controls`](./smells/accessible-controls.md) (Frontend) | Lint: the `jsx-a11y` plugin, one rule per change. | Medium | 0 |
| [`existence-assert-pairs-behavior`](./smells/existence-assert-pairs-behavior.md) (Tests) | AST: a `test` block whose only assertions are of that kind. | Medium | 0 |
| [`mock-test-asserts-wire`](./smells/mock-test-asserts-wire.md) (Tests) | AST: a `test` block whose only assertions are of that kind. | Medium | 0 |
| [`pin-one-side-of-equality`](./smells/pin-one-side-of-equality.md) (Tests) | AST: two calls of one callee inside one `assert.equal`. The regex row is a `hint`. | Medium | 0 |
| [`webhook-signature-raw-body`](./smells/webhook-signature-raw-body.md) (Backend) | Compiler: the verifier takes a branded raw-body type that only the raw-body reader mints. | Medium | 0 |
| [`name-timestamp-clock`](./smells/name-timestamp-clock.md) (Backend) | Compiler: a brand for each clock. A wide migration for a rare bug. | Low | 1 |
| [`no-swallowed-try-catch`](./smells/no-swallowed-try-catch.md) (Backend) | AST: a `catch` clause with statements that does not rethrow, log or return a failure value. The tree has about 500 `catch` clauses, and many of them map a fault to a value that the caller tells apart, such as `return null` for "a fault proves nothing" in `connections/verified-pull/`. An AST rule cannot tell that value from a value that hides the fault, so a first rule needs a narrow shape and a paydown of its own. | Low | 1 |
| [`literal-pin-needs-why`](./smells/literal-pin-needs-why.md) (Tests) | An AST rule cannot tell a policy literal from a change detector. | Low | 0 |
| [`prose-not-safer-than-code`](./smells/prose-not-safer-than-code.md) (Process) | A check cannot compare a claim with the sequences that the code permits. The campaign review ranks an overclaim `must-fix` and an underclaim `nit` (`.claude/skills/campaign/REVIEW.md`). | Stays review | 5 |
| [`external-call-deadline-and-sibling-cancel`](./smells/external-call-deadline-and-sibling-cancel.md) (Backend) | No one check can state it. Each client names its deadline in its own option, or has no option, and a wrapper such as `createGuardedFetch` can add the signal for its callers. So a call with no visible option can be correct. To find the siblings of a `Promise.all` that share no controller, a check must follow values across functions. | Stays review | 4 |
| [`app-lifetime-data-outside-mount`](./smells/app-lifetime-data-outside-mount.md) (Frontend) | The lifetime of the data is a product fact, not a fact in the code. | Stays review | 3 |
| [`brand-claim-needs-probe`](./smells/brand-claim-needs-probe.md) (Types) | The claim is prose, so no check can separate the Bad doc from the Good doc. Both recorded hits are forms that no syntax rule sees: a swap of two arguments of one type (#1548), and a cast and a merge (#1540). Review keeps this smell. | Stays review | 2 |
| [`find-item-by-id`](./smells/find-item-by-id.md) (Frontend) | `.at(-1)` and index 0 are correct on a list that keeps its order. A check cannot tell that list from a list that changes order. | Stays review | 2 |
| [`search-prose-after-rename`](./smells/search-prose-after-rename.md) (Process) | `check:doc-symbols` and `check:prose-locators` catch a dead backticked name. A plain-word name is not a token that a check can resolve. | Stays review | 2 |
| [`check-issue-premise`](./smells/check-issue-premise.md) (Process) | Not a fact in the code. | Stays review | 1 |
| [`closed-provider-status-map`](./smells/closed-provider-status-map.md) (Backend) | The compiler holds a map after someone writes it. To decide that one is necessary is design. | Stays review | 1 |
| [`idempotent-retried-work`](./smells/idempotent-retried-work.md) (Backend) | Each needs knowledge of intent that the code does not state. | Stays review | 1 |
| [`name-for-domain-role`](./smells/name-for-domain-role.md) (Types) | A substring ban cannot tell a credential `shape` field from `DayShape` (#1149). | Stays review | 1 |
| [`one-return-value-per-state`](./smells/one-return-value-per-state.md) (Backend) | The compiler holds a map after someone writes it. To decide that one is necessary is design. | Stays review | 1 |
| [`scripts-call-live-owner`](./smells/scripts-call-live-owner.md) (Backend) | A copy compiles. `no-restricted-imports` already fences each `internal` door. | Stays review | 1 |
| [`atomic-multi-step-write`](./smells/atomic-multi-step-write.md) (Backend) | Each needs knowledge of intent that the code does not state. | Stays review | 0 |
| [`centralize-only-when-copies-change-together`](./smells/centralize-only-when-copies-change-together.md) (Constants and ownership) | `check:duplicates` finds copies. Whether they change together is judgment. | Stays review | 0 |
| [`check-dts-before-library-claim`](./smells/check-dts-before-library-claim.md) (Types) | Not a fact in the code. | Stays review | 0 |
| [`choose-open-dictionary-type`](./smells/choose-open-dictionary-type.md) (Types) | `anti-slop/no-unsafe-dictionary-type` already rejects `Record<string, unknown>`. Which of the four forms fits is a design choice. | Stays review | 0 |
| [`constant-at-narrowest-owner`](./smells/constant-at-narrowest-owner.md) (Constants and ownership) | Placement follows ownership, not file type. A file-exists gate or a literal ban fires on correct code. | Stays review | 0 |
| [`constants-file-only-when-coupled`](./smells/constants-file-only-when-coupled.md) (Constants and ownership) | `42` and `EMPTY_COMPLETION_MAX_RETRIES = 42` depend on context. A literal ban fires on simple arithmetic. | Stays review | 0 |
| [`delta-class-across-component`](./smells/delta-class-across-component.md) (Frontend) | `alfred/no-delta-class-utility-collision` reads one element in one file. The class and the delta meet only after a component renders. | Stays review | 0 |
| [`derive-row-type-from-table`](./smells/derive-row-type-from-table.md) (Types) | A correct derive depends on column traps and on intentional reshapes such as `Synced*`. A checker cannot separate a reshape from drift. `pnpm schemas:dupes` stays a discovery aid. | Stays review | 0 |
| [`effect-cleanup`](./smells/effect-cleanup.md) (Frontend) | `react/exhaustive-deps` checks the dependency array. Whether an effect owns a resource to release is behavior. | Stays review | 0 |
| [`endpoint-auth-and-migrations`](./smells/endpoint-auth-and-migrations.md) (Backend) | Each needs knowledge of intent that the code does not state. `db:push` is a command that someone runs, not a fact in the source. | Stays review | 0 |
| [`env-var-only-for-deploy-knob`](./smells/env-var-only-for-deploy-knob.md) (Constants and ownership) | Whether a value is a knob is a deploy fact, not a fact in the code. | Stays review | 0 |
| [`literal-type-only-for-new-concept`](./smells/literal-type-only-for-new-concept.md) (Types) | A check cannot tell an intentional reshape from drift. A literal type that copies a row type can be a wire reshape or a stale copy, and only the comment says which. | Stays review | 0 |
| [`name-policy-number`](./smells/name-policy-number.md) (Constants and ownership) | `42` and `EMPTY_COMPLETION_MAX_RETRIES = 42` depend on context. A literal ban fires on simple arithmetic. | Stays review | 0 |
| [`one-owning-schema-per-shared-shape`](./smells/one-owning-schema-per-shared-shape.md) (Types) | A correct derive depends on column traps and on intentional reshapes such as `Synced*`. A checker cannot separate a reshape from drift. `pnpm schemas:dupes` stays a discovery aid. | Stays review | 0 |
| [`optional-field-absence-choice`](./smells/optional-field-absence-choice.md) (Types) | The choice depends on what each consumer does with absence. | Stays review | 0 |
| [`render-every-state`](./smells/render-every-state.md) (Frontend) | Behavior, not shape. | Stays review | 0 |
| [`shape-in-minting-file`](./smells/shape-in-minting-file.md) (Types) | Placement follows ownership, not file type. A file-exists gate or a literal ban fires on correct code. | Stays review | 0 |
| [`show-error-to-user`](./smells/show-error-to-user.md) (Frontend) | Behavior, not shape. | Stays review | 0 |
| [`ssr-guard-and-sanitize-html`](./smells/ssr-guard-and-sanitize-html.md) (Frontend) | Behavior, not shape. | Stays review | 0 |
| [`suppression-reason-stays-true`](./smells/suppression-reason-stays-true.md) (Process) | A check cannot read whether a reason is still true. The unused-directive check reads whether a directive suppresses a report, not its reason text. | Stays review | 0 |
| [`zod-infer-not-parallel-interface`](./smells/zod-infer-not-parallel-interface.md) (Types) | A correct derive depends on column traps and on intentional reshapes such as `Synced*`. A checker cannot separate a reshape from drift. `pnpm schemas:dupes` stays a discovery aid. | Stays review | 0 |
<!-- smells:queue:end -->
