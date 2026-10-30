# Review checklist

This checklist holds only the rules that no gate enforces. Apply it to the authored files of a diff. Do not style-review a generated file. Compare it with its source.

- A gate fails `pnpm check`, `pnpm check-types`, `pnpm lint` or CI. [enforced-rules.md](./enforced-rules.md) lists every gate rule. Do not report a violation of one of those rules.
- When a gate covers part of a rule, this checklist holds only the part the gate cannot see.
- [gate-design.md](./gate-design.md#queue-review-only-rules-and-the-mechanism-that-would-enforce-them) says which mechanism could enforce each rule here, and which rules stay review.
- This checklist is the surface sweep. [structural-review.md](./structural-review.md) covers the search for a better structure (up) and the proof of an invariant (down).

Each rule has the rule, the reason, and an example.

## Types

- **Derive a row type from its table.** Use the named row type (`Document`) with `Pick` or `Omit`, and the `New*` insert type or `$inferInsert`.
  Why: a copy drifts when a column changes. Before you derive, read [database.md](./database.md#derive-row-types-from-the-table). Example: `rowToFact` in `packages/assistant/src/knowledge/facts.ts`.
- **Give a zod-validated value the type `z.infer<typeof schema>`.** Do not write a parallel `interface`.
  Why: the schema is the source of the type. Example: `SetPreferenceArgs` in `packages/assistant/src/settings/preferences.ts`.
- **Give a shape that two packages share one owning schema.** Consumers derive with `.pick`, `.omit` or `.extend`. A producer pins its return type to the owner.
  Why: a field renamed by the producer then fails `tsc` and does not drop from the client. Example: `readIntegrationStatus` in `packages/assistant/src/connections/availability.ts`.
- **Put a shape in the file that mints or stores it.** Do not make a `types.ts`, `schemas.ts` or per-package `schemas/` folder.
  Why: a grab-bag file groups by syntax and hides the owner. See [schemas.md](./schemas.md#colocate-the-schema-with-its-type-caps-and-minting-logic).
- **Keep a literal type only when it is a different concept, and say why in one comment.** A wire reshape is the usual case.
  Why: the next reviewer otherwise collapses it to the row type. Example: the `Synced*` read models in `packages/sync/src/schemas.ts`.
- **Choose the type of an open dictionary.** Use a parsed schema, a `Record` keyed by a literal union with `satisfies`, a `Map`, or `JsonValue`.
  Why: `Record<string, unknown>` is not a substitute for a parse. See [narrow-record-types](../research/narrow-record-types-2026-08-09.md).
- **Use `isRecord` and `getPath` only on a value that is `unknown` at a true parse boundary.** Index a typed field directly. Use `isIndexable` and `Reflect.get` for an SDK instance.
  Why: the guard widens a parsed value again. Example: #1279.
- **Choose `k?: T` or `k?: T | undefined` for each optional field.** Keep `k?: T` when absence has a meaning, and omit the key with a conditional spread.
  Why: a present `undefined` binds `NULL` where an absent key takes the column `DEFAULT`. See [typescript.md](./typescript.md#exactoptionalpropertytypes).
- **Name a symbol for its domain role, not its structure.** Do not use `shape` for a payload or a credential. `DayShape` is a real domain term and stays.
  Why: a structural name does not tell which structure. Example: #1149.
- **Check the `.d.ts` file or the library source before you say a library cannot do something.**
  Why: most limits are an option that nobody found. See [typescript.md](./typescript.md).
- **Record a probe before you claim that only one function mints a brand, that a misuse does not compile, or that `check-types` catches a form.** Probe each form, and include the mints that need no cast: a type guard, `z.custom<Brand>()`, and `Object.assign` onto a branded value. Claim only the forms that fail.
  Why: a `unique symbol` brand is only a type tag, so each expression of the brand type mints it, and no gate stops a mint with no cast. Example: the `RedactedToolInput` doc in `packages/ai/src/metering/langfuse.ts` names the forms that still compile (#1540). A draft of #1548 said that the compiler proves that no stored image part reaches the model, but a swap of two arguments of one type compiled. The local lesson is `.lessons/a-brand-only-mint-claim-is-false-*`.

## Constants and ownership

- **Name a threshold, cap, TTL, retry count, batch size or budget.** Give it a short reason when the value is not clear. Simple arithmetic stays inline.
  Why: an unnamed number hides a policy. Example: `CONTEXT_SEARCH_MAX_LIMIT` in `packages/contracts/src/context-search.ts`.
- **Put a constant at its narrowest stable owner.** Use `@alfred/contracts` only for a value that the server and the web app must agree on, in the file of the schema that enforces it. Keep implementation mechanics (timeouts, TTLs, batch sizes) in the owning package, next to the code that reads them.
  Why: a value in the wrong package becomes a second door. See [schemas.md](./schemas.md#colocate-the-schema-with-its-type-caps-and-minting-logic).
- **Make a dedicated constants file only when its values couple.**
  Why: a file of unrelated values fails the deletion test. Example: `derivePoolMax()` in `packages/env/src/pool.ts`.
- **Use an environment variable only for a deploy knob, a secret or an endpoint.**
  Why: an env var is not a way to avoid a name. See [architecture.md](./architecture.md#environment-variables).
- **Centralize duplicated logic only when the copies change together.** Leave a similar shape that changes on its own.
  Why: a wrong merge couples two concepts. Example: `parseEmailAddress` in `@alfred/contracts`.

## Backend

- **Do not query in a loop. Paginate every list endpoint.**
  Why: an N+1 read grows with the data. Example: #1126.
- **Wrap a multi-step write that must be atomic in one transaction.**
  Why: a partial write leaves a state that no reader expects. Example: `runAtomic` in `packages/db/src/helpers.ts`.
- **Give every external call and LLM call a timeout and an `abortSignal`.** Cancel the siblings of a `Promise.all` when one fails.
  Why: a loser keeps a billable call open. Example: #1086. See [ai-sdk.md](./ai-sdk.md).
- **Make work that BullMQ or a webhook retries idempotent.** Derive a stable key.
  Why: a retry must not repeat a side effect. Example: #576.
- **Log a caught error only under the `err` key of a `logger` call. Put only safe fields beside it, and mask PII.** `no-console` stops a `console` call outside `apps/web` and scripts.
  Why: only the `err` key goes through the serializer that drops free text. An error under another key, or its message in a field, can carry a connection string or a token. Example: `serializeError` in `packages/logging/src/logger.ts`.
- **Do not swallow a caught error.** Rethrow it, log it, or return a failure value. `no-empty` fails only an empty `catch` body, so check a `catch` that has statements.
  Why: a silent `catch` hides the fault from the user and from the logs.
- **Verify a webhook signature with a timing-safe compare on the raw body.**
  Why: a body parsed and serialized again breaks the HMAC. Example: `packages/integrations/src/shared/webhook.ts`.
- **Give a new endpoint the auth and rate limit of its group.** Run `db:generate` then `db:migrate`, never `db:push`.
  Why: an uncovered route is open. See [elysia.md](./elysia.md) and [database.md](./database.md).
- **Give each state its own return value.** A miss and a fault are two variants.
  Why: a miss counter that also counts faults demotes healthy rows in an outage. Example: `VerifiedPullRead`, #1356.
- **Do not use `updatedAt` or another `$onUpdate` column as a queue or schedule key.** Store the queue position in its own column or table.
  Why: a pass that writes nothing never moves the key, so the same rows win every turn. Example: `integration_object_pulls`, #1355.
- **Name the clock of each timestamp. Compare only timestamps of one clock.**
  Why: creation, delivery, provider event and fire time are different clocks. Example: `scheduledFireTime`, #1358.
- **Map every provider status in a closed table. Make an unknown status a fault, not a default.**
  Why: an unknown state that reads as `absent` counts toward a demotion. Example: `VERDICT_BY_VERCEL_STATE`, #1364.
- **Make a script, dry run or backfill call the live owner.** Add the missing verb to the owner. Do not copy its logic.
  Why: a copy skips the gates of the owner. Example: `setIfUnset`, #1347.
- **Do not export a primitive from a package barrel only for a test.** The test imports it from `src/`.
  Why: a public primitive is the door for the next copy. Example: #1361.
- **Bind the credential, not the token.** A client takes a credential id and gets a fresh token for each call.
  Why: a token held across a long batch expires during the batch. Example: `gmailMailbox`, #1343.

## Frontend

- **Clean up each subscription and timer in an effect. Do not set state after unmount.**
  Why: a subscription that stays open after unmount leaks, and its late callback writes stale state. Example: `apps/web/src/routes/-chat/composer/use-composer-draft.ts`.
- **Render the loading, error, empty and populated states.**
  Why: an async surface without an empty or error branch is not finished. Example: `apps/web/src/routes/-approvals/approvals-page.tsx`.
- **Guard browser-only APIs for SSR. Sanitize HTML before you inject it.**
  Why: a server render has no `window`. Example: `apps/web/src/lib/storage/storage.ts`.
- **Show an error to the user.**
  Why: a failure that only reaches the console is a silent failure.
- **Make each control keyboard-reachable. Add ARIA where it is necessary. Do not use color as the only signal.**
  Why: the surface must work without a mouse and without color.
- **Do not pass a same-property Tailwind utility through `className` to a primitive that carries a delta class.** The interactive `components/ui/v2` primitives and `FrostButton` carry `app-press`, so gate a `scale-*` utility that you pass to them with `not-active:`. `alfred/no-delta-class-utility-collision` checks the classes of one element in one file. It cannot see a class that crosses a component boundary.
  Why: the delta classes sit in `@layer components`, so the utility wins, and the press stops with no error. Example: `hover:not-active:scale-[1.04]` in `apps/web/src/routes/-chat/composer/composer-toolbar.tsx`.
- **Do not find an item by its position (`.at(-1)`, index 0, the queue head) when items run in parallel or change order.** Find it by its id or by its status.
  Why: another item can take that position while the work runs. Example: in #1453 a send completion removed the queue head, but a promote had put a different entry there. #1503 changed `describeActivity` in `apps/web/src/routes/-chat/conversation-helpers.ts` to find the last tool with the status `started`.
- **Do not keep data that must outlive one page view in a ref or a state that each mount creates.** A reset that runs on each route change has the same fault. Keep the data in a store that the app shell owns.
  Why: the shared event bus does not send old frames again, so a page that mounts again starts empty. Example: #1486 moved the live chat state to a module store in `apps/web/src/lib/chat/use-chat-stream.ts`, and #1489 fixed the same fault for artifacts. #1487 removed the rail clear from the route-change block of `AppShell`.

## Tests

- **Pin one side of an equality assert to a literal, an external artifact, or a second source.** A cross-check of two code paths keeps a `// tautology-ok: cross-check` marker and one literal-anchored test.
  Why: a test that calls the same function on both sides cannot fail. Example: `packages/ai/test/voice/voice-sanitize.test.ts`.
- **Give a literal pin a `// why: #NNN` or ADR link, or delete it.**
  Why: a pin with no policy only fails when both files change together. Example: `EMBED_COST_CAP_USD` in `packages/corpus/test/embed-policy.test.ts`.
- **Pair an existence-only assert with a behavior assert in the same test.**
  Why: `assert.ok(x)` proves only that the import did not throw.
- **Assert the wire or the state in a mock test, not only `calls.length`.**
  Why: a call count alone tests the mock.
- **Keep the reason of a `SAFETY:` note or a disable directive true.**
  Why: the unused-directive check proves only that a directive still suppresses a report. It cannot read the reason or a plain comment.

## Process

- **Keep the reason of a lint suppression true.** Delete a suppression that no longer applies.
  Why: the gate checks that a reason exists, not that it is still true.
- **Check the factual premise of an issue or plan against data before you write code.** Cite the query, log or commit.
  Why: #1357 said that no Vercel mail reached Alfred, and a query found three.
- **Do not let prose claim that the code is safer or more closed than it is.** This applies to a PR body, a doc comment and a doc. A list that you call complete says why it is complete. A claimed closure names the sequences that you traced. A statement that predicts a worse outcome than the code is a smaller fault.
  Why: a reader trusts the claim and does not do the check that it replaces. Example: a draft of #1458 gave three gaps in its liveness claim, and review found a fourth and a fifth. In #1459, a comment in `apps/web/src/lib/replicache/context.tsx` said that a pull sends no extra request, and a probe found one extra pull. That one comment took three review rounds.
- **When you delete, rename or move a mechanism, search the comments and docs for the words that describe it.** Search for its plain-word names too, not only its identifier. `check:doc-symbols` and `check:prose-locators` catch only a dead backticked symbol, path or specifier.
  Why: a comment that names a removed mechanism still reads as true. Example: #1483 removed the bottom pin, and review found a comment in `apps/web/src/routes/-chat/tool-call-group.tsx` that still gave it as a reason. Review of #1458 found that `packages/db/src/redis.ts` still named the old owner of the subscription recovery.
