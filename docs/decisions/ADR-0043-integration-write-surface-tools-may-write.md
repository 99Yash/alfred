# ADR-0043 — Integration write surface: tools may write, authorization is the user action policy


**Decision.** Integrations may expose **write tools** (send mail, create/modify calendar events, create Drive files, edit a doc, etc.). Authorization for any write is the composition of three layers we already have, evaluated in order:

1. **Tool registry** — a write tool exists only if it is registered (m13 work). No registration, no write.
2. **Active tool exposure** / `workflows.allowed_integrations` — SDK tools are built only from `state.activeIntegrations`, whose initial seed is strict `@`-mentions intersected with `workflows.allowed_integrations`; later expansion goes through `system.load_integration`, which enforces the same cap (ADR-0026/0040). A workflow whose allowlist excludes an integration can never get that integration's tools exposed to the model. If a future generic dispatch endpoint bypasses SDK tool exposure, it must add an equivalent dispatcher-side active-integration check.
3. **User action policy** (ADR-0034) — the resolved `policy mode` (`autonomy | gated`) decides whether the call executes immediately or stages for HIL. Default `gated`.

No write is blocked structurally by `risk_tier` or by a hardcoded tier; **the user owns the policy** (reaffirms ADR-0034 alt-(f)). This **supersedes ADR-0033's blanket rule** that integrations "expand the *read* surface, never the *write* surface, regardless of OAuth scopes available on the underlying token."

**Why this is its own ADR.** ADR-0033 made an absolute architectural promise — no write tools, ever, regardless of token scope — as a safety stance for the *unattended briefing agent*, written before the action-policy machinery existed. ADR-0034 then built per-call gating but never revisited 0033's promise. Expanding the write surface for the interactive boss agent and (per the product goal) for user-authored workflows forces the question into the open: writes are now first-class, and the guarantee migrates from architecture to configuration.

**The trade we are making (stated honestly).** *Before:* a background workflow architecturally could not send mail — its tool surface had no write tools. *After:* "a background workflow won't send mail unannounced" rests on the policy **default** being `gated`. This is still safe in operation — a `gated` write tool in an unattended run parks on `wakeCondition.kind='hil'` and fires the debounced approval email (ADR-0034); nothing sends without a human decision. But the protection is now a **default, not an invariant**. We accept this because (a) a personal assistant must act, not just read; (b) user-authored workflows will legitimately need to send/create across one or multiple integrations; (c) ADR-0001's single-user framing makes "the system protects future-you from current-you" hostile, not helpful (ADR-0034 alt-(f)).

**What stays true.** The briefing **compose** path remains tool-free by construction (ADR-0041): it is a single structured-output `generateText` over the gather, not an agent loop, so it physically cannot write regardless of policy. "Safety through architecture" survives where it is cheap — a read-only surface stays read-only by being given no write tools and no write integration in its allowlist — and "safety through policy" covers everything that genuinely needs to act.

**Default posture.** New write tools register at whatever `riskTier` the author assigns (UX hint only; ADR-0034) and inherit the user's `default_mode = gated`. The user opts a tool or integration into `autonomy` explicitly (per-integration mode or per-tool override). The forward-compat `set_action_policy` tool (ADR-0034 out-of-scope slot) is the eventual chat path for "trust gmail entirely"; not built here.

**Alternatives.**

- (a) **Keep ADR-0033 absolute; only ever read.** Rejected — defeats the product; a personal assistant that can't send a reply or create a doc is a search box.
- (b) **Reading A: writes for the interactive boss agent only, never for background workflows.** Rejected (considered and dropped 2026-05-27) — the roadmap has workflows that send/create unattended; walling background runs off from writes forces a second, parallel authorization model later. The policy gate already handles unattended writes correctly (park + notify).
- (c) **Hardcode a structural write-block for high `riskTier` regardless of policy.** Rejected — paternalism; restates ADR-0034 alt-(f).

**Cross-ref.** Amends ADR-0033. Composes with ADR-0034 (policy/staging), ADR-0026/0040 (active-integration seed + load cap), and ADR-0044 (the scope posture supplying the OAuth grants these tools call).
