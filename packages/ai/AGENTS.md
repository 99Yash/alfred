# Alfred AI Guidance

`@alfred/ai` owns model construction, model identity, provider configuration, embeddings, and LLM cost attribution.

## Calls And Metering

- Use the package's model-identification boundary; do not inspect SDK internals with local casts.
- Production LLM calls that should be attributed must use the metered wrappers. Raw SDK calls are limited to explicitly isolated probes or package internals that implement those wrappers.
- Every external or LLM call needs a timeout or abort signal. Cancel sibling work after failure so billable calls do not continue unattended.

## Provider Data

- Treat provider options, metadata, and structured responses as untrusted JSON and validate or narrow them before use.
- AI SDK models are SDK objects, not JSON records. Inspect only the specific runtime properties the package boundary requires.
- Keep provider-specific behavior inside this package; callers should depend on Alfred's model and metering abstractions.
