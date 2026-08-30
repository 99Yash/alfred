# ADR-0069 — High-`riskTier` tools always confirm: a hard approval floor the autonomy toggle cannot override (reverses ADR-0034 alt-(f); supersedes ADR-0050's "no structural risk gate")

**Decision.** A `riskTier: 'high'` tool **always** stages for human approval, regardless of the user's resolved policy mode. The dispatcher gate becomes `requiresApproval = policyMode === 'gated' || riskTier === 'high'` (`toolRequiresApproval` in `dispatch/index.ts`, the single definition shared by the live gate and the `toolCallWouldGate` scheduling hint). `riskTier` — previously a display-only UX hint (ADR-0034) — becomes **load-bearing** for the `high` tier. Everything below `high` (`no_risk`/`low`/`medium`) stays purely policy-driven; the autonomy toggle still silences those. The set of high-tier tools today: `gmail.send_draft`, `railway.redeploy`, `vercel.redeploy`.

**Why.** ADR-0034 alt-(f) rejected hardcoded risk gates as paternalism, and ADR-0050 reaffirmed it ("the user owns the policy"). That stance was sized when the write surface was the user's _own_ reversible-ish outbound (send a draft) — ADR-0001's single-user framing ("don't let the system protect future-you from current-you") squarely applied. **Railway changed the threat model.** A Railway _workspace_ token cannot be scoped down — it is full workspace write — so `railway.redeploy` can re-run a deployment on a _shared team's production service_. That is no longer only the user's blast radius, which is the precise premise alt-(f) rested on. The global "Auto" composer toggle (a chat-convenience control: stop nagging me about reads) flips `defaultMode` to autonomy globally; under the old gate it would silently authorize unattended production redeploys. The risk-tier floor closes that mismatch: the toggle's _apparent_ scope (convenience) can no longer quietly grant its _real_ blast radius (irreversible infra mutation). This is also the industry norm for destructive actions.

**Scope chosen (and the narrower one rejected).** The floor applies to **all** high-tier tools, not just the infra-mutating ones. The narrower "infra redeploys only" floor was considered and rejected by the owner: it would have left `gmail.send_draft` honoring alt-(f) (defensible — your own email), but a uniform "high tier = always confirm" rule is simpler to reason about, matches the `[high]` badge the user already sees, and removes a foot-gun (a future high-tier tool author gets the floor automatically rather than having to remember to add their tool to an allow-list). The cost is that the autonomy toggle can no longer auto-send email — accepted deliberately: high-tier is a small, deliberately-curated set, and the toggle still covers every read and every low/medium write.

**What this is NOT.** Not a return to per-tool _policy_ defaults — the user still owns the `no_risk`/`low`/`medium` gate entirely, and still owns whether a high-tier tool is _otherwise_ gated. It is a one-way floor: policy can make a tool _more_ gated, never less than its tier demands. The HIL machinery is unchanged (ADR-0034) — a floored call stages, parks on `wakeCondition.kind='hil'`, and fires the debounced email exactly like any other gated call.

**Companion fix (approval-card legibility).** A floored `redeploy` is only as safe as what its approval card shows, and the card can fire by email / from the standalone `/approvals` page with no surrounding chat narration. The redeploy input therefore carries display-only `serviceName`/`projectName`/`environmentName` (required service+project, optional env) the boss resolves from `list_projects`; the web card titles "Redeploy {service} · {env} — {project}" and the email body lists the names, so the approver sees what is being redeployed rather than two opaque cuids. These fields never reach the execute path (only `deploymentId` + `credentialId` drive the mutation), so a wrong label can mislead the card but cannot redirect the redeploy.

**Alternatives.** (a) **Keep the status quo** (trust `default_mode = gated` as the protection) — rejected: a single global toggle silently defeats it for the one genuinely-irreversible cross-tenant action. (b) **Infra-redeploy-only allow-list floor** — rejected (above): simpler and more future-proof to floor the whole tier. (c) **Client-side or per-run carve-out on the autonomy toggle** — rejected: the gate must be server-authoritative (background runs have no browser; ADR-0034's m13 chat-bridge note).

**Cross-ref.** Reverses ADR-0034 alt-(f) and supersedes ADR-0050's "no write is blocked structurally by `risk_tier`" for the `high` tier specifically. Composes with ADR-0034 (policy/staging/HIL) and ADR-0044 (the Google scope grant) / the Railway workspace-token connect path (workspace tokens are unscopable full-write).

## Amendment (2026-08-30) — live Gmail sends also have a recipient floor

`gmail.send_draft` is a historical name: its execute path calls Gmail
`users.messages.send`, so approval causes a live external effect. The hard
approval floor above stays necessary, but it is not the only boundary. The
execute path now permits recipients only when they are the active Gmail mailbox
or a person the user has emailed before. Every `to`, `cc`, and `bcc` address is
checked after approval and before the provider call. A contact read failure
blocks the send.

"Known contact" is intentionally narrower here than "a person row exists." The
passive Gmail graph creates a person row for an inbound-only sender. Such a row
cannot authorize its own address, because an attacker could join the allow-list
by sending one injected message. The policy therefore requires positive prior
outbound correspondence (`metadata.correspondence.outbound > 0`).

Draft-first was considered. Gmail [`users.drafts.create`](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/create)
is available through the existing `gmail.modify` grant, but changing the
default would turn every current send workflow into a save-only workflow. This
amendment keeps the live send contract and adds the smaller structural
restriction instead. A future separate create-draft tool can add draft-first
behavior without changing an existing action's effect.
