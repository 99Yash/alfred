# Alfred Integrations Guidance

`@alfred/integrations` owns provider clients, OAuth exchanges, webhook verification, and provider-to-Alfred translation.

## Network Boundaries

- Every external HTTP call needs a timeout or passed `AbortSignal`.
- Bound and redact non-OK response bodies before returning or logging errors. Never log complete provider responses, tokens, webhook bodies, or error objects.
- Verify webhook signatures with timing-safe comparison against the raw body before parsing it.
- Make retryable provider writes idempotent where the provider supports an idempotency key.

## Provider Payloads

- OAuth responses, webhook bodies, and provider JSON are untrusted. Validate stable contracts with schemas and narrowly inspect optional error details; do not cast `await response.json()` to a local interface.
- Keep provider-specific wire shapes and pagination in the provider module. Export normalized Alfred-facing behavior rather than leaking SDK or API payloads to callers.
- Keep credentials and environment lookup outside reusable provider logic; accept validated configuration through the package boundary.
