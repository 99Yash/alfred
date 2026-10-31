---
id: webhook-signature-raw-body
section: Backend
status: review
rung: compiler
feasibility: medium
---

# Verify a webhook signature with a timing-safe compare on the raw body.

Why: a body parsed and serialized again breaks the HMAC. Example: `packages/integrations/src/shared/webhook.ts`.

## Bad

```ts
.post("/webhooks/:source", ({ body, headers }) => {
  const expected = hmacSha256Hex(secret, JSON.stringify(body));

  if (expected !== headers["sentry-hook-signature"]) return "mismatch";
});
```

## Good

```ts
// The route reads the body as text: parse: ({ request }) => request.text()
export function verifySentryWebhookSignature(rawBody: string, signatureHeader: string | null) {
  return signatureMatches(hmacSha256Hex(secret, rawBody), signatureHeader)
    ? "verified"
    : "mismatch";
}
```

## Mechanism

Compiler: the verifier takes a branded raw-body type that only the raw-body reader mints.

## Hits
