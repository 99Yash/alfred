# ADR-0029 — Composer model picker: opaque semantic tiers, never provider names

**Decision.** The composer's model picker exposes two values only: `Default` (the boss model — `getBossModel()`) and `Pro` (a higher-tier opt-in for complex tasks — points at the same family today, room to upgrade later). Provider/vendor names (`Claude`, `GPT`, `Sonnet`, `Opus`, etc.) are never shown in the user-facing UI. The chip renders disabled until m13/m14 wire actual routing.

**Why.**

- **Stack-locking pressure is real.** Once a user picks `Claude 4 Opus` from a dropdown, swapping the underlying SKU (whether for cost, latency, or a vendor migration) becomes a UX migration too. Opaque tiers keep the dispatcher (`getBossModel` / `getSubAgentModel` / `getCheapModel`) as the real source of truth — the surface stays stable while the SKUs underneath rotate.
- **Matches the existing dispatcher philosophy.** `@alfred/ai/provider` already abstracts models behind semantic getters (per CLAUDE.md). Hardcoding string model IDs at the UI layer would invert that — the dispatcher becomes a label resolver, not a routing decision.
- **Dimension's pattern, validated.** Dimension's recon confirms they ship only `Dimension` / `Dimension Pro` in the picker — same stance, different brand. The two-tier UX is enough for "I want this answered quickly" vs. "do the deep work" without polluting the surface with seven SKU choices.
- **Single-user scope (ADR-0001) doesn't change this.** Even with one user, future-me will appreciate the dispatcher boundary when a model gets deprecated mid-thread.

**Surface contract.**

- Default tier: routes through `getBossModel()` for chat turns, sub-agents pick their own model via the dispatcher (ADR-0016 + ADR-0026).
- Pro tier: same routing, but the boss model can be upgraded in-session (e.g. a "deeper" boss SKU when ADR-0021/0022 patterns suggest it's worth the cost). Today both tiers resolve to the same model; the chip exists so the upgrade path is wired before it's needed.
- The chip never shows raw model IDs. Settings or a debug surface can expose what's actually routing, but not the composer.

**Alternatives.**

- (a) Full provider dropdown (`Claude 4 Opus / Sonnet 4.5 / GPT-5 / …`) (rejected — locks the UI to specific SKUs; mirrors ChatGPT's surface but ChatGPT is selling SKU choice as a product, alfred isn't).
- (b) No model picker at all (rejected — losing the Pro affordance means we can't expose the "do the deep work" gear when it matters; the picker also doubles as an auto-mode toggle once `Auto` graduates from neumorphic decoration to a real routing decision).
- (c) Three+ tiers (`Fast / Default / Pro / Research`) (rejected — `Auto` already encodes "let the boss pick"; the cheap tier is dispatcher-internal, never user-selected; research-tier work goes through `getResearchModel()` triggered by tools, not by composer choice per ADR-0022).

**Caveat.** If a tier ever needs a sub-name (`Pro — fast`, `Pro — deep`), promote it to a second-level picker rather than collapsing back to SKU strings. The opacity is the invariant.
