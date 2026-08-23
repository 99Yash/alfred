# ADR-0078 — Per-model capability is code-resident (effort _vocabularies_, not booleans) on a per-provider dispatch profile; models.dev is the audit oracle, not a runtime dependency (BUILT — #313)

**Decision.** The model's structural quirks that a tier→model remap must not get wrong are split onto **two axes with two homes**, and the `tier === "deep"` provider-options branch ADR-0077 left as a TODO is deleted. **(1) Per-model facts → `MODEL_CAPABILITIES` in `packages/ai/src/models.ts`** (`as const satisfies Record<ModelId, …>`): an **effort _vocabulary_** (`effortValues: readonly EffortLevel[]`, weakest→strongest; `[]` = the model has no effort-label control — Haiku 4.5 per ADR-0077 and Gemini 2.5 budget/toggle models) and a `temperature` flag (recorded, not yet sent). The field carries the _value set_, **not a boolean**, and `EffortLevel` is the known-provider union rather than Anthropic's enum: effort vocabularies differ per provider (Anthropic `low…max`, Gemini-3 `minimal…high`, GPT-5.6 `none…max`) and a wrong value 400s exactly like `effort` walked onto Haiku in #224. **(2) Per-provider mechanics → `PROVIDER_DISPATCH` in `provider.ts`** (`Record<ModelProviderId, …>`): a `reasoningOptions(modelId, effort)` block-builder that reads the model's `effortValues` and clamps where the current SDK option shape supports effort labels. Google dispatches effort-bearing Gemini 3.x models through `thinkingConfig.thinkingLevel` and keeps budget-based Gemini 2.5 models on `thinkingBudget`; it never sends one generation's option shape to the other. The dispatch also owns the `toolNameShim` policy + `toolNameMaxLen` pinned by the registry invariant test. `ProviderId` remains the broader metering enum (including OpenAI transcription), while `ModelProviderId` is the narrower language-model dispatch key. `getChatModel`/`getChatProviderOptions` share one provider-agnostic `CHAT_TIERS` table (the only place a tier's model is named) and route the model factory + reasoning block through the resolved provider. The tool-name shim is generalized (`withAnthropicToolNames` → `withToolNameShim`) and applied per `PROVIDER_DISPATCH[provider].toolNameShim`, which **also wraps Google** — closing the latent bare-name bug (`google` strips the `integration.` prefix → `unknown_tool` punt) the moment Google is ever a primary, not just a fallback. `db:sync-prices` captures `reasoning_options` + `temperature` into `model_prices.metadata.capabilities`, and a non-gating `verify-capabilities` script diffs the code-resident values against that **synced snapshot** (not a live fetch), failing on malformed snapshots or unknown effort labels rather than filtering them out.

**Why.** Swapping the chat model meant rediscovering each model's structural quirks by hand — usually via a live 400 or a silently-degraded turn (the #224/#303/ADR-0077 class). Two pieces of research (2026-06-28) reshaped the fix away from the issue's flat `{ supportsEffort: boolean, needsToolNameShim }` struct: **models.dev** (145 providers) proved the reasoning-control universe is a closed 3-type set (`effort`/`budget_tokens`/`toggle`) and that effort is a per-model _vocabulary_ a boolean can't capture, while tool-name handling and option _shape_ are per-provider/per-SDK-adapter and live nowhere in models.dev — so flattening both onto one per-model struct was the design error. **opencode's `transform.ts`** (the reference models.dev consumer, same team) independently validates the two-axis split (per-model effort-label → block map; per-provider `switch(npm)` for option shape and tool-name scrub) and — despite _building_ models.dev — keeps all of it **in code**, not derived at runtime. That settles the code-resident-vs-DB-derived question: code-resident (the provider layer is sync + hot-path, and models.dev has gaps — e.g. `structured_output` absent for every Anthropic model), with models.dev as the _audit oracle_ we add cheaply because our quirks are the silently-expensive ones. We take opencode's architecture and leave its ~600-line `id.includes()` sprawl: Alfred has 6 models in a closed registry, so this is ~40 enumerated lines.

**Alternatives.** (a) **`supportsEffort: boolean`** — rejected: effort vocabularies differ per provider; a boolean reintroduces the #224 400. The field carries the value set. (b) **Derive capabilities from models.dev at runtime** — rejected: opencode keeps it in code, the provider layer is sync + on the hot path, and models.dev has gaps; it stays an audit oracle reading the synced snapshot, never a runtime dependency (also honors the triage-eval-provider-coupling lesson — no live-provider coupling in CI). (c) **One flat per-model struct incl. tool-name shim** — rejected: conflates the per-model reasoning axis with the per-provider transform axis; `needsToolNameShim` is mis-framed as "non-Anthropic" when it's a per-provider pattern+length policy true for Anthropic _and_ Google _and_ (future) OpenAI. (d) **Key the dispatch on the logical provider forever** — accepted _for now_ with a noted caveat: the same Claude model has different option shapes across `@ai-sdk/anthropic` / `-bedrock` / `-vertex`, so the key is conceptually the SDK _adapter_; Alfred is 1:1 today, a future Bedrock/Vertex add needs its own entry. (e) **Make `verify-capabilities` a CI gate** — rejected: non-gating tripwire run after a model swap; gating on a synced snapshot that can lag a models.dev change would redden CI on drift that isn't a code defect.

**Cross-ref.** Amends the ADR-0053 reference in #313 and supersedes the `getChatProviderOptions` `tier === "deep"` branch ADR-0077 left as the #313 seam. Prevents the silent-fallback class of ADR-0077's motivating swap (#224/#303). Feeds the #249 model-router, which consumes the effort-label map (`reasoningOptions(model, routerEffort)`) rather than re-deriving it. Generalizes the tool-name policy from `.lessons/anthropic-rejects-dotted-tool-names` + `.lessons/swap-chat-model-live-browser-replay` (the Google bare-name inverse). Plan: `docs/plans/per-model-capability-map-v1.md`. **Parked (out of scope):** runtime DB-derived capabilities; opencode's schema-sanitization structured-output path (the cheap tier's same-provider pin already works); `temperature` plumbing (recorded, unsent); adding an OpenAI language model to `MODEL_REGISTRY`/chat tiers (OpenAI transcription still meters through `ProviderId`, but no OpenAI chat model is dispatched today).

**Amendment (2026-07-29) — one deep provider adapter module.** The two-axis
decision remains, but the per-provider mechanics moved from a dispatch fragment
in `provider.ts` into the single `PROVIDER_ADAPTERS` map in
`packages/ai/src/provider-adapter.ts`. Each adapter now owns concrete model
construction, reasoning option shape, tool-name encoding policy, cache
projection, and tool-loading protocol selection behind `withProviderAdapter`.
`provider.ts` retains product route and fallback policy only. This removes the
wrapper-ordering knowledge that had leaked across `provider.ts`,
`provider-protocol.ts`, and `tool-name-shim.ts` while preserving
`MODEL_CAPABILITIES` as the per-model source of truth.

The product interface is now one `route(name)` handle rather than separate
model getters and provider-option builders. `MODEL_ROUTES` declares each
non-empty model chain with its reasoning policy; `.model()` and
`.providerOptions()` fold the same chain, and route construction installs those
options as overridable defaults around the composed fallback. The
`ProviderAdaptedLanguageModel` brand is applied once, after composition, inside
the provider-adapter module. This makes a third fallback leg a one-table edit
and prevents a model chain from drifting away from its provider reasoning
blocks.

**Amendment (2026-08-09) — AI SDK 7 and its provider packages own model
mechanics; Alfred keeps route policy, not a parallel model catalog.** This
supersedes the original code-resident per-model capability decision. The
installed AI SDK exposes one provider-neutral `reasoning` setting, and the
installed Anthropic, Google, and OpenAI packages already translate it through
their own model-aware capability logic. Provider-created model objects also own
their `provider`, `modelId`, and `supportedUrls`, while the provider packages own
provider option schemas and native tool constructors. Alfred must therefore
remove its parallel effort vocabularies, `temperature` facts,
`nativeToolSearch` facts, model-to-provider registry, and correlated identity
parser instead of maintaining a second incomplete copy.

Alfred still owns semantic product routes, fallback order, route reasoning
policy, metering, and explicit native-tool rollout. Each route leg is
constructed directly through its provider package and receives its matching
Alfred adapter before fallback composition. Native loading is enabled on a
specific route leg only after the installed package and live model pass the
characterization probe. That opt-in is product rollout policy, not a universal
model capability registry. Provider-specific cache placement, tool-name
encoding, internal-envelope removal, and foreign-tool filtering remain in the
Alfred adapter only where the provider package does not already own them. See
`docs/plans/provider-native-tool-loading-v1.md` for the corrected build shape.
