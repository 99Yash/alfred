---
id: external-call-deadline-and-sibling-cancel
section: Backend
status: stays-review
rung: none
---

# Give every external call that is not a model call a deadline and the signal of its caller.

Cancel the siblings of a `Promise.all` when one fails. A model call through the AI SDK is gated by `alfred/ai-call-needs-abort-signal` ([external-call-timeout-and-abort](./external-call-timeout-and-abort.md)).

Why: a call with no deadline holds a worker until the peer closes the socket, and a loser of a `Promise.all` keeps a billable call open. Example: #1086.

## Bad

```ts
const results = await Promise.all(readers.map((read) => read(request)));
```

## Good

```ts
const controller = new AbortController();
const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(COLLECT_TIMEOUT_MS)]);

try {
  return await Promise.all(readers.map((read) => read(request, signal)));
} catch (err) {
  // The other readers stop their reads.
  controller.abort();
  throw err;
}
```

## Mechanism

No one check can state it. Each client names its deadline in its own option, or has no option, and a wrapper such as `createGuardedFetch` can add the signal for its callers. So a call with no visible option can be correct. To find the siblings of a `Promise.all` that share no controller, a check must follow values across functions.

## Hits

- #1086 packages/assistant/src/context-search/search.ts: the collect phase had no deadline; one `AbortSignal.timeout` now bounds every reader, and the Drive reads cancel their fetch on it.
- #714 packages/assistant/src/delivery/notify.ts: `resend.emails.send()` had no timeout and no `abortSignal`.
- #1111 packages/assistant/src/context-search/documents-source.ts: `reconcileEvidence` took no `abortSignal`, so the collect timeout lost every document card.
- #1133 packages/assistant/src/connections/hosted-endpoint.ts: `createGuardedFetch` did not keep the signal of an input `Request`.
