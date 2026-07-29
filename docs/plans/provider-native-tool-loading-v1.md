# Provider-native tool loading — v1

> Status: implementation started 2026-07-29. Capability facts, correlated
> provider/model validation, application protocol wrappers, and provider-owned
> cache decoration are complete; native loading remains disabled.

## Outcome

Alfred keeps one portable exact-tool discovery model while allowing each concrete
model adapter to choose the best wire representation:

- Anthropic models with native tool search receive the complete allowed catalog,
  with cold tools marked `defer_loading`.
- OpenAI models with native tool search receive the equivalent OpenAI tool-search
  representation.
- Google and unsupported models receive only Alfred's current eager/exact-loaded
  surface and continue to use `system.search_tools` → `system.load_tool`.
- A cross-provider fallback transforms the same logical surface independently for
  each concrete attempt. An Anthropic primary may therefore use native deferral
  without sending the full eager catalog to its Gemini fallback.

The application remains the source of truth for registration, availability,
authorization, argument validation, execution, and durable transcript state.
Provider-native discovery is a context/cache optimization, never an authorization
mechanism.

## Existing facts

1. `MODEL_DEFINITIONS` already owns the closed provider/model relation and
   per-model capabilities in `packages/ai/src/models.ts`.
2. ADR-0078 puts per-model facts in `MODEL_CAPABILITIES`; its provider dispatch
   has now been deepened into the adapter map in `provider-adapter.ts`.
3. `activeTools` is the exact run-local eager surface. The dispatcher currently
   bounces an allowed inactive call, activates that one schema, and requires the
   model to reissue it.
4. `AlfredAgent` sorts tool definitions, strips `execute`, and applies
   Anthropic-only cache annotations.
5. Chat routes are composite: Anthropic primary, Gemini fallback. The fallback
   wrapper currently reuses one common request unchanged.
6. Installed AI SDK 7 / provider packages 4.0.11 already expose:
   - `anthropic.tools.toolSearchBm25_20251119()`;
   - `providerOptions.anthropic.deferLoading`;
   - `openai.tools.toolSearch()`;
   - `providerOptions.openai.deferLoading`.

No raw HTTP client, provider SDK fork, or prompt-text tool protocol is required.

## Load-bearing model

Do not use `activeTools` to mean three different things. The implementation must
name these sets:

```ts
interface LogicalToolSurface {
  /** Full schemas intentionally visible without discovery. */
  readonly eager: ToolSet;
  /**
   * Full registered schemas that this run is allowed to discover. These are
   * submitted deferred on native providers and omitted on application mode.
   */
  readonly discoverable: ToolSet;
}
```

The sets have distinct meanings:

- **registered**: the global server knows how to execute the tool;
- **allowed/available**: this run may use it, subject to integration health and
  workflow caps;
- **eager**: its schema is immediately in model context;
- **discoverable**: the model may acquire its schema through the selected
  discovery protocol;
- **executable**: the dispatcher has independently passed membership, schema,
  policy, authorization, and confirmation checks.

Provider-native loading changes only `eager` versus `discoverable`. It must never
change registration, integration allowlists, credential health, risk policy, or
execution authorization.

## Deep module and seam

Introduce one deep module in `@alfred/ai`. Its external interface is the model
wrapper, because that is the only seam reached independently by every concrete
fallback attempt:

```ts
function withProviderAdapter(modelId: ModelId, model: LanguageModelV4): LanguageModelV4;
```

`AlfredAgent` hands the request a provider-neutral logical surface plus cache
policy in a reserved Alfred-only request envelope. The wrapper's middleware
consumes and removes that envelope before the concrete provider sees the request,
then filters/decorates tools, system, and transcript for that adapter. A test must
prove the internal envelope never reaches any provider request.

Callers do not ask questions such as `supportsDeferredLoading`,
`usesAnthropicCacheControl`, or `needsToolSearchTool`. Provider mechanics stay
behind the module's interface. Pure transformations may remain exported for
interface-level tests, but they are not alternate production entry points.

The concrete model factory wraps each provider model with its protocol **inside**
the existing tool-name shim and **before** models are composed with
`withFallback`. Protocol projection therefore runs first; the inner name shim
then encodes only the final function-tool set and leaves provider-defined search
tools alone. This ordering is the critical seam:

```text
logical surface
      │
      ├─ Anthropic adapter ─ native search + deferred catalog
      │
      └─ Gemini adapter ─── application-loaded eager subset
                 │
           withFallback(...)
```

The fallback may switch the concrete model, but it cannot accidentally reuse the
wrong provider's tool-loading representation. A pre-flattened `ToolSet` prepared
in `AlfredAgent` cannot satisfy this invariant and is explicitly rejected.

## Provider/model validation and inference

### Canonical identity

Internal callers should pass only a `ModelId`; provider is derived from
`MODEL_REGISTRY`. They must not pass redundant `{ provider, modelId }` pairs.

At untrusted/external boundaries that genuinely provide both fields, add:

```ts
const providerModelSchema = z
  .object({
    provider: providerIdSchema,
    modelId: modelIdSchema,
  })
  .superRefine((value, ctx) => {
    if (MODEL_REGISTRY[value.modelId] !== value.provider) {
      ctx.addIssue({
        code: "custom",
        message: `${value.modelId} is not registered to ${value.provider}`,
      });
    }
  });
```

Expose one parser returning the canonical correlated identity. Do not add new
`id.includes(...)`, provider-prefix, or dated-alias inference throughout callers.
Served/reported model aliases need a separate normalization table or explicit
provider metadata; they must not be fuzzy-matched into security decisions.

### Per-model facts

Extend `ModelCapabilities` only with facts that vary by model:

```ts
interface ModelCapabilities {
  // existing fields...
  readonly nativeToolSearch: boolean;
}
```

Current intended values:

- Claude Sonnet 4.6 / Opus 4.8: `true`;
- GPT-5.6 Sol / Luna: `true`;
- Gemini models: `false`;
- Claude Haiku: set from the official compatibility table and a live probe,
  not from provider family alone.

The models.dev audit remains an oracle only where it actually publishes the fact.
Tool-search support that is absent from that catalog remains code-resident and
covered by a live smoke probe.

### Per-provider mechanics

The adapter map in `provider-adapter.ts` owns:

- reasoning option shape;
- tool-name encoding policy;
- prompt-cache annotation shape;
- native search-tool construction;
- deferred-tool annotation shape;
- filtering of foreign provider-defined tools;
- application fallback projection.

Capability and enablement are deliberately separate. A protocol is native only
when all three are true:

```ts
MODEL_CAPABILITIES[modelId].nativeToolSearch
  && PROVIDER_ADAPTERS[provider].nativeToolSearch
  && NATIVE_TOOL_LOADING_MODELS.has(modelId)
```

`NATIVE_TOOL_LOADING_MODELS` is a code-resident rollout set owned by the protocol
module and starts empty. This prevents a capability-map update from changing
production behavior and permits Slice 3 to enable one probed model at a time.

A registry invariant test fails when an enabled model lacks either capability or
an implemented adapter, or when an implemented adapter is unreachable from every
registered supporting model. A model capability may safely precede its adapter;
capability means the external model supports the protocol, not that Alfred has
implemented or enabled its transform.

## Request construction

### Logical surface

`packages/api/src/modules/agent/tool-surface.ts` continues to own:

- connected/allowed/available catalog filtering;
- exact eager kernel;
- deterministic first-turn preload;
- run-local `activeTools`;
- legacy state migration.

It gains one projection that returns:

```ts
{
  eager: build schemas for activeTools,
  discoverable: build schemas for available - activeTools,
}
```

No provider imports enter `@alfred/api`. It returns a provider-neutral logical
surface.

### Provider transformation

`AlfredAgent` accepts `LogicalToolSurface`, not a pre-flattened `ToolSet`. It
canonically sorts and strips `execute` from the union once, records the eager
names in the internal request envelope, and sends that common logical request to
the composite model. Each concrete model wrapper transforms it:

- **Anthropic native**
  - keep `eager` ordinary;
  - include `discoverable` with `providerOptions.anthropic.deferLoading = true`;
  - add Anthropic BM25 tool search;
  - place `cacheControl` only on the final non-deferred tool;
  - never combine `deferLoading` and `cacheControl` on one definition.
- **OpenAI native**
  - keep `eager` ordinary;
  - include `discoverable` with `providerOptions.openai.deferLoading = true`;
  - add OpenAI hosted tool search;
  - apply explicit prompt-cache options only on models that declare support.
- **Application mode**
  - emit only `eager`;
  - retain Alfred's `system.search_tools` and `system.load_tool` kernel;
  - omit all foreign provider-defined search tools.

Canonical sorting happens before provider decoration. Provider-defined search
tools use reserved internal keys that cannot collide with registered Alfred tool
names. The internal request envelope is schema-validated in middleware even
though Alfred authored it; absent or malformed metadata fails closed to the eager
application projection, never to the full catalog.

### Prompt cache decoration

Move the Anthropic-specific cache functions out of generic `agent.ts` and behind
the provider protocol. Preserve current behavior before enabling native loading:

- stable system breakpoint;
- last eager tool breakpoint;
- growing transcript breakpoint(s);
- four-breakpoint cap.

Google's adapter returns messages unchanged and relies on implicit caching.
OpenAI explicit breakpoints are a separate enablement inside the same seam; do
not couple their rollout to Anthropic native deferral.

## Durable execution semantics

Native search is provider-executed inside one model request. Its search/result
blocks must be preserved from `response.messages` exactly as returned by the AI
SDK. Alfred must not dispatch or synthesize results for the provider search tool.

A final client-tool call may name a tool that is discoverable but absent from
`activeTools`. The current unconditional inactive bounce would destroy the native
cache win. Replace it with a turn-scoped declaration:

```ts
type ToolCallExposure = "eager" | "provider-discovered" | "schema-blind";
```

- `eager`: dispatch normally.
- `provider-discovered`: dispatch normally after the existing registry,
  availability, allowlist, schema, policy, authorization, and approval checks;
  do not promote it into `activeTools`.
- `schema-blind`: preserve today's activate-and-reissue bounce.

The exposure classification must be derived from the actual request/response
protocol, not trusted from model-authored text. Before implementation, the probe
slice must establish which AI SDK response parts identify a native-discovered
call for Anthropic and OpenAI. If the SDK does not expose reliable evidence, v1
must fail closed to the existing bounce rather than infer from a tool name.

`response.messages` remains the canonical transcript append source. Provider
search blocks must survive checkpoint, compaction replay, and resume.

## Files

### Modify

- `packages/ai/src/models.ts`
  - add `nativeToolSearch`;
  - add canonical provider/model pair validation for external identities;
  - retain the existing registry as the only model→provider source.
- `packages/ai/src/provider.ts`
  - keep product routes and model/fallback construction;
  - construct each concrete model with the provider protocol before
    `withFallback`;
  - stop accumulating new wire mechanics here.
- `packages/ai/src/agent.ts`
  - accept `LogicalToolSurface`;
  - delegate provider-specific tool and cache decoration;
  - retain single-turn execution, metering, and result classification.
- `packages/api/src/modules/agent/tool-surface.ts`
  - project eager and discoverable schemas from one availability snapshot;
  - keep selection policy provider-neutral.
- `packages/api/src/modules/agent/workflows/chat-turn.ts`
  - pass the logical surface;
  - persist provider-executed search messages;
  - carry verified call exposure to dispatch.
- `packages/api/src/modules/agent/workflows/user-authored-brief.ts`
  - use the same logical-surface path; no parallel implementation.
- dispatcher/tool-round modules owning inactive-call handling
  - distinguish provider-discovered from schema-blind calls.

### Add

- `packages/ai/src/provider-adapter.ts`
  - concrete provider adapter map;
  - protocol resolution;
  - pure tool/cache transformations.
- `packages/ai/test/provider-adapter.test.ts`
  - request projection and registry invariants for every registered model.
- `packages/ai/src/scripts/probe-native-tool-loading.ts`
  - opt-in live Anthropic/OpenAI characterization probe.
- focused API tests beside existing tool-surface and dispatch tests
  - logical surface projection;
  - native-discovered dispatch;
  - application bounce unchanged;
  - transcript preservation.

Avoid generic `utils.ts`, a second model registry, provider checks in workflow
files, or provider imports below `@alfred/ai`.

## Implementation slices

### Slice 0 — characterize the SDK

No production behavior change.

1. Record the installed SDK/package source shapes and changelog constraints in
   the probe: Anthropic normalized tool-search result/reference parts; OpenAI
   `tool_search_call` / `tool_search_output`, `execution`, and discovered-call
   namespace metadata.
2. Send one eager and two deferred harmless tools to Anthropic.
3. Prove wire acceptance, native discovery, final client call shape, streaming
   parts, `response.messages`, cache usage, and provider-edge tool-name round
   trip.
4. Repeat on OpenAI GPT-5.6.
5. Force the Anthropic→Gemini fallback and prove provider-specific transformation
   gives Gemini only the eager application surface.
6. Record sanitized fixtures for offline tests.

This slice is a gate. Do not design response classification from documentation
alone when the installed SDK's normalized shape is directly testable.

### Slice 1 — capability substrate

No behavior change.

1. Add model fact and provider/model validator. **Complete 2026-07-29.**
2. Add the empty rollout set and exhaustive support/adapter/enablement
   invariants. **Complete 2026-07-29.**
3. Extract and deepen `provider-adapter.ts` around `withProviderAdapter`.
   **Complete 2026-07-29 for the application adapters; incorporates the
   architecture review's top recommendation.**
4. Move existing prompt-cache, reasoning, model-construction, and tool-name
   mechanics behind the concrete adapter wrapper. **Complete 2026-07-29.**
5. Make every current request byte-equivalent for Anthropic and behavior-equivalent
   for Gemini. **Covered offline by concrete-wrapper and forced-fallback tests;
   live byte/cache accounting remains in Slice 0.**
6. Add exhaustive registry/adapter tests, including wrapper ordering and removal
   of the Alfred-only envelope. **Complete for application adapters 2026-07-29.**

### Slice 2 — logical tool surface

No native enablement yet.

1. Change `AlfredAgent` from flattened `ToolSet` to `LogicalToolSurface`.
2. Have every adapter select application mode.
3. Preserve current exact preload/load/bounce behavior.
4. Replace old shallow tests with interface-level protocol and surface tests.

### Slice 3 — Anthropic native loading

1. Enable native search for one supported chat model.
2. Preserve native search/reference blocks through durable transcript replay.
3. Dispatch verified provider-discovered calls without promotion/reissue.
4. Keep Gemini fallback on application mode.
5. Compare against the existing loader on representative chat evals.

### Slice 4 — OpenAI native loading

Enable only when an OpenAI model is placed on a product route. The registered
GPT-5.6 smoke path can validate the adapter earlier, but unused production
machinery should not complicate chat behavior.

## Acceptance

Correctness:

- unknown or mismatched provider/model identities fail closed;
- every registered model resolves one exhaustive protocol;
- no provider-specific branch exists in chat/workflow orchestration;
- foreign provider tools never reach a concrete provider request;
- Google fallback sees only the current application-loaded subset;
- native-discovered client calls still pass every existing dispatch safety gate;
- schema-blind inactive calls retain the reissue behavior;
- crash/resume replays provider search blocks without provider 400s.

Performance:

- adding/discovering a deferred Anthropic tool does not rewrite the cached
  tools/system prefix;
- no mid-run cache miss caused solely by exact tool activation;
- eager input tokens decrease versus the current application-load turn;
- added discovery latency and server-tool usage are measured;
- task success and correct-tool selection do not regress.

Observability:

- record requested model route, served model, tool-loading protocol, eager schema
  tokens, discoverable schema tokens, native searches, application searches,
  cache reads/writes, and inactive-call classification;
- dashboards group by served provider/model, not only requested tier.

## Out of scope

- Replacing Alfred's portable catalog/search semantics.
- Prompt-text or generic-executor emulation.
- Google explicit `CachedContent` migration.
- Changing integration authorization or risk policy.
- Provider/model selection routing.
- Programmatic tool calling/code mode.
- Inferring undocumented provider prompt order.
- Making models.dev a runtime dependency.

## Decision record

After Slice 0 proves the installed SDK shapes, add one ADR amending ADR-0053 and
ADR-0078:

> Logical tool discovery is harness-owned; its wire representation is selected by
> a validated per-model capability and a per-provider protocol adapter. Native
> deferral is an optimization behind that seam, while execution policy remains
> provider-independent.
