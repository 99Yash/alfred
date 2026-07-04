# Alfred Integrations Guidance

## HTTP And Errors

- Every external HTTP call needs a timeout or passed `AbortSignal`.
- For non-OK responses, prefer `httpErrorFromResponse(provider, response, { url, method })` so body bounding and secret redaction stay consistent.
- Use `toMessage` for caught errors. Never log full provider error objects.

## Provider Payloads

- Validate provider JSON with Zod schemas where a response has a contract.
- For small optional error/details reads, use `isRecord`, `getPath`, or `getStringPath` from `@alfred/contracts`; do not cast `await res.json()` to a local interface.
- OAuth token responses and webhook bodies are untrusted even when they come from the provider.
