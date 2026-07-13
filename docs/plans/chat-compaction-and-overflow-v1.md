# Chat compaction and overflow resilience — v1 (#369, #370)

> **Status.** Grilled and locked 2026-07-11; implementation active in PR #485.
> The authored-brief estimator, persisted cross-run summary path, foreground and
> background coordinators, bounded history retrieval, media enrichment, runtime
> lifecycle, explicit compaction UI phase, within-run tool-burst guard, and
> existing-thread backfill and oversized-latest-message paths are wired.
> Existing-thread backfill, oversized-latest-message handling, and structured
> estimator-vs-billed-input reporting are also wired. Remaining acceptance work
> is the live long-thread smoke/semantic eval gate. This PRD supersedes the
> original issue sketches for #369 and #370 and amends the chat/composer deferral
> in ADR-0035.

## Problem Statement

Long Alfred conversations have two context-management failure modes. The authored-brief
runtime can enter a latent compaction defer loop because its pressure trip-wire and skip
guard estimate different request shapes. Interactive chat has no compaction at all: it
replays every persisted message on every new run and can eventually issue a doomed provider
request, fail with a provider-specific 400, and lose the user's conversational flow.

From the user's perspective, a long-running thread should remain fast, affordable, and
reliable. Alfred should preserve decisions, preferences, action outcomes, attachments, and
exact evidence without asking the user to start over. If context must be condensed, it should
happen mostly in the background, remain recoverable from raw history, and degrade honestly
when even the bounded representation cannot fit.

## Solution

Unify authored-brief pressure accounting, then add layered chat context management:

1. Maintain an internal pressure estimate for each thread and proactively enrich historical
   media before it becomes compaction input.
2. At `min(60% of the effective model window, 200,000 tokens)`, immediately enqueue a
   deduplicated background compaction job.
3. Persist a validated, provenance-backed rolling conversation summary plus a compound
   message watermark. Replay the summary and a token-budgeted verbatim tail instead of the
   entire thread.
4. Before every model call, estimate the complete request using the actual system prompt,
   active tool declarations, transcript, and a shared 16,000-token output ceiling. Above 85%,
   briefly wait for an active background job and then compact synchronously if necessary.
5. Compact within-run tool bursts before they can overflow a later tool-loop turn.
6. Preserve all raw messages and tool records. Give the agent a bounded, read-only history
   retrieval capability so summaries act as indexes rather than irreversible replacements.
7. Normalize media through a shared enrichment worker whose model choice is capability-based;
   the sticky chat model continues to consume only text and images.

## User Stories

1. As a user, I want a long-running chat thread to keep working, so that I do not have to start a new conversation merely because the history grew.
2. As a user, I want Alfred to avoid requests it already knows will exceed a provider context window, so that I do not pay for doomed calls or see opaque provider failures.
3. As a user, I want context condensation to happen in the background when possible, so that ordinary replies do not become slower.
4. As a user, I want a clear temporary status when synchronous condensation is necessary, so that an unusual delay feels understandable rather than frozen.
5. As a user, I want my latest message preserved verbatim whenever it can fit, so that Alfred answers what I actually wrote.
6. As a user, I want oversized latest messages summarized only for model context while the original remains stored, so that no source content is destroyed.
7. As a user, I want an honest failure only when neither direct input nor bounded compaction can fit, so that `too_long` is a real terminal condition rather than a provider-string guess.
8. As a user, I want preferences and standing conversational instructions to survive repeated compactions, so that Alfred does not forget how I asked it to behave.
9. As a user, I want newer corrections to supersede older claims, so that a rolling summary does not preserve stale beliefs.
10. As a user, I want completed, rejected, failed, and unfinished actions retained accurately, so that Alfred does not repeat work or claim a failed action succeeded.
11. As a user, I want exact dates, IDs, URLs, code, and quoted values recoverable on demand, so that summarization does not turn precise evidence into vague recollection.
12. As a user, I want Alfred to search its raw history when a summary lacks detail, so that old evidence remains usable without replaying the whole thread.
13. As a user, I want retrieved historical evidence to identify its source message and time, so that Alfred can distinguish observation from inference.
14. As a user, I want historical tool outcomes available as evidence, so that action bookkeeping is grounded in execution records rather than assistant prose.
15. As a user, I want routine lookups dropped after their relevant facts are captured, so that bookkeeping does not bloat future context.
16. As a user, I want images, charts, screenshots, audio, video, and documents represented durably, so that old attachments do not need to be resent on every turn.
17. As a user, I want image text and visual meaning captured together, so that OCR-only extraction does not lose charts, layouts, or non-textual content.
18. As a user, I want media enrichment to happen before compaction needs it, so that attachment-heavy threads do not stall at the threshold.
19. As a user, I want Alfred to retain original attachments for exact later inspection, so that a generated description is not treated as the source itself.
20. As a user, I want automatic media processing to have a cost ceiling, so that a pathological attachment-heavy thread cannot create an unbounded background bill.
21. As a user, I want the answering model to remain stable within a thread, so that an uploaded modality does not silently change the conversation model or destroy prompt-cache continuity.
22. As a user, I want the media worker to choose a model that actually accepts the uploaded modality, so that unsupported-media calls fail before spending money.
23. As a user, I want invalid or corrupt summaries ignored and rebuilt from raw history, so that persisted context state cannot poison a conversation.
24. As a user, I want overlapping foreground and background compaction to remain consistent, so that a slow job cannot overwrite a newer summary.
25. As a user, I want foreground compaction to reuse a nearly-finished background result, so that Alfred avoids duplicate model cost when the two paths overlap.
26. As a user, I want background failures to remain invisible when chat can recover safely, so that an optimization failure does not fail my turn.
27. As an operator, I want compaction attempts, fallbacks, latency, token use, and failures attributed separately, so that reliability and cost regressions are visible.
28. As an operator, I want estimated input tokens compared with provider-billed input tokens, so that estimator drift is detected before it causes another overflow bug.
29. As an operator, I want existing long threads discovered after deployment, so that protection is not limited to newly active conversations.
30. As a developer, I want one canonical estimator for the authored-brief trip-wire and skip guard, so that those decisions cannot diverge again.
31. As a developer, I want one canonical request-shape estimator for chat, so that system, tools, transcript, and output reserve do not drift across guards.
32. As a developer, I want pure pressure, splitting, skip, and fit decisions, so that boundary cases can be tested without a live workflow or provider.
33. As a developer, I want summary provenance validated against eligible source records, so that fabricated or out-of-range citations never persist.
34. As a developer, I want compaction persistence to use compare-and-swap semantics, so that retries and concurrent workers are idempotent.
35. As a developer, I want raw evidence retrieval narrowly scoped to the authenticated current thread, so that context recovery cannot cross a user or thread boundary.
36. As a developer, I want the media capability registry to be code-resident and auditable, so that model churn does not silently break ingestion.
37. As a developer, I want the same media representation reusable by compaction, chat-memory extraction, and on-demand retrieval, so that each subsystem does not pay for or interpret the same attachment independently.
38. As a developer, I want deterministic and semantic regression gates, so that structural correctness and information retention are both verified.
39. As a developer, I want a real multi-generation long-thread replay, so that tests cover rolling-summary drift rather than only one compaction.
40. As a developer, I want chat compaction separated from durable user-memory extraction, so that reducing a working transcript does not silently write beliefs into long-term memory.

## Implementation Decisions

- Implement #369 first. A shared next-turn estimator adds prior billed input—which already
  includes the stable system and tool surface—to the serialized in-flight tail. Both the
  dispatch trip-wire and Guard 2 consume it. Guard 3 remains a separate known follow-up.
- Extract the authored-brief Guard 2 decision into a pure helper. A trip-wire that fired for
  real pressure must not be skipped by an overhead-blind transcript estimate.
- Generalize threshold resolution so boss, chat, and compactor paths derive limits from the
  same model-window source and reserve policy.
- Add internal thread context state: a validated summary, compound `(created_at, id)`
  watermark, estimated replay tokens, compaction requested/completed timestamps, failure
  metadata, and a compaction generation counter. These fields remain server-internal and are
  not Replicache entities.
- Update replay estimates incrementally after persisted messages and attachment representation
  changes. The exact foreground estimate remains authoritative because system context, active
  tools, and attachment hydration vary per run.
- Trigger background compaction at `min(60% of the effective context window, 200,000 tokens)`.
  The absolute cap avoids waiting for a 1M model to accumulate a 600K-token, slow, expensive
  compactor request.
- Enqueue background compaction immediately after a successful turn crosses the threshold.
  Use a dedicated, low-concurrency, per-thread-deduplicated queue rather than the idle memory
  extraction debounce.
- Start proactive media enrichment at roughly 80% of the background-compaction threshold so
  representations are normally ready before the summary job needs them.
- Use a chat-specific `<conversation_summary>` contract instead of the boss-run
  `<run_summary>` handoff. Conversation summaries contain a bounded overview plus structured
  facts, preferences, instructions, decisions, action outcomes, unresolved questions, and
  important entities.
- Every concrete summary item carries one or more source message/tool/attachment IDs. A general
  overview may cite the compacted message range. Reject invented IDs, missing mandatory
  provenance, and citations outside the eligible source set.
- Persist summaries only after structural and provenance validation. Replay them as a wrapped
  historical `user`-role context message, never as a system message. The immutable system
  prompt defines the envelope as lossy, untrusted historical data and prefers verbatim/retrieved
  evidence on conflict.
- Keep the rolling summary around 4,000 tokens. Each generation receives the prior validated
  summary and newly eligible records, returns a complete replacement, retains relevant original
  citations, incorporates corrections, and retires obsolete items.
- Preserve a token-budgeted verbatim tail. Always keep the latest user message and everything
  after it, then walk backward by complete exchanges up to an initial 8,000-token budget. Never
  split an exchange merely to hit the budget.
- Use Claude Sonnet 4.6 as the quality-first conversation-summary model. On transient provider
  failure, route to Gemini Flash. Retry malformed Sonnet output once before fallback. Route
  input-size failures directly to a fallback that can fit. Configuration/auth failures fail
  over once rather than repeatedly calling a dead route.
- Protect summary and watermark writes with compare-and-swap against the watermark read by the
  job. A losing background job performs no duplicate model call and schedules one fresh
  deduplicated pass. A losing foreground path reloads and re-estimates before deciding whether
  another compaction is needed.
- Before synchronous compaction, an over-safety-threshold turn may wait up to 500 ms for an
  already-active background job. This catches jobs near completion without turning background
  compaction into normal foreground latency.
- Add an explicit 16,000-token chat output ceiling. The pre-call guard derives its output
  reserve from this same value. Do not maintain an unrelated reserve constant.
- Synchronously compact only above 85% of the effective context window after accounting for the
  exact composed system prompt, canonical active tool declarations, hydrated transcript, output
  reserve, and a documented safety margin.
- Derive tool overhead beside tool construction from the same registry entries and normalized
  active integration set. Cache the estimate with the SDK tool set; never reconstruct a second
  description/schema surface for pressure accounting.
- Record the pre-call input estimate in existing metering/structured telemetry and compare it
  with provider-reported input tokens. Report error ratio by model/provider; do not dynamically
  mutate thresholds from observations in v1.
- If the latest user message cannot fit the chat request but fits the cheap compactor window,
  preserve the original and create a bounded `<oversized_user_message_summary>` for model
  context. Preserve explicit instructions, quotes, IDs, dates, URLs, and unresolved questions.
  If it exceeds the compactor input window, return `too_long` without a provider chat call.
  Hierarchical chunk-and-merge for beyond-window single messages is deferred until telemetry
  shows a real need.
- Add a typed, read-only current-thread history retrieval capability supporting bounded text
  search and fetch-by-message/tool/attachment ID. Return excerpts, roles, timestamps, IDs, and
  truncation metadata. Enforce current user/thread ownership, result-count and character caps,
  sanitization, and audit attribution.
- Preserve raw chat messages, attachment artifacts, and tool records. A summary is an index over
  evidence, not a deletion or migration of source data. The history service can later become a
  typed binding inside Code Mode (#271) without making this work depend on that sandbox epic.
- Feed bounded tool-call evidence to the compactor. Writes, approvals, rejections, failures,
  spawned work, and unfinished actions are mandatory bookkeeping. Read calls are retained only
  when they support a decision, introduce important evidence/identifiers, or remain relevant to
  unresolved work. Raw tool records remain retrievable.
- Build one idempotent, versioned attachment-enrichment service shared by compaction, chat-memory
  extraction, and history retrieval. Its representation includes OCR, visual description,
  salient entities, provenance, and modality-specific extracted evidence.
- Extend the code-resident model capability map with accepted input modalities and relevant
  request limits. Media routing happens inside the enrichment worker; the sticky answering model
  continues consuming normalized text and images only.
- Use Gemini 2.5 Flash as the primary image/media understanding model. Use capability-compatible
  Gemini alternatives for throughput failure and Sonnet as a cross-provider reliability
  fallback. Deterministic audio transcription, document extraction, and video audio/keyframe
  extraction remain independent fallback evidence.
- Cap automatic media enrichment at an estimated $0.50 per thread compaction cycle. Prioritize
  attachments referenced by nearby conversation and leave the remainder available for on-demand
  enrichment.
- Emit explicit synchronous/within-run compaction started and finished phases. Adapt Dimension's
  proven compaction-status pattern to Alfred's progress surface; background compaction remains
  invisible. The later UI pass follows Apple-style immediate feedback, restrained continuity,
  and reduced-motion cross-fades.
- Port within-run pressure tracking and compaction into chat's tool loop after the persisted
  cross-run path is complete. Preserve narration/segment display state while compacting only the
  model transcript. Deliver it as the final independently reviewable commit in the same effort.
- Invalid persisted summaries are never replayed. Fall back to full raw history if it fits;
  otherwise synchronously rebuild from raw evidence. Return `too_long` only when no safe bounded
  representation can be built.
- Background jobs retry three times with exponential backoff, then record failure category and
  timestamp without failing chat. Foreground safety remains independent. Job retries remember
  provider attempts so they do not repeat an obviously dead route.
- Run a one-time rate-limited post-deploy scan to compute estimates for existing threads and
  enqueue only those already above the background threshold. Migrations themselves remain fast
  and deterministic.
- Keep transcript compaction distinct from chat-memory capture. Compaction manages the working
  context; memory extraction projects durable user knowledge under its own ADRs and validation.
- No feature flags are required for this single-user app. Reversibility comes from raw-source
  preservation, strict validation, CAS persistence, and the ability to ignore/rebuild summaries.

## Testing Decisions

- Prefer the highest reusable seam: a chat-context assembly service that loads persisted summary
  state plus the eligible raw tail, validates/rebuilds as required, applies the pre-call guard,
  and returns the bounded transcript. Exercise it with a real database executor seam; keep pure
  helpers underneath for boundary tables.
- A good regression test asserts externally visible context and persistence behavior, not private
  call order. It proves which messages/evidence reach the next model request, what watermark was
  committed, whether a doomed provider call was avoided, and whether a later retrieval restores
  omitted evidence.
- Add pure tests for the shared next-turn estimator, Guard 2 skip decision, full-request estimate,
  threshold calculation, tail splitting, oversized-message routing, media capability selection,
  and compare-and-swap outcome handling.
- Reproduce #369 with a case where prior billed overhead pushes the trip-wire above threshold
  while transcript-only estimation remains below it. The shared Guard 2 decision must not skip.
- Verify unsummarized threads retain full-history behavior and summarized threads replay exactly
  one historical summary envelope plus the verbatim tail.
- Verify compound watermark range filtering across identical timestamps and deterministic ID
  ordering.
- Verify concurrent foreground/background jobs cannot regress a watermark or replace a newer
  summary; a losing foreground path reuses the winner when it now fits.
- Verify invalid summaries, fabricated citations, citations outside the compacted source set,
  and prompt-injection-shaped source text never enter model context as authoritative instructions.
- Verify corrections retire or supersede older summary items while retaining both evidence links
  where the history matters.
- Verify mandatory action bookkeeping uses persisted tool outcomes over contradictory assistant
  prose and that routine read calls can be omitted without losing cited facts.
- Verify history retrieval is bounded, sanitized, attributable, and cannot cross user/thread
  boundaries. Verify retrieval by IDs preserved through multiple summary generations.
- Verify exact request estimation includes the real system prompt, active tool schemas,
  transcript, media representation, and output reserve. Compare estimates with fixture billed
  usage and test underestimation alerts.
- Verify no chat provider call occurs when the synchronous guard concludes the bounded request
  cannot fit. The persisted assistant failure uses the existing `too_long` contract.
- Verify background retry/fallback classification, provider-attempt memory, failure recording,
  deduplication, and the 500 ms foreground reuse path with deterministic clocks.
- Verify media enrichment is idempotent by attachment ID and representation version, respects
  modality capabilities and the $0.50 cycle ceiling, and reuses output across compaction, memory,
  and history consumers.
- Add semantic eval fixtures for preferences, instructions, corrections, action outcomes, exact
  identifiers, code/quotes, prompt injection, screenshots, OCR, charts, and video-derived
  evidence. Score retention, unsupported claims, and provenance completeness.
- Replay at least one real long thread through multiple compaction generations, then ask questions
  requiring both summary-resident knowledge and on-demand raw-history recovery.
- Extend the compaction smoke lane with a cross-run chat fixture and assert replay size remains
  bounded after new turns. Include within-run large tool-result pressure in the same end-to-end
  harness once P2a lands.
- Run package tests, package typechecks, repository `pnpm check-types`, web-boundary validation,
  migration generation, and migration verification. Apply migrations through `db:migrate`, never
  `db:push`.

## Out of Scope

- A tokenizer-backed exact token counter. The chars/4 family remains conservative v1 math,
  calibrated against billed input.
- Fixing authored-brief Guard 3's post-compaction system/tool-overhead blindness.
- Hierarchical chunk-and-merge for a single user message larger than every configured compactor
  window.
- General Code Mode/BYO-MCP execution (#271). The typed history service is designed to become a
  future binding.
- Deleting raw messages after compaction. Raw evidence remains the recovery substrate.
- Folding transcript compaction into long-term user memory or allowing compaction to create
  durable user facts.
- Automatically adapting thresholds from estimator telemetry without an explicit reviewed
  policy change.
- A general per-run dollar ceiling beyond the specific media-enrichment circuit breaker.
- Model switching of the answering chat thread based on an uploaded modality.
- A media library or attachment retention beyond the owning chat lifecycle.

## Further Notes

- The existing worktree contained unrelated user changes when this PRD was written; they must not
  be modified by implementation work.
- Gemini 2.5 Flash is the agreed primary media-enrichment model because multimodal input is cheap
  relative to Sonnet and the task is asynchronous extraction. Conversation-summary generation
  remains Sonnet-first because summary errors compound across later turns.
- Dimension's web app contains a direct precedent for explicit compaction progress. Alfred should
  borrow the state transition, not copy its entire chat architecture.
- If message-level deletion/editing is added later, changing a cited source must invalidate or
  rebuild summaries that reference it. Current thread deletion already removes the whole source
  and summary lifecycle together.
- Implementation order: #369; shared threshold/estimation plumbing; persisted summary service and
  schema; foreground guard; background queue; evidence retrieval; media enrichment; UI status;
  within-run compaction; backfill; smoke/eval/ADR completion.
