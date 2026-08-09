# Provider-native tool loading — v1

> Status: implementation started 2026-07-29. Application protocol wrappers and
> provider-owned cache decoration are complete; native loading remains disabled.
> Design corrected 2026-08-09: the installed AI SDK and provider packages own
> model mechanics. The hand-maintained `MODEL_DEFINITIONS` capability registry,
> correlated provider/model parser, and per-model native-support flags are not
> part of the target design. Existing Slice 1 registry work must be simplified
> before native loading is enabled.

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

1. The repository uses AI SDK 7.0.19 with `@ai-sdk/anthropic` 4.0.36,
   `@ai-sdk/google` 4.0.39, and `@ai-sdk/openai` 4.0.36.
2. Every provider-created `LanguageModelV4` already carries its canonical
   `provider`, `modelId`, and `supportedUrls`. AI SDK 7 also exposes one
   provider-neutral `reasoning` setting. The provider packages translate that
   setting to adaptive thinking, thinking levels/budgets, or OpenAI reasoning
   effort with their own model-aware logic.
3. The provider packages already expose the native tool constructors and typed
   provider options used by this plan:
   - `anthropic.tools.toolSearchBm25_20251119()`;
   - `providerOptions.anthropic.deferLoading`;
   - `openai.tools.toolSearch()`;
   - `providerOptions.openai.deferLoading`.
4. `activeTools` is the exact run-local eager surface. The dispatcher currently
   bounces an allowed inactive call, activates that one schema, and requires the
   model to reissue it.
5. `AlfredAgent` sorts tool definitions, strips `execute`, and applies
   Anthropic-only cache annotations.
6. Chat routes are composite: Anthropic primary, Gemini fallback. The fallback
   wrapper currently reuses one common request unchanged.

No raw HTTP client, provider SDK fork, or prompt-text tool protocol is required.

## Ownership rule: SDK capability, Alfred policy

Do not copy the provider packages into an Alfred model catalog.

The AI SDK and its provider packages own:

- model construction and provider identity;
- provider option schemas and request serialization;
- generic reasoning-to-provider translation;
- model-specific request compatibility and warnings;
- provider-defined native tool constructors and normalized response parts;
- URL-media support exposed on the model object.

Alfred owns only product policy:

- semantic route names and their concrete primary/fallback legs;
- the reasoning ceiling selected for each route;
- whether a probed route leg enables native or application tool loading;
- tool availability, authorization, validation, execution, and durable state;
- metering and price verification for the model that actually served a call.

This is not a runtime dependency on a remote model catalog. It is normal use of
the installed packages that already serialize every request. A provider package
upgrade brings its updated model handling into the same dependency update and
verification pass. Alfred must not maintain parallel `effortValues`,
`temperature`, `nativeToolSearch`, or model-to-provider tables.

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

Keep one deep module in `@alfred/ai`. Its external interface remains the product
route, while each concrete route leg is adapted before fallback composition:

```ts
route("boss").model();
```

Inside the module, provider-specific constructors take their model-id parameter
type from the installed provider factory and immediately attach the matching
adapter:

```ts
function anthropicLeg(
  modelId: Parameters<typeof anthropic>[0],
  options: { toolLoading: "application" | "native" },
): LanguageModelV4;
```

The model object, not a second registry entry, supplies `provider` and `modelId`.
`googleLeg` and `openaiLeg` do the same with their provider packages. A route
table contains constructed legs plus Alfred policy; it does not contain a
parallel capability catalog.

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

## Model construction and identity

### Canonical identity

Construct models through `anthropic`, `google`, and `openai.responses`. Keep the
returned model object intact through wrapping and fallback composition. Code
that already has a model must read `model.provider` and `model.modelId`; it must
not reconstruct either value from a handwritten table.

Untrusted provider/model strings are telemetry, not authorization input. Parse
their wire shape, retain unknown values, and reconcile them through metering or
provider response metadata. Do not use a closed Alfred enum or fuzzy model-name
matching for security decisions.

### Capability ownership

Do not add a `nativeToolSearch` fact per model. The provider package proves that
Alfred can construct and serialize its native search tool. Slice 0 proves that a
specific product route leg is accepted by the live model. The route leg then
opts into native loading. This is a small rollout decision next to the model that
uses it, not a capability claim duplicated for every known model.

The same rule applies to reasoning. Product routes choose the AI SDK generic
`reasoning` value. The provider package maps or clamps it for the concrete model.
Alfred must remove its parallel effort vocabulary and provider-option builder.
If a product route later needs a provider-only setting that the generic option
cannot express, put that typed exception on the concrete route leg. Do not grow
it into a global capability table.

### Per-provider mechanics

The provider adapters in `provider-adapter.ts` own only Alfred-specific policy
that the provider packages do not own:

- tool-name encoding policy;
- Alfred's prompt-cache placement policy;
- native search-tool construction;
- deferred-tool annotation shape;
- filtering of foreign provider-defined tools;
- application fallback projection.

Attach the adapter at construction time. Do not look up an adapter from a model
registry after construction. Native loading is enabled on one constructed route
leg after its characterization probe passes. An SDK package upgrade or route
model change resets that proof and requires the probe again.

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
  - retire the model/capability registry;
  - keep only a small identity helper if metering still needs one, or move that
    helper to the metering module;
  - do not add native-tool capability flags or external identity validation.
- `packages/ai/src/provider.ts`
  - keep semantic product routes and fallback order;
  - construct route legs directly with the installed provider factories;
  - apply generic AI SDK `reasoning`, not handwritten provider reasoning blocks;
  - attach each provider adapter before `withFallback`;
  - stop accumulating new wire mechanics here.
- `packages/ai/src/provider-adapter.ts`
  - replace registry-indexed adapters with provider-specific constructors and
    adapters backed by `@ai-sdk/*`;
  - use generic AI SDK reasoning;
  - retain pure tool, cache, and internal-envelope transformations.
- `packages/ai/test/provider-adapter.test.ts`
  - replace registered-model coverage with route-leg interface coverage.
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

### Slice 1 — SDK-owned model substrate

No behavior change.

1. Remove `MODEL_DEFINITIONS`, `MODEL_CAPABILITIES`, the correlated identity
   parser, and the empty model rollout set.
2. Construct each route leg with its provider package and attach the matching
   adapter at that point.
3. Replace Alfred's effort vocabulary and provider reasoning blocks with the AI
   SDK generic `reasoning` setting.
4. Keep prompt-cache placement, tool-name encoding, and Alfred's internal
   request envelope behind the concrete adapter wrapper.
5. Make every current request byte-equivalent for Anthropic and behavior-equivalent
   for Gemini. **Normalized request behavior is covered offline by
   concrete-wrapper and forced-fallback tests. Serialized Anthropic byte/cache
   equivalence remains unproven until Slice 0's live probe.**
6. Replace registry tests with route-leg interface tests, including wrapper
   ordering, model identity preservation, generic reasoning projection, and
   removal of the Alfred-only envelope.

The old registry-based items were completed on 2026-07-29, but the 2026-08-09
design correction supersedes them. They are migration work, not a base to extend.

### Slice 2 — logical tool surface

No native enablement yet.

1. Change `AlfredAgent` from flattened `ToolSet` to `LogicalToolSurface`.
2. Have every adapter select application mode.
3. Preserve current exact preload/load/bounce behavior.
4. Replace old shallow tests with interface-level protocol and surface tests.

### Slice 3 — Anthropic native loading

1. Enable native search on one probed Anthropic product route leg.
2. Preserve native search/reference blocks through durable transcript replay.
3. Dispatch verified provider-discovered calls without promotion/reissue.
4. Keep Gemini fallback on application mode.
5. Compare against the existing loader on representative chat evals.

### Slice 4 — OpenAI native loading

Enable only when an OpenAI model is placed on a product route. A direct
`openai.responses(...)` smoke path can validate the adapter earlier, but the
model must not enter an Alfred production registry merely to support that probe.

## Acceptance

Correctness:

- every product route leg is constructed by its installed provider package;
- wrapped and fallback models preserve the provider/model identity supplied by
  that package;
- no handwritten per-model capability or model-to-provider table exists;
- every product route leg resolves one explicit tool-loading policy;
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
- Replacing provider-package model handling with an Alfred compatibility table.

## Decision record

ADR-0078 is amended by the 2026-08-09 design correction: AI SDK and its provider
packages own model mechanics; Alfred owns route and rollout policy. After Slice
0 proves the installed SDK shapes, add the native-loading decision that amends
ADR-0053:

> Logical tool discovery is harness-owned; its wire representation is selected by
> the provider adapter attached to a concrete product route leg. Native deferral
> is an explicitly probed rollout policy behind that seam, while execution policy
> remains provider-independent.
