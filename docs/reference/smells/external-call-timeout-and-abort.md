---
id: external-call-timeout-and-abort
section: Backend
status: gated
rung: ast
rule: alfred/ai-call-needs-abort-signal
---

# Give every AI SDK generate or stream call an `abortSignal`.

Pass the run, request or job signal of the caller. When the caller also has a deadline, combine the two with `AbortSignal.any([parent, AbortSignal.timeout(MS)])`. When no parent signal exists, pass `AbortSignal.timeout(MS)` with a named constant that is longer than a normal call.

Why: the metered wrappers set a 600 s `timeout` when the caller sets none. That backstop is not a cancel path. A caller that stops waiting keeps a billable call open. See [ai-sdk.md](../ai-sdk.md). An external call that is not a model call, and the siblings of a `Promise.all`, stay with review in [external-call-deadline-and-sibling-cancel](./external-call-deadline-and-sibling-cancel.md).

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

AST rule `alfred/ai-call-needs-abort-signal`. The callee is `generateText`, `streamText`, `generateObject`, `streamObject`, `meteredGenerateText`, `meteredGenerateObject` or `meteredStreamText`, as a bare name or as a member such as `ai.generateText`. The rule reads the first argument and reports it when it shows no `abortSignal` key.

The rule finds the key in these places:

- the object literal, as a property, a shorthand or a string key;
- an object literal that a spread expands, also through `?:`, `&&`, `||` and `??`, such as `...(signal ? { abortSignal: signal } : {})`;
- a `const` in the same file whose initializer is one of these.

Parentheses, `as`, `satisfies` and `!` do not change the result.

A spread or an argument that the rule cannot read gets a second message: a parameter, a call result, a member, a `let` or a destructured name. A visible `abortSignal` key next to it satisfies the rule. A pass-through call takes a disable comment with its reason. Six calls have one: the three calls in `packages/ai/src/metering/wrappers.ts` forward the options of the caller, the two calls in `AlfredAgent` read the signal from `prepareTurn`, and `defaultRunPass` in `packages/assistant/src/triage/classify.ts` reads it from `classifyCallOptions`.

A `timeout` key does not satisfy the rule. The AI SDK changes a `timeout` into `AbortSignal.timeout`, so `abortSignal: AbortSignal.timeout(MS)` has the same deadline.

File scope: `inGateScope`. Scripts, smokes, probes and evals are out of scope. An operator starts each of them and stops it with Ctrl-C, and the wrapper backstop bounds each metered call.

False positives: an options value that carries the key through a helper function or a parameter. The second message names this case, and the fix is a visible key or a disable comment with the reason.

False negatives:

- The rule does not read the value of the key. A conditional key that is absent at run time passes. For example, `runAspect` in `packages/assistant/src/knowledge/cold-start/aspects.ts` has the conditional key, but `researchAspects` never passes a signal.
- An opaque spread next to a visible key passes, and so does a call through an alias, `.call` or `.apply`.
- A wrapper with another name is not a callee. `AlfredAgent#turn` takes an optional `abortSignal`, and the `user-authored-brief` workflow calls it with none.
- The rule does not check that a parent signal exists when the call uses only a timeout.
- The second sentence of the old smell, which cancels the siblings of a `Promise.all` when one fails, needs value flow across functions. It stays with review in [external-call-deadline-and-sibling-cancel](./external-call-deadline-and-sibling-cancel.md).

The paydown gave a signal to 13 calls in `packages/assistant`. No call had a parent signal: the workflow `StepContext` has no signal, and the ingestion queue and the post-turn chat calls pass none. So each call got `AbortSignal.timeout` with a named constant in its module. A cheap-route call that writes at most 4k tokens got 120 s. A boss call that writes at most 2.5k tokens got 120 s or 180 s. The four-step identity seed got 300 s, and its web search tool gets the same signal. The eight-step briefing agent got 600 s, equal to the backstop. Three calls had a `timeout` key: the thread title (15 s), the follow-ups (10 s) and the delivery alert copy (20 s). Each now passes `abortSignal: AbortSignal.timeout` with the same constant.

## Hits
