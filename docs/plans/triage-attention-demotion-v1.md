# Triage attention-demotion — v1 (#210, epic #218 Tier 2)

Fixes #210: triage over-tags attention (urgent + action_needed ≈ 26% of inbox; suggested-todo acceptance ≈ 1%). The diagnosis is structural, not a rubric tune — the classifier decides demand from message **shape**, blind to the user's standing relative to the sender and to recurrence. Folds in **#230** (briefing calls busy days "quiet") — the inverse symptom of the same "presentation doesn't reflect reality" root.

## The load-bearing invariant (do not violate)

**The stored `email_triage.category` is never written by this work.** Triage labels are immutable (ADR-0048); the model never bends the category (ADR-0059 alt-e rejected significance-demotion of the category; ADR-0060 m4 — only an explicit `force_category` user instruction may re-stamp, logged). A cold LinkedIn ask genuinely *is* `awaiting_reply`; that is the honest label.

"Demanding-ness" is therefore a **presentation/ranking property** of the **briefing lane** and the **inbox-rail badge** — computed at the consumer, derived from signals we already have, leaving the category honest. This plan touches gather, compose, the rail render, and one additive synced field — never the classifier's category decision.

## The signal: a presentation-layer attention score

One pure function, `attentionScore(inputs) → { score: [0,1], band }`, living in `@alfred/contracts` (web-safe, zero Node deps — same home as the briefing contract). Three read-only inputs, all already derivable:

1. **Category base demand** — intrinsic weight per honest category (`urgent` > `action_needed` > `awaiting_reply` > `follow_up`/`meeting`/`payment`). This is the floor; significance and recurrence only move an item *within* and *down* from it, never up past the security floor.
2. **Sender significance** — the precomputed scalar on the sender's `person` entity (`meta.significance.score`, ADR-0057/0059), bucketed the same way the resolver buckets it (`STRONG_AT 0.66` / `MODERATE_AT 0.33`). **Degrades to neutral** when the sender is unscored / non-human / has no graph row — exactly today's intrinsic-only behavior, safe by construction. The graph is live (populated by the `memory-extraction` workflow's `runSignificancePass` + the P4a backfill).
3. **Recurrence decay** — a recurring machine notification is *less* demanding each repeat (the CloudWatch `ALARM:` tagged urgent 10×). A windowed, cross-row property: group by `(sender, normalizedSubject)`; the Nth repeat decays. Subject normalization (strip `ALARM:`/`Re:`/digits/dates) is a shared contracts util. **Principle, not exemplar** — the rule is "recurring + bot-shaped sender decays," never a CloudWatch string match.

Continuous score internally; projected to 3 bands `{ demanding | normal | muted }` for display (two cutoffs = the only tunable knobs, mirroring ADR-0059's word-bucketing precedent).

## Scope (in)

- **`@alfred/contracts`**: `attentionScore()` pure fn + `normalizeSubjectForRecurrence()` util + `AttentionBand` type + the category-base-demand table (`as const satisfies Record<TriageCategory, number>`). Unit-tested (pure, deterministic — the cheap-to-cover surface).
- **`@alfred/api` memory**: factor a `getSenderSignificance(userId, email) → { score, sameOrg } | null` out of the read path `resolveSenderRelationship` already uses (entity lookup by alias → `parsePersonEntityMetadata`). One shared significance read, no recompute.
- **Briefing gather** (`gather.ts`): after the existing GitHub loop-reconciliation, score every priority item; split the priority set into a **demanding lane** (band ≥ demanding, capped) and an **ambient tail** (the rest — low-significance cold asks, recurring machine noise). Both carry their honest category unchanged. Extend `BriefingDigest`/`BriefingGather` with the lane split + per-item band (additive contract fields).
- **Briefing compose** (`compose.ts` + prompt): lead with the demanding lane; render the ambient tail as a terse "also happening" line, not per-item demands. **Drive off the band, do not re-judge in prose** (repo norm: principles over exemplars — no "if it looks like an alarm" prompt patch).
- **Day-shape (#230)**: a deterministic `dayShape` signal in gather off `objectStateStore.list(userId, "github", …)` + the existing `integration_activity` counts over the window → `{ activityVolume: busy|normal|quiet, shipped: {title,url}[] }`. Compose **never** characterizes a day as "quiet" when `activityVolume !== quiet`; evening renders a "what you shipped" recap from `resolved` objects (dovetails with the existing `closedLoops` recap).
- **Inbox rail** (`apps/web` `-preview-chat/inbox-feed.tsx`): order + visually de-emphasize by band. Significance isn't synced today → persist one **additive** synced field `senderSignificanceBand` on the triage row at classify time (classify already calls `resolveSenderRelationship`; stash the scalar's band). Recurrence is computed **client-side** by grouping the already-synced rows (the rail renders the full list) through the shared `normalizeSubjectForRecurrence` + `attentionScore`. Badge still shows the honest category; muted band just dims the row.

## Scope (out / parked)

- **No category mutation, no `force_category` work** — that's ADR-0060 standing-instructions, a separate slice.
- **Behavioral priors** (dismiss:done 41:1, archive-without-reply — ADR-0055 Loop-2) as a 4th attention input — north star, deferred. v1 inputs are category + significance + recurrence only.
- **Recurrence beyond the gather/synced window** (a persisted recurrence counter) — v1 is window-local; revisit if window-local under-counts.
- **Significance-weighting of the *todo* mint** — already shipped via rubric 16b (ADR-0059); untouched here.
- **Drift metrics dashboard** (#219) — out of scope, but this plan's success metric (below) is the first number it should track.

## Build order

0. **ADR-0064 written** (decisions.md) — presentation-layer attention scoring: honest-category invariant, scorer inputs/bands/recurrence-decay, day-shape signal, success-metric reframe. Codification of the locked #218 + ADR-0048/0057/0059/0060 decisions, not a new grill. ✅
1. **Contracts**: `attentionScore` + `normalizeSubjectForRecurrence` + base-demand table + `AttentionBand` + unit tests. No consumers yet. ✅
2. **Phase A (no graph dependency — ship first, lowest risk):** recurrence-decay + day-shape in gather/compose. Buys the CloudWatch-10× and busy-day-quiet wins with zero reliance on the significance graph. ✅
   - **Architecture-drift correction (verified against code, not the plan):** `compose.ts` (`composeBriefing`/`composeInboxBriefing`) is **dead** — its only caller is `morning-briefing`, a registered-but-never-scheduled workflow (`next_run_at` null). The **live** prose path is `runBriefingAgent` (tool-driven), which selects items from `listEmailsSinceWatermark`. So Phase A landed where the wins are actually visible: a per-item `attentionBand` on `EmailListItem` (computed cross-row via the shared scorer, mirroring `previouslySurfaced`), a `day_shape` field on `BriefingGather` + a `get_day_shape` agent tool, and principle-based prompt rules ("trust the band; never call a busy day quiet"). The deterministic `gather` still carries `day_shape` for the in-app surface + suppression gate.
   - New shared contracts: `isLikelyBulkSender(from)` (conservative envelope heuristic — the recurrence gate; ambiguous role mailboxes deliberately excluded) and `scoreAttentionForItems(items)` (windowed cross-row recurrence pass; the single scoring entry point the agent read path and the Phase-C rail both call).
   - **Bulk-sender detection caveat for Phase B/C:** the honest signal is the classifier's `SenderContext` (`effectiveAuthor`/`botSlug`, via `senderKeyFor`), which isn't on the read paths. Phase A uses an address heuristic; if it under-catches in prod, thread the real signal through rather than widening the regex.
3. `getSenderSignificance` helper in `@alfred/api` memory. ✅
   - Shipped as `getSenderSignificance(userId, address) → { score, band, sameOrg } | null` in `memory/significance.ts`, over a new shared `findPersonMetadataByAddress` alias lookup. `resolveSenderRelationship` was refactored onto the same lookup (the plan's "factor out" intent — one alias→metadata read path for both the resolver prose and the significance read). Null on no-row / unscored / DB blip → neutral.
4. **Phase B:** significance-weighting layered into the same scorer + prompt reframe. ✅
   - **Same architecture-drift correction as Phase A:** landed in the *live* path, not dead `compose.ts`. `listEmailsSinceWatermark` now fetches each distinct sender's band via `getSenderSignificance` (deduped, one read per address) and threads `significanceBand` into `scoreAttentionForItems`, so a low-significance cold sender drops within its honest category. The prompt's "Trust the attentionBand" section was widened to explain the band now folds in *both* recurrence and significance (principle-based, no exemplars) and to treat the band as a lane (lead demanding, let muted fall away). No `BriefingGather` lane-split field added — nothing renders it (compose is dead); the band on `EmailListItem` is the lane.
5. **Phase C:** `senderSignificanceBand` synced field + rail ordering/de-emphasis. ✅
   - Migration `0044_petite_punisher.sql` (additive nullable column, db:generate → db:migrate locally — never push). Chain: db schema → `UpsertTriageArgs`/`rowToTriage`/insert+update in `store.ts` → workflow stashes `getSenderSignificance(...).band` at classify → sync `triageTagSharedSchema` (`.nullable().default(null)`, additive for already-synced clients) → server serializer `shared` → both override mutators preserve it (sender property, not classification). Rail: `InboxItem.attentionBand`, computed across the visible page in `overlayTriageTags` via the shared `scoreAttentionForItems` (band = category × tag.senderSignificanceBand × cross-row recurrence), then stable-sorted demanding→normal→muted; `InboxRow` dims `muted` rows (hover/focus restores). Honest category chip unchanged throughout.
   - **Rail-recurrence caveat:** recurrence is grouped over the **server page** the rail fetched, not the full inbox (server-paginated). v1 accepts page-local recurrence; revisit if a recurring blast spans pages.
   - **Staleness caveat:** the synced band is stamped at the thread's last classify, not on every significance pass — a sender scored *after* their last classify shows neutral until the thread re-classifies. Accepted (the plan's "stash the scalar's band").
6. **Verify against prod** (read-only recon, prod DB is source of truth): re-run the category/lane distribution; confirm the demanding-lane share drops while category counts stay honest. ⬜ pending deploy + backfill (new senders get a band only on next classify).

## Success metric (the #210 reframe)

The metric is **NOT** "% of inbox tagged urgent/action_needed" — those category counts *should not move* (honest categories). It is **"% of inbox surfaced in the demanding lane / dimmed-vs-bright in the rail."** Target: demanding-lane share well below today's 26%, with the recurring-machine and cold-low-significance items landing in the ambient tail. Corroborate against suggested-todo acceptance over the following window.

## Open (decide during build)

- **Base-demand weights + the two band cutoffs** — seed by judgment, tune from the prod distribution (shared tuning surface with ADR-0057/0059 weights).
- **Recurrence window/lookback** — window-local first; measure whether the 10× alarm spans windows and needs a short lookback query.
- **Ambient-tail floor** — does `urgent` ever land in the ambient tail (e.g. a recurring alarm), or does the security/`urgent` floor pin it to at least `normal`? Lean: recurrence may demote `urgent`→`normal` but never below; an exposed-secret `urgent` (override floor) is pinned demanding.
- **Eval coverage** — add an attention-scoring case to the `@alfred/api` evalite lane (deterministic scorer, schema-only) once the formula stabilizes.

## ADR / issue cross-refs

- **ADR-0048** — immutable triage labels; compose-time read-only reconciliation (the lane split is a render property, not a re-tag).
- **ADR-0057/0059** — the significance scalar this consumes; "score stays scalar, edge lives where consumed" — this is a second consumer of the scalar (presentation), parallel to the todo-rubric consumer.
- **ADR-0060 m4** — only explicit user authority bends the category; the model (and this presentation layer) never does.
- **ADR-0062** — the object-state projection the day-shape signal reads.
- **#218** — epic spine (Tier 2 = this); **#230** — folded in (day-shape); **#219** — drift-metric consumer of the success metric.
