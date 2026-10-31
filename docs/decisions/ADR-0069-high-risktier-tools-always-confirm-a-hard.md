# ADR-0069 — High-`riskTier` tools always confirm: a hard approval floor the autonomy toggle cannot override (reverses ADR-0034 alt-(f); supersedes ADR-0050's "no structural risk gate")

**Decision.** A `riskTier: 'high'` tool **always** stages for human approval, regardless of the user's resolved policy mode. The dispatcher gate becomes `requiresApproval = policyMode === 'gated' || riskTier === 'high'` (`toolRequiresApproval` in `dispatch/index.ts`, the single definition shared by the live gate and the `toolCallWouldGate` scheduling hint). `riskTier` — previously a display-only UX hint (ADR-0034) — becomes **load-bearing** for the `high` tier. Everything below `high` (`no_risk`/`low`/`medium`) stays purely policy-driven; the autonomy toggle still silences those. The set of high-tier tools today: `gmail.send_draft`, `railway.redeploy`, `vercel.redeploy`.

**Why.** ADR-0034 alt-(f) rejected hardcoded risk gates as paternalism, and ADR-0050 reaffirmed it ("the user owns the policy"). That stance was sized when the write surface was the user's _own_ reversible-ish outbound (send a draft) — ADR-0001's single-user framing ("don't let the system protect future-you from current-you") squarely applied. **Railway changed the threat model.** A Railway _workspace_ token cannot be scoped down — it is full workspace write — so `railway.redeploy` can re-run a deployment on a _shared team's production service_. That is no longer only the user's blast radius, which is the precise premise alt-(f) rested on. The global "Auto" composer toggle (a chat-convenience control: stop nagging me about reads) flips `defaultMode` to autonomy globally; under the old gate it would silently authorize unattended production redeploys. The risk-tier floor closes that mismatch: the toggle's _apparent_ scope (convenience) can no longer quietly grant its _real_ blast radius (irreversible infra mutation). This is also the industry norm for destructive actions.

**Scope chosen (and the narrower one rejected).** The floor applies to **all** high-tier tools, not just the infra-mutating ones. The narrower "infra redeploys only" floor was considered and rejected by the owner: it would have left `gmail.send_draft` honoring alt-(f) (defensible — your own email), but a uniform "high tier = always confirm" rule is simpler to reason about, matches the `[high]` badge the user already sees, and removes a foot-gun (a future high-tier tool author gets the floor automatically rather than having to remember to add their tool to an allow-list). The cost is that the autonomy toggle can no longer auto-send email — accepted deliberately: high-tier is a small, deliberately-curated set, and the toggle still covers every read and every low/medium write.

**What this is NOT.** Not a return to per-tool _policy_ defaults — the user still owns the `no_risk`/`low`/`medium` gate entirely, and still owns whether a high-tier tool is _otherwise_ gated. It is a one-way floor: policy can make a tool _more_ gated, never less than its tier demands. The HIL machinery is unchanged (ADR-0034) — a floored call stages, parks on `wakeCondition.kind='hil'`, and fires the debounced email exactly like any other gated call.

**Companion fix (approval-card legibility).** A floored `redeploy` is only as safe as what its approval card shows, and the card can fire by email / from the standalone `/approvals` page with no surrounding chat narration. The redeploy input therefore carries display-only `serviceName`/`projectName`/`environmentName` (required service+project, optional env) the boss resolves from `list_projects`; the web card titles "Redeploy {service} · {env} — {project}" and the email body lists the names, so the approver sees what is being redeployed rather than two opaque cuids. These fields never reach the execute path (only `deploymentId` + `credentialId` drive the mutation), so a wrong label can mislead the card but cannot redirect the redeploy.

**Alternatives.** (a) **Keep the status quo** (trust `default_mode = gated` as the protection) — rejected: a single global toggle silently defeats it for the one genuinely-irreversible cross-tenant action. (b) **Infra-redeploy-only allow-list floor** — rejected (above): simpler and more future-proof to floor the whole tier. (c) **Client-side or per-run carve-out on the autonomy toggle** — rejected: the gate must be server-authoritative (background runs have no browser; ADR-0034's m13 chat-bridge note).

**Cross-ref.** Reverses ADR-0034 alt-(f) and supersedes ADR-0050's "no write is blocked structurally by `risk_tier`" for the `high` tier specifically. Composes with ADR-0034 (policy/staging/HIL) and ADR-0044 (the Google scope grant) / the Railway workspace-token connect path (workspace tokens are unscopable full-write).

## Amendment (2026-08-30) — live Gmail sends also have a recipient floor

`gmail.send_draft` is a historical name: its execute path saves a Gmail draft
and calls `users.drafts.send` at once (ADR-0034 amendment item 10), so approval
causes a live external effect. The hard
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

## Amendment — reviewed MCP downgrades cannot lower non-read tools

`railway.redeploy` no longer exists as a native tool: the Railway capability
rides on `mcp.call` through the Railway MCP server. `mcp.call` keeps a static
`high` floor, but its `resolveRiskTier` hook honors a reviewed
`mcp_tool_policy` row. Before this amendment that row won outright in both
directions (ADR-0096 sub-decision 1), so a user who reviewed the redeploy
descriptor once as `no_risk` and then turned the global Auto toggle on got an
unstaged production redeploy — the exact outcome this ADR's floor exists to
close, with this ADR's central example.

The floor is restored without removing the reviewed path: a reviewed row can
always RAISE to `high`, and it can LOWER below `high` only when the persisted
catalog records that tool's own `annotations.readOnlyHint`. The claim is
projected at publication from the descriptor the catalog actually published
(ADR-0096), read from durable state at the gate — never from the model or the
call. A write tool with no read-only claim (Railway `redeploy`,
`accept-deploy`, and any future equivalent) therefore keeps the `high` floor
no matter what tier a review recorded. A clamped reviewed downgrade takes the
floor and does not fall through to the structural branch. The autonomy toggle
still cannot lower anything; a per-descriptor review still can, but only for
reads.

## Amendment (2026-10-24) — chat full autonomy waives the floor for one thread

The chat approval picker has three modes. **Review** and **Auto** set the global
`user_action_policies.defaultMode` (`gated` and `autonomy`), as before. In both modes,
integration rules and tool overrides still win, and the `high` floor in this ADR still applies.
The new mode is **Full autonomy**. It sets `chat_threads.full_autonomy` on one thread. For the
runs of that thread and their sub-agents, the gate waives every approval card, including the
`high` floor. This covers Gmail sends, Calendar invites, and MCP write tools without a reviewed
read-only claim. The owner asked for this mode on purpose. They accept the blast radius for a
thread where they choose it.

**Why this does not repeat the problem this ADR closed.** The floor exists because a global
convenience toggle silently reached background runs and their irreversible effects. Full
autonomy is per thread, and the picker shows it as a red control. A background run (triage,
briefing, workflows) has no chat thread, so it keeps the floor. Alternative (c) above rejected
a client-side or per-run carve-out because the gate must be server-authoritative. This flag is
a server row, and the gate reads it on the server. So the reason for that rejection does not
apply.

**Mechanics.**

- `chatThreadSetApprovalMode` writes the thread flag and, for Review or Auto, the global
  default in one mutation. Both writes share one server savepoint and one optimistic client
  transaction. A failed write cannot leave half of a mode change committed. After commit,
  Review and Auto invalidate the policy cache. Full autonomy leaves the global default alone.
- Before the first turn returns, the pending turn carries the selected full-autonomy flag
  across navigation. The picker keeps that mode visible and disables mode changes until the
  thread row is available. An absent row does not permit a mode change.
- `ToolCallRunBase.approvalThreadId` names the thread. `chatToolRunIdentity` sets it to the
  turn's thread. `briefToolRunIdentity` sets it to `subAgent.chat.threadId`, so a sub-agent of a
  chat turn follows the flag. Any other run leaves it unset.
- The gate reads the flag **live** through `StagingStore.readThreadFullAutonomy`, never from a
  run snapshot. The owner can change the mode mid-chat. A snapshot would keep a long turn in full
  autonomy after a switch back to Review. The read happens only when policy or the floor would
  stage a card, so the normal path makes no extra query.
- A thread that is absent or owned by another user reads as `false`. A doubt keeps the card.
- The `question` arm (`system.ask_user`, ADR-0099) always parks. A question is not an approval
  to waive.
- The promotion path uses the same live value. A row staged without approval under full
  autonomy is promoted into the approval queue if the owner turned the flag off before a
  re-dispatch. This check uses the complete current approval rule, including policy for
  low- and medium-risk tools, rather than only the high-tier floor.
- A row that already waits for approval keeps waiting when the owner turns the flag on. ADR-0034
  says that a pending row can gain a gate but never lose one. The owner approves that card.
- The predictors do not read the flag. `toolCallWouldGate` keeps its over-report, so the batch
  scheduler still runs gated calls one at a time. Otherwise a mid-batch switch to Review would
  make parallel siblings collide (409 `wake_mismatch`). `toolAlwaysWaitsForApproval` and the
  connected summary also ignore it. Under full autonomy the model then skips its own confirm
  question, and that is the intent. After a switch back to Review, the worst case is a second
  confirm.

**What full autonomy does not waive.** These are execution guards, not approvals: the Gmail
recipient check in the amendment above, the unknown-effect barrier, prior-rejection
suppression, and the cancellation fence.

**Audit.** The staging row is still written, with `requires_approval = false`. The dispatcher
logs `[dispatch] full autonomy waived the approval card` with the run, tool, tier, and thread.
