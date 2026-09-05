# ADR-0097 — Reply drafting is a gate-first module behind a default-OFF flag, fed by a triage event it never imports

**Decision.** Alfred drafts a reply only after a pure worthiness gate says the message deserves one, and every run ends in ONE of five typed outcomes (`staged`, `no_draft`, `clarification`, `no_access`, `withheld`). The feature ships as a new `@alfred/assistant` module, `reply-drafting`, that depends on `triage` and that `triage` never imports. The seam between them is a domain event: the triage `classify` step publishes `email-triage.classified` for every thread whose canonical row it owns, and a `best-effort` trigger consumer owned by `reply-drafting` decides from that fact. The proactive path is bound by `feature.reply_drafting`, the first flag whose UNSET value is OFF.

Sub-decisions:

1. **The post-triage seam is an event, not an import.** `reply-drafting` reads `loadTriageContext`, `getTriage`, `getThreadState`, and `extractSenderContext` from `@alfred/assistant/triage`. If triage in turn imported the gate, the two modules would form a cycle that `check-module-architecture.mjs` refuses. So triage publishes a fact and stops. The consumer registers in `trigger-consumers.ts` beside the Gmail ingestion consumers.
2. **`reply_worthy` is declared, never published.** `acceptEvent` starts a run for every `workflows` row whose trigger matches a published event. If the builtin declared `classified` as its trigger, every triaged email would start a run whether or not the flag was on. The builtin therefore declares `{ source: "email-triage", type: "reply_worthy" }`, nothing publishes that type, and the consumer calls `startRun` directly after a worthy verdict. This is the `learn-skill` → `skill-documentation` pattern.
3. **The flag defaults OFF, and both sides resolve it through one function.** `FEATURE_FLAG_DEFAULTS` and `isFeatureFlagOn(key, value)` live in `@alfred/contracts`. The server gate and the settings switch both call it, so a default-OFF flag cannot render as armed on one side and dormant on the other. The four existing flags keep UNSET = ON.
4. **The gate is pure and ordered.** `decideReplyWorthiness` takes the triage snapshot, the sender's effective author, the thread reply timestamps, the triage reason, and the standing-instruction state. It evaluates the structural blockers first (sender is not a person, user already replied), then the proactive rubric (flag, standing instruction, classifier fallback, category not reply-expected, low confidence, cold sender, relationship unverified, todo rubric said handled or not significant). The first failing test names the `no_draft` reason. A `manual` invocation stops after the structural blockers.
5. **The verifier is pure and is the only door to a `GmailSendDraftInput`.** `prepareReplyStaging` runs `verifyReplyCandidate` and returns either a staging plan built through `gmailSendDraftInput.parse` or a `withheld` plan. A composer (#237) cannot obtain the tool input any other way, so the verifier runs before staging by construction. Its decision is bound to the facts bundle (thread id, recipients, claim count, style selection, flag state), not to the prose.
6. **The triage snapshot travels with the result.** `ReplyDraftProvenance.triage` freezes the row facts the gate relied on. A later re-classify of the thread cannot make the recorded decision ambiguous.
7. **Every decision is a trace row of one kind.** Inside the workflow, terminal steps call `ctx.trace("reply_drafting.decision", result)`. The consumer's `no_draft` verdict has no step of its own, so `recordReplyDraftDecision` writes it under the triage run. Both land in `agent_decision_traces` with kind `reply_drafting.decision`.
8. **One run per (thread, inbound document).** The `startRun` occurrence key is `${sourceThreadId}:${documentId}` under provider `email-triage`. A same-document re-classify raises a unique violation, which the consumer logs and drops.
9. **`staged` names what was staged.** `gmail.send_draft` sends live mail after approval and does not create a Gmail Draft. The action kind is `approval_staged_send`, so an audit cannot overstate what happened.
10. **At #243 the composer is a seam.** The `compose` step returns `no_draft` with reason `composer_unavailable`. #237 replaces the step body.

**Extends ADR-0025 #5** (the reply-drafting built-in). **Depends on ADR-0047** (event dispatch) and **ADR-0066** (significance-weighted triage). **Amends the UNSET = ON rule** documented on `user_preferences` for one key.

---

## Why a higher bar than `category === "awaiting_reply"`

Triage keeps the category honest. A cold ask from a stranger IS `awaiting_reply`, and the todo rubric already declines to mint a todo for it. Drafting needs a higher bar than either, because a wrong outbound draft costs more than a wrong tag. The gate composes facts triage already resolved deterministically instead of asking a model again: the rule-16b cold-contact verdict, the todo rubric outcome, the classifier's confidence and fallback state, the thread reply state, and the sender kind. The cold `awaiting_reply` case therefore returns `no_draft` with reason `cold_sender`, and the reason is queryable.

## Why the flag is default-OFF

The four original flags gate agents that were live before the settings page existed. UNSET = ON made shipping those gates a no-op. Reply drafting acts outward on the user's behalf, so it must never arm itself for a user who has not opted in. This is the same posture as the ADR-0074 passthrough toggles.

## Why `manual` ignores the flag

A smoke or an explicit user request is the opt-in. Recording `invocation: "manual"` on the result keeps telemetry from mixing the two paths. The structural blockers still hold: no invocation makes a reply to a bot, or to a thread the user has already answered, sensible.

## Alternatives

- **(a) Import the gate from the triage tail.** Rejected. It creates a `triage → reply-drafting → triage` cycle and makes triage own a decision about outbound mail.
- **(b) Declare `classified` as the builtin's trigger and let `acceptEvent` start the run.** Rejected. A run per triaged email, flag or not, and the flag check moves into the workflow where it costs a run row to say no.
- **(c) Make the composer step call the tool directly and verify afterward.** Rejected. The verifier must run before staging, and a convention is not a proof. Routing the tool input through `prepareReplyStaging` makes the order structural.
- **(d) Create a Gmail Draft instead of staging a send.** Deferred. No `drafts.create` tool exists. When one lands, `REPLY_DRAFT_ACTION_KINDS` gains a second member.
- **(e) Keep UNSET = ON for consistency.** Rejected. Consistency is not worth an outbound action the user never enabled.

## Residual risk

- **The gate and verifier invariants are not compiler-carried.** The order of the rubric, and the fact that a cold `awaiting_reply` returns `cold_sender`, are runtime behavior. Repository policy forbids feature tests, so the proof is `apps/server/src/scripts/smokes/smoke-reply-drafting.ts`, which drives a `manual` run and parses the output with `replyDraftResultSchema`. Nothing re-runs it.
- **The consumer runs inside the triage step's publish.** `mode: "best-effort"` means a consumer failure is logged, not propagated. A bug in the gate cannot fail triage, and it also cannot be seen from the triage run's status.
- **The `classified` event carries no body text.** A consumer that needs content must load the document. This keeps the payload bounded and means the gate can never judge prose.
- **`recordReplyDraftDecision` checks the run's user but not its step.** The consumer runs in-process during `classify`, so the step exists, but the write does not prove it.
