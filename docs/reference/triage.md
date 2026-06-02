# Email triage (m9)

Per ADR-0025 #1 alfred classifies every newly-ingested Gmail message into one of six categories: `action_needed`, `awaiting_reply`, `meeting`, `fyi`, `payment`, `newsletter`. Each category maps to an `Alfred/<Name>` Gmail label that gets written back to the message.

The pipeline:

1. A Gmail ingestion job inserts a fresh `documents` row. The realtime path is `gmail.poll_recent` (pub/sub → `messages.list?q=newer_than:5m`, ADR-0037); the catch-up path is `gmail.poll_history` (5-min sweep → `history.list` from the stored cursor). Both call into the same `persistMessage` helper so dedup behaves identically.
2. `packages/api/src/modules/integrations/queue.ts` enqueues an `email-triage` agent run per inserted doc (skipped on bulk re-ingest / `fullResync`). The realtime case enqueues triage *before* awaiting embedding so the classifier worker overlaps with Voyage.
3. The `email-triage` workflow (in `apps/server/src/builtins/workflows/email-triage.ts`) runs `classify` (cheap-tier LLM via `@alfred/ai`'s `metered.object()`) → `apply-label` (`messages.modify`).
4. Result lands in `email_triage` (one row per document; PK = `document_id`); the chosen `Alfred/`\* label id is persisted on `applied_label_id`.

Initial-sync seed: the OAuth callback (`google-routes.ts /callback`) enqueues a `gmail.ingest_recent` job with `maxMessages: 8, triageInsertedDocs: true` so a brand-new account has classified mail to look at immediately. The flag is the opt-in that narrows ADR-0025's "no triage on bulk re-ingest" rule — only callers that explicitly request triage get it. Re-connect is idempotent (dedup index → 0 inserts → 0 triage runs).

**One row per thread.** `email_triage`'s PK is `(user_id, source_thread_id)`. Every new message in a thread re-runs the classifier and *overwrites* the row — the canonical alfred tag is always the latest message's outcome. `email_triage.document_id` is a soft pointer (no FK) to the latest classified Gmail message in the thread; it survives the underlying document being purged.

**Thread-level label collapse.** Gmail's thread view unions labels across every message in a thread, so an older `fyi`/`follow_up` message left next to a newer `done` reply would show both tags. The `apply-label` step fetches the thread from Gmail (`findThreadSiblingsWithAlfredLabels` → `threads.get` in `minimal` format) and strips every alfred label from every sibling message before applying the new one to the latest message. Source of truth for siblings is Gmail itself, not the DB — that self-heals across stale hand-labelling or older deployments.

Label management (`packages/integrations/src/google/labels.ts`):

- `ensureAlfredLabels(credentialId)` idempotently creates the ten labels and caches the id map on `integration_credentials.metadata.alfredLabels`. Pass `force: true` to rebuild if a label was deleted out-of-band.
- `applyTriageLabel({ credentialId, messageId, category, previousLabelId, threadSiblings })` adds the chosen label, removes the previous one on the same message, and (when `threadSiblings` is supplied) strips each sibling's alfred label so the thread collapses to a single tag.

Smoke: `pnpm --filter server tsx --env-file=.env src/scripts/smoke-triage.ts` (requires a connected Google account + at least one ingested email).
