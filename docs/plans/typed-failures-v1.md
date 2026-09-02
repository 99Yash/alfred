# Typed failures v1 — one catalog, one classifier per seam, a structured fix

> **Status.** PR 1 (the catalog) built on branch `feat/typed-failures-catalog`, 2026-09-02.
> PRs 2 to 5 are not started. Deviations from section 7 are listed at the end of section 7.
> This plan reshapes the error
> surfaces that already exist. It does not add a library. It amends the tagged-error
> philosophy of `packages/contracts/src/errors.ts` and extends
> [ADR-0072](../decisions/ADR-0072-chat-failure-taxonomy-is-structured-not-sniffed.md)
> (structure first, never sniff) from the chat seam to the tool seam. Write an ADR before
> PR 2 lands, because PR 2 changes what the boss model reads after a tool fails.

Cross-references: the throw-poison sanitizer in
[ADR-0070](../decisions/ADR-0070-persistence-poison-resistance-a-non-progressing.md)
(the reason the public registry is closed), the
connect-nudge payload in `packages/contracts/src/chat.ts` (#378 item 3), and the
structural method in [structural-review.md](../reference/structural-review.md).
Code: `packages/contracts/src/app-errors/index.ts` (the registry),
`packages/contracts/src/api-errors.ts` (HTTP codes), `packages/assistant/src/tool-runtime/internal/dispatch/index.ts`
(`toPublicAppError` at the catch sites), `packages/assistant/src/tool-runtime/internal/result-routing.ts`
(`connectNudgeFromDispatch`), `packages/assistant/src/chat/chat-failure-kind.ts`
(`classifyChatFailure`), `apps/web/src/routes/-chat/message-bubble.tsx` (`FAILURE_PRESENTATION`).

---

## 1. The obligation

Every failure that crosses a boundary must carry three things: a **code** from a closed
catalog, a **message** that the code decides, and a **fix** that a machine can read.
Free text from an exception must never cross a boundary. The boundaries are: the boss
model (a tool result), the client (a chat error or a tool card), the HTTP wire (an
`ApiError`), and persistence (`execute_error` on a staging row).

A second obligation follows from the first. When a new typed failure appears in the
code, the classifier at each seam must fail to compile until it maps that failure. Today
the map is a convention.

## 2. What exists, and where it drifts

The repo has four encodings of "a failure that a human or a model must act on".

| Encoding                                                      | Owner                     | Has code    | Has fix                 | Consumer                |
| ------------------------------------------------------------- | ------------------------- | ----------- | ----------------------- | ----------------------- |
| `ApiError` + `Errors.*`                                       | `contracts/api-errors.ts` | yes         | no                      | HTTP client             |
| `APP_ERROR_REGISTRY` + `AppError`                             | `contracts/app-errors/`   | yes         | inside the message text | boss model, persistence |
| `ChatErrorKind` + `FAILURE_PRESENTATION`                      | `contracts/chat.ts` + web | yes         | `retry` field, web only | chat bubble             |
| Typed classes (`GoogleReauthRequiredError`, `HttpError`, ...) | each integration          | some `_tag` | no                      | in-process catch sites  |

Findings from the survey on 2026-09-02, ordered by the revealer that exposes them:

1. **The tool seam collapses every unknown throw.** `toPublicAppError(err)` maps any
   error that is not an `AppError` to `tool_execution_failed`. The model reads "The tool
   failed unexpectedly. Please try again." Typed failures exist upstream
   (`GoogleReauthRequiredError`, `MissingScopesError`, `HttpError` 401/404/429,
   `McpOAuthAuthorizationRequiredError`, `RailwayGraphqlError`) and none of them reaches
   the model as a code. Axis: **misplacement**. The knowledge "which failures are
   remediable" lives in the integration package and dies at the dispatcher.
2. **Nine of 23 registry codes have zero producers.** All Gmail, Drive, Docs, Sheets,
   Slides, and generic Google connection and scope codes are dead. Only the GitHub code is
   live. The registry hand-expanded a cross product (integration × failure kind) that the
   type system could have derived. Axis: **restated shape** and **loose representation**.
3. **Three encodings of "how to recover".** `FAILURE_PRESENTATION.retry`, the
   `chatConnectNudge` action, and the phrase "Reconnect X in settings" inside fifteen
   registry messages all encode one domain fact. Axis: **repetition**. A new remediation
   kind (for example "start a new thread") touches three files with nothing to force the
   third.
4. **One vocabulary, two names.** `ToolUnavailabilityCode` has `not_connected`,
   `needs_reauth`, and `missing_scope`. The registry has `*_connection_required` and
   `*_scope_required`. The health floor speaks the first; the tool body speaks the second.
   Axis: **conflation** of two catalogs that describe one lifecycle.
5. **Compaction uses the message as the code.** Seven throws in
   `packages/assistant/src/chat/compaction/` use `new Error("conversation_summary_...")`
   and `isUnrecoverableConversationCompactionError` tests a prefix list. The header of
   `errors.ts` names this exact anti-pattern. Axis: **loose representation**.

### The required-knowledge test on the tool seam

Write the naive call. A tool author who does not know the repo writes:

```ts
if (!token) throw new Error("Gmail is not connected");
```

It compiles. It passes review. The model reads "The tool failed unexpectedly." The
correct knowledge is "throw `AppError` with a registry code, and add a code if none
fits". That knowledge is tier 5. The nine dead codes are the evidence that tier 5 did not
hold: someone added the codes and nobody wired them.

### The down-finding that earns the change

Invariant: **after a tool fails on a credential the user can repair, the same turn tells
the user to repair it.**

Counterexample as a sequence:

1. The health floor sees an `active` Google credential and admits `gmail.search`.
2. The tool calls `getFreshAccessToken`. The refresh token is dead.
3. `credentials.ts` flips the row to `needs_reauth` and rethrows `GoogleReauthRequiredError`.
4. `toPublicAppError` maps it to `tool_execution_failed`. No `connectNudge` derives,
   because `connectNudgeFromDispatch` reads only the floor's `unavailability` code.
5. The model tells the user "try again". The user retries. Now the floor refuses with
   `needs_reauth` and the nudge appears.

Conclusion: **broken**. The system heals on the second turn and lies on the first.

## 3. The pattern

Four layers. Each has one owner. Dependencies point down.

```
  consumers    web bubble · tool card · HTTP handler · model transcript
      │           derive copy and actions from `fix`, never from text
      ▼
  classifier   one per seam: tool dispatch · chat finalize · HTTP error-handler
      │           exhaustive over the tagged union → a catalog code + params
      ▼
  catalog      @alfred/contracts/app-errors — code → { message(params), why, fix }
      │           closed. `fix` is a closed union. params are closed enums.
      ▼
  failures     tagged classes in the owning package (`_tag`, structured fields)
                 no public copy. `HttpError`, `GoogleReauthRequiredError`, ...
```

### 3.1 Failures: every custom class carries a `_tag`

Add one small base to `contracts/errors.ts`:

```ts
export abstract class TaggedError<Tag extends string> extends Error {
  abstract readonly _tag: Tag;
}
export function hasTag<T extends string>(err: unknown, tag: T): err is TaggedError<T>;
```

`HttpError`, `RailwayGraphqlError`, and `SerializationError` already carry `_tag`.
`GoogleReauthRequiredError`, `MissingScopesError`, `McpOAuthAuthorizationRequiredError`,
`McpClientError`, `GoogleCredentialNotFoundError`, and `CredentialVaultError` do not.
Give them one. Do not add public copy to these classes. The message stays a log message.

This shape is `Data.TaggedError` from Effect, written in plain TypeScript. If the repo
adopts Effect later, each class maps one to one and the catalog does not move. Section 6
says why not now.

### 3.2 Catalog: `defineFailureCatalog`, parametrized codes, a closed `fix`

```ts
export type Fix =
  | { kind: "connect"; integration: IntegrationSlug }
  | { kind: "reconnect"; integration: IntegrationSlug }
  | { kind: "retry"; afterSeconds?: number }
  | { kind: "correct_input" }
  | { kind: "start_new_thread" }
  | { kind: "none" };

export const FAILURES = defineFailureCatalog({
  connection_required: {
    params: z.object({ integration: integrationSlugSchema }),
    message: ({ integration }) => `${label(integration)} is not connected.`,
    why: "No usable credential exists for this integration.",
    fix: ({ integration }) => ({ kind: "connect", integration }),
  },
  reauth_required: {
    params: z.object({ integration: integrationSlugSchema }),
    message: ({ integration }) => `${label(integration)} needs to be reconnected.`,
    why: "The stored credential was revoked or expired and cannot refresh.",
    fix: ({ integration }) => ({ kind: "reconnect", integration }),
  },
  scope_required: {
    params: z.object({ integration: integrationSlugSchema, feature: googleFeatureSchema }),
    ...
  },
  provider_rate_limited: {
    params: z.object({ integration: integrationSlugSchema, retryAfterSeconds: z.number().optional() }),
    fix: ({ retryAfterSeconds }) => ({ kind: "retry", afterSeconds: retryAfterSeconds }),
    ...
  },
  tool_input_invalid: { fix: () => ({ kind: "correct_input" }), ... },
  run_cancelled:      { fix: () => ({ kind: "none" }), ... },
  tool_execution_failed: { fix: () => ({ kind: "retry" }), ... },
});
```

Three rules make this safe, and each is a type, not a comment:

- **`fix` is a closed union.** A consumer switches on `fix.kind` with a `never` guard. A
  new remediation kind fails every consumer until each one handles it. This replaces the
  `retry` field in the web table and the `action` field in `chatConnectNudge` as the
  source; both become projections of `fix`.
- **`params` are closed enums or numbers, never free strings.** This is the hazard rule.
  The registry is closed so that exception text and NUL bytes cannot reach the transcript
  or the `execute_error` column (the transcript-side twin of the ADR-0070 persistence rail). A parametrized message reopens that door
  unless the parameter type shuts it. `integration` is a slug enum. `feature` is a Google
  feature enum. A scope list from Google is **not** a valid param. If a message needs
  upstream text, the entry must not exist.
- **The public shape is `{ code, params, message, fix }`.** `message` stays for humans
  and logs. `code` and `fix` are what machines read. `extractStoredError` validates the
  persisted `{ code, params }` with the entry's `params` schema (tier 2) and falls back to
  `tool_execution_failed` on any mismatch, exactly as it does today for a bad code.

The nine dead per-integration codes are deleted. `connection_required` and
`scope_required` replace them. `railway_credential_required` and the calendar bounds
code stay as they are; they carry no cross product.

### 3.3 Classifier: one per seam, exhaustive over the tagged union

`toPublicAppError(err)` becomes `classifyToolFailure(err): PublicFailure`:

```ts
export function classifyToolFailure(err: unknown): PublicFailure {
  if (err instanceof AppError) return err.public;
  if (hasTag(err, "GoogleReauthRequired"))
    return FAILURES.reauth_required({ integration: err.integration });
  if (hasTag(err, "MissingScopes"))
    return FAILURES.scope_required({ integration: "google", feature: err.features[0] });
  if (hasTag(err, "McpOAuthAuthorizationRequired"))
    return FAILURES.reauth_required({ integration: "mcp" });
  if (isHttpError(err)) {
    if (err.status === 401 || err.status === 403)
      return FAILURES.reauth_required({ integration: err.provider });
    if (err.status === 429) return FAILURES.provider_rate_limited({ integration: err.provider });
  }
  return FAILURES.tool_execution_failed();
}
```

Two design points:

- **The seam owns the map, not the thrower.** An integration package never imports the
  catalog. It throws its own tagged failure. The dispatcher decides what that means for
  the model. This keeps the dependency direction `assistant → contracts` and
  `integrations → contracts` with no edge between them.
- **Exhaustiveness is over a declared union.** Declare `type KnownFailure = HttpError |
GoogleReauthRequiredError | ...` in the assistant package and write the classifier as a
  `switch (err._tag)` with a `never` default. Adding a tagged class and adding it to the
  union is two edits today. A test that instantiates each class and asserts a
  non-fallback code closes the gap at tier 4. The union type is the tier 1 half.

`classifyChatFailure` (ADR-0072) is the same shape for the chat seam and stays where it
is. Its substring fallbacks remain, because the model provider does not throw typed
errors. Where it reads `HttpError.status`, nothing changes.

The HTTP error-handler in `packages/http/src/middleware/error-handler.ts` gains one
branch: an `AppError` that reaches a route maps to an `ApiError` through `fix.kind`
(`connect`/`reconnect` → 401 with the `fix` in `details`, `correct_input` → 400,
`retry` → 503, `none` → 409). This is the only bridge between the two catalogs. They do
not merge, because an HTTP status is not a property of a tool failure.

### 3.4 Consumers: derive, do not restate

- `connectNudgeFromDispatch` reads `fix` from a `failed` result as well as from the floor's
  `unavailability` code. Two sources, one payload. The sequence in section 2 now
  produces the nudge on the first turn.
- `FAILURE_PRESENTATION` keeps the first-person copy for `ChatErrorKind`, but its
  `retry` field is deleted. The retry action comes from `fix.kind` on the failure the
  server already persists.
- The model reads `{ status: "failed", code, message, fix }`. The `fix` gives it the
  next legal move without a prose rule in the system prompt. This follows the
  no-prompt-patching posture: the tool result carries the fact.

## 4. Enforcement, by tier

| Tier | Mechanism                                                                                         | Closes                                   |
| ---- | ------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1    | `Fix` closed union with `never` guards in every consumer                                          | a new remediation kind is unmissable     |
| 1    | `params` typed as enums; `defineFailureCatalog` rejects a `z.string()` param at the type level    | free text cannot re-enter the transcript |
| 1    | `KnownFailure` union + `switch (err._tag)` with `never` default                                   | a new tagged class must be classified    |
| 1    | Consolidation gate: `new Error("conversation_summary_` → use `CompactionError`                    | message-as-code                          |
| 1    | Consolidation hint: `throw new Error(` under `tool-runtime/internal/tools/**`                     | plain throws in tool bodies              |
| 2    | `extractStoredError` parses `{ code, params }` with the entry schema                              | a bad persisted row cannot replay text   |
| 3    | The catalog is the one owner of public copy and of `fix`                                          | copy drift across three tables           |
| 4    | Table test: every tagged class maps to a non-fallback code; every code has one producer in `src/` | dead codes                               |

The tier 4 producer test is cheap: enumerate the catalog keys and grep the source tree.
It would have caught the nine dead codes on the day they landed.

## 5. Vocabulary ledger

Names a call site or a reader stops needing:

- nine per-integration registry codes
- `FAILURE_PRESENTATION.retry`
- the prefix list in `isUnrecoverableConversationCompactionError`
- the string fallbacks for 401/429 in the tool seam (there are none today; the seam
  simply drops them)
- the sentence "Reconnect X in settings" repeated fifteen times

Names added:

- `Fix` (one type), `defineFailureCatalog` (one function), `classifyToolFailure` (one
  function that replaces `toPublicAppError`), `TaggedError` and `hasTag`

The ledger is negative. No old door survives past PR 2, so no debt clock opens.

## 6. Effect: the door stays open, the cost is not paid now

The 2026-06 verdict against Effect stands (see the shared-error-primitives memory). One
monadic island in a throw-based codebase means two error models and `Effect.runPromise`
at every seam. That is a cost with no local payoff for a single-user system.

This plan keeps the door open at zero cost. `TaggedError` with a `_tag` literal is the
exact shape of `Data.TaggedError`. `classifyToolFailure` is a `Match.tag` by hand. If a
package later moves to Effect, the failure classes become `Data.TaggedError` subclasses,
the classifier becomes `Match.exhaustive`, and the catalog, the `Fix` union, and every
consumer do not change. The right first island, if it ever happens, is one integration
package behind `integrations({ userId })`, where a typed error channel buys retry and
fallback composition. Error handling on its own does not justify the island.

## 7. Migration, in PR order

Each PR is independently shippable and leaves no second door.

**PR 1 — the catalog.** Add `Fix`, `defineFailureCatalog`, and `why`/`fix` on every
entry. Replace the nine dead codes with `connection_required`, `reauth_required`, and
`scope_required`. Extend `PublicAppError` to `{ code, params?, message, fix }`. Update
`extractStoredError` to parse params. No behavior change for the model yet except the
new `fix` field in the result. Tier 4 producer test lands here.

**PR 2 — the classifier.** Add `_tag` to the six untagged classes. Replace
`toPublicAppError` with `classifyToolFailure`. Add the mid-call reauth test: a fake tool
throws `GoogleReauthRequiredError` through `dispatchToolCall`; assert the persisted code is
`reauth_required`, and assert `completedToolCall(...).connectNudge` is `reconnect`. Add
the tool-body throw hint to `scripts/consolidation-rules.mjs`. Write the ADR.

**PR 3 — the web.** Delete `FAILURE_PRESENTATION.retry`; derive the button from `fix`.
Let `connectNudgeFromDispatch` read `fix`. Show `why` in the tool card's expanded state
for the developer view only.

**PR 4 — compaction.** Add `CompactionError extends TaggedError<"Compaction">` with a
`reason` enum and an `unrecoverable` flag. Delete the prefix list. Add the consolidation
gate.

**PR 1 as built (deviations).** The tier 4 producer test lands in PR 1, so PR 1 adds
only codes that have a producer today: `connection_required` (calendar, railway) and
`reauth_required` (the GitHub missing-login case). `scope_required` and
`provider_rate_limited` move to PR 2, where the classifier produces them. The three live
per-integration connection codes and the two `*_account_read_failed` / `*_unavailable`
pairs carried the same cross product as the nine dead codes, so they fold into
`connection_required`, `account_read_failed`, and `integration_unavailable` in PR 1. The
public shape is `{ code, params?, message, fix }`; `message` is a branded string only the
catalog can mint, which keeps the old literal-union property (`{ code, message: err.message }`
does not type-check) now that messages are templates. `INTEGRATION_DISPLAY_NAMES` in
`contracts/tools.ts` supplies the label; the web integration catalog still owns its own
`name` field, which PR 3 can point at the shared map. The slug-keyed label sites that used
`humanizeSlug` (the availability gate in `registry.ts`, `recovery-navigation.ts`,
`humanizeToolName`, the web plan tab, mention palette, and passthrough toggles) read the
shared map now, and `humanizeSlug(x.integration)` is a consolidation gate.

Two more deviations, from the PR 1 review. First, the catalog does not trust the typed
constructors alone. `AppErrorArgs` and the `publicAppError` tuple collapse for a widened
`AppErrorCode`, so `new AppError(code, { cause })` and `publicAppError(code)` compile with
no params. Each parametrized entry is built by `withParams(schema, { message, why, fix })`,
which ties the callbacks to the schema's output type and parses `params` at mint; a
failing parse throws a `TypeError` that names only the code. Second, the folded messages
lost their recovery prose ("Reconnect X in settings"). The plan said "no behavior change
for the model except `fix`"; the model now reads the recovery from `fix.kind` and the
message states only the fact. That is the design's intent, recorded here because it is a
copy change the model sees before PR 3 wires `fix` into the web.

**PR 5 — the HTTP bridge (optional).** The error-handler maps `AppError` to `ApiError`
through `fix.kind`. Fold the route messages that repeat three or more times
(`"Credential not found"` ×7, `"Message id already belongs to a different chat turn"` ×7)
into catalog entries only if a client needs to branch on them. Otherwise leave them.

## 8. What this plan does not touch

- The ~590 plain `throw new Error` sites that guard invariants (`"unreachable"` ×23,
  exhaustive switch defaults, registry boot validation, smoke assertions). A `fix` on a
  bug is noise. They stay.
- `Errors.*` factories and `API_ERROR_STATUS`. The HTTP catalog already has tier 1
  code-to-status pairing and a consolidation gate.
- `classifyChatFailure` internals. ADR-0072 already did this work for the chat seam.

## 9. Down-proofs the PRs must carry

1. **Mid-call reauth** (section 2). Closed when the PR 2 test passes on a real
   `GoogleReauthRequiredError` instance, not a plain object.
2. **Legacy persisted rows.** A row whose `execute_error.code` is one of the nine deleted
   codes must replay as `tool_execution_failed`, not throw. `extractStoredError` already
   does this for an unknown code; the test must include one deleted code by name.
3. **Poison-pill through params.** A `PublicFailure` built with a slug that is not in the
   enum must fail `params` parsing at `extractStoredError` and fall back. Assert with a
   NUL-bearing string, so the ADR-0070 property is proven at the new door.
4. **Dependency direction.** `pnpm check:web-boundaries` and the package boundary lint
   stay green with `integrations` never importing `app-errors`.
