# Triage user-model — v1 (the significance-weighted category consumer)

Fixes the root cause behind triage over-tagging (#210/#218): the classifier reasons about *what a mail says*, blind to **who the user is**, **whether the mail is even theirs to act on**, and **how much its sender/stakes matter**. Over-tagging is the symptom; the absent user-model is the disease. Designed in one grill (2026-06-23) as **ADR-0066** (amends ADR-0048/0059/0060), then re-scoped by **ADR-0067**: this plan now owns the **category semantics and consumer cutover**, while the entity cleanup, identities, "You" inputs, fact hygiene, and backfill substrate come from the multi-source observation-log foundation.

Supersedes the separate-axis posture of the shipped #210 attention-demotion (ADR-0064): significance no longer rides a parallel presentation layer — it is folded **into the category decision**.

## The pivot (the load-bearing reversal)

**The category becomes significance-weighted.** ADR-0059 explicitly *rejected* letting significance demote the category ("a cold ask is still an honest `awaiting_reply`; significance only gates the todo") and #210 built priority as a separate dimmed-vs-bright axis. This rewrite reverses that: for a **personal** assistant at single-user scale, *useful* beats *taxonomically honest*. `urgent`/`action_needed` must be **trustworthy, high-signal labels** — when the user wakes and sees `action_needed`, it means something. Routine, low-stakes, or cold-sender actionable noise → `fyi`.

This is a deliberate amendment, written as such — not pretended-consistent.

## Foundation dependency (ADR-0067)

This plan must not build a second user-model pipeline on the legacy email-only graph. ADR-0066 owns:

- the significance-weighted category definitions;
- the envelope/audience **soft** category signal;
- standing-instruction consumption and the security override floor;
- evals and the single final re-categorization.

ADR-0067 provides:

- `entity_identities` and cross-source identity resolution;
- the `person|organization|group|service|repository|project` taxonomy;
- the distribution-list / service hard gate (`group` and `service` are never person-scored);
- subject-bound `user_facts` via `FACT_ONTOLOGY`;
- the "You" block inputs from confirmed user/entity facts;
- one shadow-build + validated cutover/backfill.

**Default release rule:** do **not** ship the significance-weighted category fold on the polluted legacy graph. Fast relief before ADR-0067 cutover is limited to low-risk prompt/eval hardening that does not depend on sender significance (`rule 8a`, rationale grounding, read-only dry-runs). The category fold ships after the ADR-0067 projection has passed shadow validation, so the system re-tags once.

## Invariants that still hold

- **Same 10-label set, no new column.** `urgent, action_needed, follow_up, awaiting_reply, meeting, fyi, done, payment, newsletter, marketing`. No two-axis state machine (that mirrors dimension's full machinery; overkill at single-user scale). No directional `awaiting_reply` rewrite — see below.
- **The security floor (ADR-0048/0060) is absolute.** An exposed secret stays `urgent` even under a user "mute this sender" instruction. Users can up-rank or down-rank everything *else*.
- **One immutable tag per thread, re-evaluated on reply (ADR-0051).** Significance is read at classify time; it does not silently re-stamp old rows (that's what the single backfill is for).

## The category model (redefined definitions)

Significance + envelope + user-context weight the category. The discriminator is the **existing todo rubric 16b line**, promoted from gating the *todo* to gating the *category*:

- **Significance demotes person-driven demand.** A cold / weak / no-history sender's ask, reply-request, or connection request → `fyi`. A significant / two-way / role-relevant sender's ask → `awaiting_reply` / `action_needed`.
- **`awaiting_reply` stays inbound + significance-gated** — "a sender who *deserves* a reply is waiting." Cold inbound ask → `fyi`. **Bare outbound sent-mail is not surfaced** as a demanding category (matches the dimension recon: it only tagged threads with an actual reply). No directional/outbound redefinition — that was a handoff misread, corrected.
- **Real intrinsic stakes are UNGATED** — money owed (`payment`), a *genuine* deadline, loss of access, a security exposure (`urgent`), a commitment the user made. These hold regardless of sender significance: a cold sender's overdue invoice is still `payment`.
- **Manufactured stakes do NOT shield.** A sender-imposed "respond by EOD," marketing scarcity, gamified/ceremonial urgency is not a real deadline (reuse rule 16b `manufactured:` / 11a). It does not protect a low-significance item from demotion.
- **Everything is overridable** by a standing instruction (below).

## The three new deterministic signals (ADR-0051 "make the cheap model smart")

All three are pure observations assembled pre-model, anchoring the rubric. The default stays LLM-judged (free-text email can't be pure-rules) but is *constrained* by deterministic signals — "good deterministic defaults, flexible user override."

### 1. Envelope / audience signal

Computed from `to`/`cc`/headers (all persisted: `to`/`cc` in `documents.metadata`, full headers in `documents.raw.payload.headers`) vs the user's **known addresses** = the set of all connected Google account labels (`integration_credentials.accountLabel`) plus ADR-0067 identity projections when available.

- `recipientPosition`: **direct** (in To) / **cc'd** / **not-listed** (forwarded or via a distribution address)
- `audienceSize` + `isDistributionList` (`List-Id` present, or To is a group address like `engineering@oliv.ai`)

**Two consumers, treated differently:**
- **Category (soft signal):** principle, not hard rule — *"an action on mail you're not directly addressed on (broadcast/forwarded/distribution) is rarely your personal `action_needed` → lean `fyi` unless a real intrinsic stake, a relevant user role, or a standing instruction says otherwise."* Soft because a forwarded mail *can* genuinely be yours.
- **Entity projection (HARD gate, delegated to ADR-0067):** a distribution alias / list sender (`engineering@...`, `'X' via Engineering`, `List-Id` present, no real personal address) must project as `group`/`service`, never `person`, and must never be person-significance-scored. This is the fix for the live `'Anthropic' via Engineering` bug — it is currently the **top-scored "person" on prod (0.72)**, silently corrupting every significance-weighted decision. Misjudging a forwarded mail's category is recoverable + overridable; personifying a distribution alias as the #1 contact is not.

### 2. User-context "You" block (the missing half)

Triage reads **nothing** about the user today (ownership gate rule 16a has only name + email). Add a bounded **"You (the user)"** observation, assembled from ADR-0067 projections via `getUserContext()` (confirmed facts only) + `bio_summary` + subject-bound user/entity facts:
- role / title, **ownership / responsibility domains** ("owns: baserow-middleware, autosched; backend lead"), same-org signal.

Powers two things: (a) significance *relative to the user's role*, and (b) the **role-based escalation** — a broadcast "who can fix the baserow outage?" *is* `action_needed` if the user owns baserow, even though it went to `engineering@`. Kept terse (same discipline as the Sender-relationship line) — a role+ownership summary, not the full bio/dossier, given the cheap-model cost.

### 3. Standing instructions (the override) — ADR-0060

The escape valve that makes a universal rubric's inevitable holes a non-problem: the rubric is a sane default; the user's stated preferences flip it.

- **Capture:** user says it in chat ("engineering group sessions are `fyi` for me", "PR-merge asks on the alfred repo are `action_needed`"). The **boss recognizes** it and stores via a tool — structural conflict-check in the tool, semantic by the boss.
- **Store:** authoritative capture is an ADR-0067 `source='user'|'alfred_chat'` observation; the ADR-0060 `user_facts` row (`key=standing_instruction`, optional `target`, optional `enforcement`) becomes the projection consumed by triage, not a parallel write path.
- **Apply:** at classify, injected as an observation the rubric honors (prose-first), with a deterministic carve-out for `enforcement` ("ALWAYS `fyi`") hard guarantees. Resolved against the entity-graph + calendar (this is where the "graph backend" earns its place — it's the *context for interpreting* the directive).
- **Precedence:** ADR-0067 resolves source conflicts by rank-then-recency (`user` beats integrations regardless of time); within the projected standing-instruction set, specificity-then-recency chooses among matching directives. Security floor remains un-down-rankable.
- Manageable in `/settings`.

## The user-model stays current (the auto-update loop)

User-context is useless if stale. ADR-0067 feeds it through the `observations` log and the existing `user_facts` confidence gate (`confidence`, `status` ∈ {proposed, confirmed}, `validUntil`):
- **Extract/project** candidate user-facts (role, ownership) from integration observations and chat/user-correction observations — not a second triage-local pipeline.
- **High confidence** (strong explicit signal / corroboration) → `confirmed` → immediately feeds the "You" block.
- **Low confidence** → `proposed` → **not** consumed (`getUserContext` already filters to `confirmed`), so a shaky guess never silently moves tags.
- **Promotion** → a `proposed` fact corroborated by a later mail → auto-`confirmed`.
- **Temporal** → role changes use `validUntil` so "backend lead" expires when superseded.
- **Surface:** a `/settings` "Learned about you — confirm/dismiss" review queue + a one-line briefing mention for auto-confirmed facts. No per-fact chat interruption.

## Scope (out / parked)

- **Two-axis content×lifecycle state machine** — rejected (dimension-package mirroring; the 10-label set + significance-weighting carries the value at single-user scale).
- **Directional / outbound `awaiting_reply`** — rejected (handoff misread; dimension didn't tag bare sent-mail either).
- **Notification / quiet-hours gating** — out. The "2 AM" complaint was *category*, not timing ("I can be asleep"). Tagging is already real-time (`ingest→tag` ≈ 0 on prod); there is no latency bug.
- **Reading dimension's source** — explicitly off-limits (Yash's call; it's his build + a portfolio artifact). Recon from the labeled inbox only.
- **Deep ownership mining from raw activity** — parked. v1 consumes explicit/confirmed subject-bound facts and ADR-0067 work-object/entity relations; it does not freely infer "you own X" from noisy activity alone.

## Build order (consumer cutover, single backfill)

The backfill is sequenced, not one command — context must be populated *before* the re-classify, or the chicken-and-egg (good tags need user-context + clean graph) bites. The **tags are re-written once**.

0. **ADR-0066 written** (decisions.md) — the significance-weighted-category pivot; explicitly reversed ADR-0059/0064 for product semantics.
1. **ADR-0067 foundation ships through shadow validation** — new observation log, identities, kind taxonomy, fact ontology, source-weighted significance, and consumer-ready "You" inputs. This replaces the old entity-cleanup and backfill steps that this plan originally owned.
2. **Pre-cutover relief only:** ship/evaluate rubric hardening that is true without graph trust (`rule 8a`, rationale/context grounding, service-notification exceptions). No category fold based on legacy sender significance.
3. **Consumer contracts:** define the classify-time input shape: `AudienceObservation`, `UserContextObservation`, `SenderSignificanceObservation`, `StandingInstructionObservation`. Pure/unit-tested; no Node-only imports into web contracts.
4. **Rubric rewrite:** significance-weighted category definitions + the floor (real stakes ungated, manufactured don't shield) + the envelope soft-signal rule + the role-escalation rule + the "You" block wired in. Eval cases updated (`triage-classify.eval.ts`).
5. **Standing instructions:** wire capture (boss tool) + consumption (classify observation + enforcement carve-out) + `/settings` management. Storage module already exists; ADR-0067 adds user-correction observations as the authoritative write source.
6. **Read-only recategorize dry-run** (`dry-run-triage-recategorize-committed.js`) over the ADR-0067 projection → review the old→new transition matrix, top offenders, and false-demotion samples.
7. **Commit one re-categorization** (`backfill-triage-committed.js --commit`) with full context + clean graph + new rubric, re-stamping significance bands exactly once.
8. **Verify against prod** (read-only): `urgent`+`action_needed` share drops for routine/cold/broadcast noise, real-stake items stay high, distribution aliases are absent from person rankings, role-relevant broadcasts correctly escalate.

## Success metric

Not "% tagged urgent/action_needed" alone — it's **`action_needed`/`urgent` becoming trustworthy**: routine/cold/broadcast actionable noise lands in `fyi`, while real-stake and role-relevant items stay high. Corroborate against the user's own re-tag corrections (`rejected_inferences`, ADR-0056) trending toward zero.

## ADR / issue cross-refs

- **ADR-0066** (new) — this rewrite. **Amends ADR-0048** (immutable honest category → significance-weighted, security floor retained), **ADR-0059** (reverses "significance never demotes category"), **ADR-0060** (standing-instruction capture/consumption now built + extended to the category).
- **ADR-0064 / #210** — the separate attention axis is subsumed into the category (recurrence-decay may remain a presentation nicety).
- **ADR-0051** — the deterministic-context philosophy this extends (envelope + "You" block are new observations).
- **ADR-0056/0057** — the confidence-gated capture + significance scalar the auto-update loop reuses.
- **#218** — the user-model spine epic this is the core of; **#211** (self-ingestion) already shipped; rule 8a (PR #252) is the first slice.
