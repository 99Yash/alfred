---
id: external-call-timeout-and-abort
section: Backend
status: candidate
rung: ast
feasibility: medium
issue: #1629
---

# Give every external call and LLM call a timeout and an `abortSignal`.

Cancel the siblings of a `Promise.all` when one fails.

Why: a loser keeps a billable call open. Example: #1086. See [ai-sdk.md](../ai-sdk.md).

## Bad

```ts
const review = await meteredGenerateObject(
  {
    model: model.model(),
    schema: reviewSchema,
    prompt: JSON.stringify({ bodyText, sources: args.gather.sources }),
    maxOutputTokens: OUTPUT_TOKEN_LIMIT,
  },
  { ...attribution, name: "reply-drafting.verify-grounding" },
);
```

## Good

```ts
const review = await meteredGenerateObject(
  {
    model: model.model(),
    schema: reviewSchema,
    prompt: JSON.stringify({ bodyText, sources: args.gather.sources }),
    maxOutputTokens: OUTPUT_TOKEN_LIMIT,
    abortSignal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
  },
  { ...attribution, name: "reply-drafting.verify-grounding" },
);
```

## Mechanism

AST: an AI SDK generate or stream call whose options have no `abortSignal` key.

## Hits

- #1086 packages/assistant/src/context-search/search.ts: the collect phase had no deadline; one `AbortSignal.timeout` now bounds every reader, and the Drive reads cancel their fetch on it.
- #714 packages/assistant/src/delivery/notify.ts: `resend.emails.send()` had no timeout and no `abortSignal`.
- #1111 packages/assistant/src/context-search/documents-source.ts: `reconcileEvidence` took no `abortSignal`, so the collect timeout lost every document card.
- #1133 packages/assistant/src/connections/hosted-endpoint.ts: `createGuardedFetch` did not keep the signal of an input `Request`.
