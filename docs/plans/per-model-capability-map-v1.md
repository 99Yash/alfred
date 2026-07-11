# Per-model capability map — v1 (#313)

> **Status: BUILT (2026-06-28).** ADR-0078 recorded in `decisions.md`. Shipped:
> `MODEL_CAPABILITIES`/known-provider `EFFORT_LEVELS` in `models.ts`; `PROVIDER_DISPATCH` +
> `clampEffort` + `CHAT_TIERS` in `provider.ts` (tier branch deleted, wire-identical
> output asserted); `withToolNameShim` rename applied per-policy to Anthropic **and**
> Google; `sync-prices` captures `reasoning_options`+`temperature`; `verify-capabilities`
> audit script. Tests: `test/provider-capabilities.test.ts` (clamp + wire-identical
> invariants) and `test/tool-name-shim.test.ts` (strictest shimmed provider name cap).
> Deferred per "Scope (out)": runtime DB-derivation, schema-sanitized structured
> output, `temperature` plumbing, and mapping an OpenAI language model into chat.
> Review hardening: OpenAI remains only a metering/transcription provider until
> an OpenAI chat model exists in `MODEL_REGISTRY`; Google dispatch fails loudly if
> an effort-bearing Google model is registered before its SDK mapping is added;
> `verify-capabilities` parses DB metadata as untrusted JSON.
>
> **Verified live (2026-06-28):** `db:sync-prices` re-synced (94 rows; capability-aware
> change-detection landed the new metadata), `verify-capabilities` → ✅ all 6 models
> match models.dev. Browser chat on the Auto tier ran `gmail.search` (a dotted-name
> tool) end-to-end and returned a correct summary; `api_call_log` confirms both boss
> turns served by `anthropic/claude-haiku-4-5` (no silent Gemini fallback) with the
> #223 cache warm (`cached_input_tokens` 7478). The Google-as-primary dotted-name
> probe (step 3) remains the one unrun manual check — Google is still only a fallback.

> **2026-07-11 amendment (#370).** The chat-compaction/media-enrichment plan extends the
> code-resident per-model axis with accepted input modalities and relevant request limits.
> Those fields route the asynchronous enrichment worker only; they do not route the sticky
> answering chat model. The existing models.dev audit posture remains: catalog data is an
> audit oracle, never an unvalidated runtime source of truth. See
> [chat-compaction-and-overflow-v1.md](./chat-compaction-and-overflow-v1.md).

Fixes #313: swapping the chat model means **rediscovering each model's structural quirks by hand**, usually via a live 400 or a silently-degraded turn. Today the tier→model→capability mapping is hardcoded in three places (`getChatModel`, `getChatProviderOptions`, the `anthropicModel`/`googleModel` factories), and a future tier remap can reintroduce an unsupported param — the exact #224/#303/ADR-0077 class of silent-fallback bug.

This plan is the durable fix. It is **grounded in two pieces of research** (2026-06-28): the full models.dev catalog (145 providers) and opencode's `transform.ts` (the reference consumer of models.dev, written by the same team). Both are summarized below because they overturn the shape the issue originally proposed.

## What the research changed about the issue's proposal

The issue proposed a flat per-model struct: `{ supportsAdaptiveThinking, supportsEffort, needsToolNameShim }`. The research says that struct is **too coarse and conflates two axes**. Three findings:

1. **`supportsEffort: boolean` is insufficient — effort *vocabularies* differ per provider and a wrong value 400s.** models.dev carries 30 distinct effort value-sets across the catalog. Anthropic: `low/medium/high/xhigh/max`. Gemini 3: `minimal/low/medium/high`. OpenAI gpt-5.2: `none/low/medium/high/xhigh`. `effort:"xhigh"` is valid on Anthropic and a 400 on Gemini; `effort:"minimal"` is the reverse. A boolean walks into that the way `effort` walked onto Haiku in #224. **The field must carry the value set, not a flag.**

2. **The reasoning quirk and the tool-name quirk live on different axes with different sources of truth.** Reasoning/effort/temperature are **per-model** and **already in models.dev** (`reasoning_options`, `temperature` — and Alfred's six IDs all resolve there). Tool-name handling and the provider-options *shape* are **per-provider/per-SDK-adapter** and live **nowhere in models.dev** (confirmed: no catalog key touches tool names or option shapes). Flattening them into one per-model struct is the design error.

3. **`needsToolNameShim` is mis-framed as "non-Anthropic-native".** The `.`↔`__` shim is needed by **Anthropic** (rejects `.`, pattern `^[a-zA-Z0-9_-]{1,128}$`) **and Google** (strips the prefix → emits bare `search` → `unknown_tool` punt; see `.lessons/swap-chat-model-live-browser-replay.md`) — and would be needed by **OpenAI** too (dots illegal, plus a 64-char cap vs Anthropic's 128). It is a **per-provider transform policy** (pattern + max length), currently true for all three. `googleModel` at `provider.ts:28` not wrapping it is a **latent bug** the moment Google is ever a primary, not just a fallback.

### models.dev facts (the empirical grounding)

The universe of reasoning-control mechanisms across all 145 providers is a **closed 3-type set**: `effort`, `budget_tokens`, `toggle`. That closed set is the "satisfies all providers" guarantee. models.dev already derives the exact quirk #313 hand-codes:

| Alfred model | models.dev `reasoning_options` | `temperature` |
|---|---|---|
| `claude-haiku-4-5-20251001` | `[{budget_tokens, min:1024}]` — **no effort** | `true` |
| `claude-opus-4-8` | `[{effort:[low…max]}]` | **`false`** (matches the 4.7+ 400) |
| `claude-sonnet-4-6` | `[{effort:[low…max]},{budget_tokens}]` | `true` |
| `gemini-2.5-pro` | `[{budget_tokens,128–32768}]` | `true` |
| `gemini-2.5-flash`/`-lite` | `[{toggle},{budget_tokens}]` | `true` |

Caveat — **models.dev has gaps**: `structured_output` is *absent* for every Anthropic model even though the API supports it. So models.dev is a good audit oracle, **not** a runtime source of truth.

### opencode validates the two-axis design — and says keep it in code

opencode's `packages/opencode/src/provider/transform.ts` is the reference implementation. It separates exactly the layers this plan proposes:

| This plan's layer | opencode equivalent |
|---|---|
| per-provider reasoning-block builder | `variants(model)` → `Record<effortLabel, block>`, a `switch (model.api.npm)` |
| effort **vocabulary** (not a boolean) | hand-coded constants (`WIDELY_SUPPORTED_EFFORTS`, `OPENAI_GPT5_2_PLUS_EFFORTS`, …) selected per model |
| tool-name transform policy | per-provider `toolCallId` scrub in `normalizeMessages` (`/[^a-zA-Z0-9_-]/g → _` for claude) |
| provider-options namespace routing | `sdkKey(npm)` + `providerOptions(model, opts)` |
| structured-output mechanism | `schema(model, …)` per-provider JSON-schema sanitization |
| temperature handling | `temperature(model)` → value or `undefined` (claude → `undefined`) |

Three things opencode teaches that the issue missed:

- **The reasoning block is an effort-label → block *map*** (`variants`), precomputed per model, indexed at request time by the chosen effort (`request.ts:81`). This is exactly the seam the #249 model-router wants — the router picks an effort label; the map yields the block.
- **Key on the SDK adapter, not the logical provider.** The same Claude model has three different option shapes across `@ai-sdk/anthropic`, `@ai-sdk/amazon-bedrock`, `@ai-sdk/google-vertex/anthropic`. Alfred is 1:1 provider↔adapter today, so provider-keying is fine **now**, but the key is conceptually the adapter — note it so a future Bedrock/Vertex add doesn't break.
- **They keep all of it in code and do *not* derive it from models.dev at runtime** — despite *building* models.dev. That settles the "code-resident vs DB-derived" question: code-resident, with models.dev as an audit oracle (which opencode skips and we add, cheaply, because our quirks are the silently-expensive ones).

What we deliberately **do not** borrow: opencode's `variants()` is ~600 lines of accreted `id.includes()` special-casing for ~hundreds of models (their own comment: *"fix this stupid inefficient dogshit function"*). Alfred has **6 models in a deliberately-closed registry**. We take the *architecture* (layered pure functions, effort-label map, per-provider keying) and leave the sprawl — this is ~40 lines, enumerated explicitly, not fuzzy-matched.

## The load-bearing distinction (do not collapse)

**Two axes, two homes:**

- **Per-model facts** → `MODEL_REGISTRY` in `packages/ai/src/models.ts` (already the closed enumeration of the 6 models). Add only what the data proved matters: the **effort vocabulary** (`[]` encodes "no effort param" — which for Haiku 4.5 *is* ADR-0077's empty-block) and `temperature` support (future-proofing; not sent today).
- **Per-provider mechanics** → a small `PROVIDER_DISPATCH` profile in `provider.ts`: the reasoning-block builder and the tool-name shim policy. It is keyed by `ModelProviderId` (providers that actually have language models in `MODEL_REGISTRY`), while `ProviderId` remains the broader metering enum that also includes OpenAI transcription.

models.dev is neither home — it is the **audit oracle** that proves the code-resident effort vocabularies still match reality.

## The API

### Per-model axis — extend the registry (`models.ts`)

```ts
/** Effort labels providers may accept, weakest→strongest; clamp per model. */
export const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export interface ModelCapabilities {
  /**
   * Effort values the model accepts, weakest→strongest. `[]` = no effort/adaptive
   * param — send the provider's light/empty reasoning block (Haiku 4.5 per ADR-0077).
   * Mirrors models.dev `reasoning_options[].values`; the audit script asserts it.
   */
  readonly effortValues: readonly EffortLevel[];
  /** Model accepts a `temperature` param. `false` on Opus 4.7+/Fable (they 400). Not sent today. */
  readonly temperature: boolean;
}

// Keyed by ModelId, `as const satisfies Record<ModelId, …>` so a missing model is a compile error
export const MODEL_CAPABILITIES = {
  "claude-opus-4-8": { effortValues: ["low", "medium", "high", "xhigh", "max"], temperature: false },
  "claude-sonnet-4-6": { effortValues: ["low", "medium", "high", "max"], temperature: true },
  "claude-haiku-4-5-20251001": { effortValues: [], temperature: true }, // ADR-0077: empty block
  "gemini-2.5-pro": { effortValues: [], temperature: true },             // budget-based; effort N/A
  "gemini-2.5-flash": { effortValues: [], temperature: true },
  "gemini-2.5-flash-lite": { effortValues: [], temperature: true },
} as const satisfies Record<ModelId, ModelCapabilities>;
```

### Per-provider axis — dispatch profile (`provider.ts`)

```ts
interface ProviderDispatch {
  /** Apply the `.`↔`__` tool-name shim at this provider's edge. True for all 3 today. */
  readonly toolNameShim: boolean;
  /** Max tool-name length the provider accepts (Anthropic 128, OpenAI 64). */
  readonly toolNameMaxLen: number;
  /**
   * Build the AI-SDK providerOptions reasoning block for a model at a desired effort.
   * Owns the block SHAPE; reads the model's effortValues to clamp. The one place a
   * tier→model remap can't reintroduce an unsupported param.
   */
  reasoningOptions(modelId: ModelId, effort: EffortLevel): Record<string, unknown>;
}

const PROVIDER_DISPATCH = {
  anthropic: {
    toolNameShim: true,
    toolNameMaxLen: 128,
    reasoningOptions(modelId, effort) {
      const { effortValues } = MODEL_CAPABILITIES[modelId];
      if (effortValues.length === 0) return {}; // Haiku 4.5 — empty block (ADR-0077)
      return { thinking: { type: "adaptive", display: "summarized" }, effort: clamp(effort, effortValues) };
    },
  },
  google: {
    toolNameShim: true, // fixes the latent bare-name bug when Google is primary
    toolNameMaxLen: 64,
    reasoningOptions() {
      return { thinkingConfig: { includeThoughts: true, thinkingBudget: -1 } };
    },
  },
} as const satisfies Record<ModelProviderId, ProviderDispatch>;

/** Snap a desired effort to the nearest value the model actually accepts. Never emits an unsupported tier. */
function clamp(desired: EffortLevel, allowed: readonly EffortLevel[]): EffortLevel { /* nearest by index */ }
```

`getChatProviderOptions` then becomes a thin dispatcher that namespaces each provider's block (`{ anthropic: …, google: … }`) so the AI SDK passes only the matching one — preserving the existing fallback-safety. The `tier === "deep"` branch at `provider.ts:165-172` disappears: `deep` resolves to `opus-4-8` and asks for `effort:"high"`; `standard` resolves to `haiku-4-5` whose `effortValues:[]` yields `{}`. Identical wire output to today, but a future remap (e.g. `standard → sonnet-4-6`) produces the correct adaptive block automatically instead of a 400.

### Tool-name shim — generalize and apply per policy

Rename `withAnthropicToolNames` → `withToolNameShim` (the encode/decode is already provider-agnostic). Apply it in the factory off `PROVIDER_DISPATCH[provider].toolNameShim` rather than only inside `anthropicModel`. This wraps `googleModel` too, closing the latent bug.

## Scope (in)

- **`models.ts`**: `EFFORT_LEVELS`/`EffortLevel`, `MODEL_CAPABILITIES` (`as const satisfies Record<ModelId, …>`).
- **`provider.ts`**: `PROVIDER_DISPATCH` + `clamp`; rewrite `getChatProviderOptions` to dispatch through it; delete the `tier==="deep"` branch and the `TODO(#313)`. `getChatModel` stays (tier→model is a product mapping, not a capability), but its provider-options comment block shrinks to a pointer.
- **`tool-name-shim.ts`**: rename to `withToolNameShim`; apply per `toolNameShim` policy in the factories (wraps Google).
- **`db:sync-prices`** (`sync-prices.ts`): 4-line extension — capture `reasoning_options` + `temperature` into `model_prices.metadata.capabilities` (already stores `{reasoning, toolCall}`).
- **Audit (non-gating)**: a `verify-capabilities.ts` script (eval-lane, not the unit gate) that diffs `MODEL_CAPABILITIES` against models.dev's `reasoning_options`/`temperature` for the 6 registered IDs and fails on drift. **Non-gating and not network-coupled in CI** — it reads the synced `model_prices` snapshot, honoring `.lessons` / the triage-eval-provider-coupling memory (never redden CI on a live-provider blip). Mirrors the `tool-name-shim.test.ts` registry-invariant pattern.

## Scope (out / parked)

- **DB-derived-at-runtime capabilities** — rejected (opencode keeps it in code; provider layer is sync + hot-path; models.dev has gaps). models.dev stays an audit oracle.
- **Structured-output-via-schema-sanitization** (opencode's `schema()` approach) — the cheap tier's `same-provider` pin is lower-risk and already shipped; revisit only if a cross-provider structured path is needed.
- **`temperature` plumbing** — the capability is recorded but Alfred sends no temperature today; wire it only when a model that needs it lands.
- **OpenAI chat mapping** — no OpenAI language model is in `MODEL_REGISTRY` or `CHAT_TIERS` yet (transcription already meters through OpenAI but isn't a language-model dispatch), so there is no OpenAI dispatch profile/factory until the first OpenAI chat model is added.
- **#249 model-router** — consumes this (`reasoningOptions(model, routerEffort)`), not built here.

## Implementation order

1. `MODEL_CAPABILITIES` + `EffortLevel` in `models.ts` (pure data; unit-trivial).
2. `PROVIDER_DISPATCH` + `clamp` in `provider.ts`; rewrite `getChatProviderOptions`; delete the tier branch. Assert wire-identical output for `{deep, standard}` against today (replay-diff, per the agent-change-verification lesson).
3. `withToolNameShim` rename + per-policy application; confirm Google-as-primary emits dotted names (the latent-bug fix) via a direct `generateText` probe.
4. `sync-prices` capture + `verify-capabilities` audit script.

## ADR

Recommend **ADR-0078** — "Per-model capability is code-resident (effort *vocabularies*, not booleans) on a per-provider dispatch profile; models.dev is the audit oracle, not a runtime dependency." Amends the ADR-0053 reference in #313 and supersedes the `getChatProviderOptions` tier-branch that ADR-0077 left as the #313 seam. Cross-ref ADR-0077 (the swap that motivated it), #224/#303 (the silent-fallback class it prevents), #249 (the router that consumes the effort-label map), and `.lessons/anthropic-rejects-dotted-tool-names` + `swap-chat-model-live-browser-replay` (the tool-name policy).
```
