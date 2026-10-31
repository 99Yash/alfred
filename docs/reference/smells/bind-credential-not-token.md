---
id: bind-credential-not-token
section: Backend
status: review
rung: compiler
feasibility: medium
---

# Bind the credential, not the token.

A client takes a credential id and gets a fresh token for each call.

Why: a token held across a long batch expires during the batch. Example: `gmailMailbox`, #1343.

## Bad

```ts
const accessToken = await getFreshAccessToken(args.credentialId);

await mapConcurrent(multi, RECONCILE_CONCURRENCY, async (threadId) => {
  const live = await getThreadMessageLabels({ accessToken, threadId });
});
```

## Good

```ts
const mailbox = gmailMailbox({ credentialId: args.credentialId });

await mapConcurrent(multi, RECONCILE_CONCURRENCY, async (threadId) => {
  const live = await mailbox.getThreadMessageLabels({ threadId });
});
```

## Mechanism

Compiler: client factories that take a credential id and never a token, one provider at a time.

## Hits

- #1343 packages/assistant/src/triage/gmail-reconcile.ts: one token was read before a concurrent batch and held for all of it.
