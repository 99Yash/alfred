# Email triage (m9)

Per ADR-0025 #1 alfred classifies every newly-ingested Gmail message into one of ten categories: `urgent`, `action_needed`, `follow_up`, `awaiting_reply`, `meeting`, `fyi`, `done`, `payment`, `newsletter`, `marketing`. Each category maps to an `Alfred/<Name>` Gmail label that gets written back to the message.

The pipeline:

1. A Gmail ingestion job inserts a fresh `documents` row. The realtime path is `gmail.poll_recent` (pub/sub → `messages.list?q=newer_than:5m`, ADR-0037); the catch-up path is `gmail.poll_history` (5-min sweep → `history.list` from the stored cursor). Both call into the same `persistMessage` helper so dedup behaves identically.
2. The Gmail ingestion job publishes an ingested-documents fact for the freshly-inserted docs, and independent consumers fan out from it (`packages/assistant/src/runtime/adapters/gmail-ingested-consumers.ts`) — corpus embedding, user-model capture, the inbox rail, and triage. The triage consumer skips back-catalog triage on bulk re-ingest / `fullResync`. m13 replaced the earlier inline triage enqueue in the ingestion queue, and ADR-0047 owns the event dispatch that starts the run.
3. The `email-triage` workflow (`packages/assistant/src/triage/email-triage.ts`) declares **two** steps, `classify` and `apply-label`. `classify` runs `extractSenderContext` (deterministic parser) → the context-rich cheap-tier LLM via `@alfred/ai`'s `metered.object()`, fed deterministic observations → an optional second cheap pass on tightly-gated conflicts → `applyFloors`. Those four are in-step calls, not steps of their own. `apply-label` then writes the label (`messages.modify` through the shared `reconcileThreadLabel` writer). There is no routine boss `deepen` path in triage v3.
4. Result lands in `email_triage` (one row per thread, keyed by `(user_id, source_thread_id)`); the chosen `Alfred/`\* label id is persisted on `applied_label_id`.

Initial-sync seed: the OAuth callback (`google-routes.ts /callback`) enqueues a `gmail.ingest_recent` job with `maxMessages: 8, triageInsertedDocs: true` so a brand-new account has classified mail to look at immediately. The flag is the opt-in that narrows ADR-0025's "no triage on bulk re-ingest" rule — only callers that explicitly request triage get it. Re-connect is idempotent (dedup index → 0 inserts → 0 triage runs).

**One row per thread.** `email_triage`'s PK is `(user_id, source_thread_id)`. Every new message in a thread re-runs the classifier and _overwrites_ the row — the canonical alfred tag is always the latest message's outcome. `email_triage.document_id` is a soft pointer (no FK) to the latest classified Gmail message in the thread; it survives the underlying document being purged.

**Thread-level label collapse.** Gmail's thread view unions labels across every message in a thread, so an older `fyi`/`follow_up` message left next to a newer `done` reply would show both tags. The `apply-label` step fetches the thread from Gmail (`findThreadSiblingsWithAlfredLabels` → `threads.get` in `minimal` format) and strips every alfred label from every sibling message before applying the new one to the latest message. Source of truth for siblings is Gmail itself, not the DB — that self-heals across stale hand-labelling or older deployments.

Label management (`packages/integrations/src/google/labels.ts`):

- `ensureAlfredLabels(credentialId)` idempotently creates the ten labels and caches the id map on `integration_credentials.metadata.alfredLabels`. Pass `force: true` to rebuild if a label was deleted out-of-band.
- `applyTriageLabel({ credentialId, messageId, category, previousLabelId, threadSiblings })` adds the chosen label, removes the previous one on the same message, and (when `threadSiblings` is supplied) strips each sibling's alfred label so the thread collapses to a single tag.

**Classifier rubric.** The per-category rules live in `SYSTEM_PROMPT` in `packages/assistant/src/triage/classify.ts`, the only source of truth the live pipeline reads. One stale copy survives: `DEEPEN_SYSTEM_PROMPT` (`packages/assistant/src/triage/deepen.ts`) restates the ten-category taxonomy and several per-category rules, but nothing calls `deepenTriageClassification`, so that module is dead code rather than a second live source. They are deliberately not restated here: the rubric is the behavior, so a prose copy competes with the prompt the model actually sees and the copy always loses. Read the prompt.

Sender/observation flow — what each stage is *for*, since the call graph already says what it does:

- `extractSenderContext` emits typed sender context so the model never parses service envelopes out of prose. Envelope parsing in the prompt was the original misclassification source.
- `assembleObservations` hands the cheap classifier deterministic context (sender priors, account persona, thread state, known-contact flag, Gmail-native signals, content flags). The design bet of triage v3: spend determinism, not model tier.
- `detectConflict` buys exactly one more cheap pass, and only when the output contradicts a strong deterministic expectation. It is a tightly-gated second look, not a retry loop.
- `applyFloors` folds `FLOOR_SEQUENCE` (`override` → `senderKind` → `meeting`) over the classification, each floor seeing the previous one's output and contributing its own audit facts. **Order is load-bearing and its rationale lives on the sequence itself** — read it there rather than trusting a list here. Floors exist because a demotion must be recoverable noise, never a burial: they demote, they never re-stamp a category the user could have acted on.
- `agent_decision_traces` stores a `triage.classification` row per run so tuning happens from observed misses in SQL rather than transient progress logs. This is why classifier changes are verified by trajectory diff, not by re-reading the prompt.
- The dormant `deepen`/dossier hooks remain in code for future non-triage work, but triage v3 does not call them.

Smokes:

- From `apps/server`, `pnpm exec tsx --env-file=.env src/scripts/smokes/smoke-triage.ts` exercises the Gmail-backed end-to-end workflow and requires a connected Google account plus at least one ingested email.
