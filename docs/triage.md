# Email triage (m9)

Per ADR-0025 #1 alfred classifies every newly-ingested Gmail message into one of six categories: `action_needed`, `awaiting_reply`, `meeting`, `fyi`, `payment`, `newsletter`. Each category maps to an `Alfred/<Name>` Gmail label that gets written back to the message.

The pipeline:

1. `gmail.poll_history` (BullMQ) inserts a fresh `documents` row.
2. `packages/api/src/modules/integrations/queue.ts` enqueues an `email-triage` agent run per inserted doc (skipped on bulk re-ingest / `fullResync`).
3. The `email-triage` workflow (in `apps/server/src/builtins/workflows/email-triage.ts`) runs `classify` (cheap-tier LLM via `@alfred/ai`'s `metered.object()`) → `apply-label` (`messages.modify`).
4. Result lands in `email_triage` (one row per document; PK = `document_id`); the chosen `Alfred/`\* label id is persisted on `applied_label_id`.

Initial-sync seed: the OAuth callback (`google-routes.ts /callback`) enqueues a `gmail.ingest_recent` job with `maxMessages: 8, triageInsertedDocs: true` so a brand-new account has classified mail to look at immediately. The flag is the opt-in that narrows ADR-0025's "no triage on bulk re-ingest" rule — only callers that explicitly request triage get it. Re-connect is idempotent (dedup index → 0 inserts → 0 triage runs).

Re-classification on reply happens implicitly: every new message in a thread is its own document and gets its own triage run. We never sweep the whole thread for re-classification — only the just-arrived message gets a fresh LLM call.

**Thread-level label collapse.** Gmail's thread view unions labels across every message in a thread, so an older `fyi`/`follow_up` message left next to a newer `done` reply ends up showing both tags. The `apply-label` step queries sibling messages in the same thread (`getThreadSiblingsWithLabels`) and strips their alfred labels before applying the new one — the latest classification wins. Sibling triage rows keep their `category` for audit but have `applied_label_id` cleared.

Label management (`packages/integrations/src/google/labels.ts`):

- `ensureAlfredLabels(credentialId)` idempotently creates the ten labels and caches the id map on `integration_credentials.metadata.alfredLabels`. Pass `force: true` to rebuild if a label was deleted out-of-band.
- `applyTriageLabel({ credentialId, messageId, category, previousLabelId, threadSiblings })` adds the chosen label, removes the previous one on the same message, and (when `threadSiblings` is supplied) strips each sibling's alfred label so the thread collapses to a single tag.

Smoke: `pnpm --filter server tsx --env-file=.env src/scripts/smoke-triage.ts` (requires a connected Google account + at least one ingested email).

Backfill: `pnpm --filter server tsx --env-file=.env src/scripts/backfill-thread-labels.ts [--dry-run]` — one-shot cleanup for threads that accumulated multiple alfred labels under the old per-message-only behavior. Keeps the latest message's label, strips the rest. Idempotent.
