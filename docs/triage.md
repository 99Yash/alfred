# Email triage (m9)

Per ADR-0025 #1 alfred classifies every newly-ingested Gmail message into one of six categories: `action_needed`, `awaiting_reply`, `meeting`, `fyi`, `payment`, `newsletter`. Each category maps to an `Alfred/<Name>` Gmail label that gets written back to the message.

The pipeline:

1. `gmail.poll_history` (BullMQ) inserts a fresh `documents` row.
2. `packages/api/src/modules/integrations/queue.ts` enqueues an `email-triage` agent run per inserted doc (skipped on bulk re-ingest / `fullResync`).
3. The `email-triage` workflow (in `apps/server/src/builtins/workflows/email-triage.ts`) runs `classify` (cheap-tier LLM via `@alfred/ai`'s `metered.object()`) → `apply-label` (`messages.modify`).
4. Result lands in `email_triage` (one row per document; PK = `document_id`); the chosen `Alfred/`\* label id is persisted on `applied_label_id`.

Initial-sync seed: the OAuth callback (`google-routes.ts /callback`) enqueues a `gmail.ingest_recent` job with `maxMessages: 8, triageInsertedDocs: true` so a brand-new account has classified mail to look at immediately. The flag is the opt-in that narrows ADR-0025's "no triage on bulk re-ingest" rule — only callers that explicitly request triage get it. Re-connect is idempotent (dedup index → 0 inserts → 0 triage runs).

Re-classification on reply happens implicitly: every new message in a thread is its own document and gets its own triage run. We never sweep the whole thread.

Label management (`packages/integrations/src/google/labels.ts`):

- `ensureAlfredLabels(credentialId)` idempotently creates the six labels and caches the id map on `integration_credentials.metadata.alfredLabels`. Pass `force: true` to rebuild if a label was deleted out-of-band.
- `applyTriageLabel({ credentialId, messageId, category, previousLabelId })` adds the chosen label and removes the previous one (when supplied) in a single Gmail round-trip.

Smoke: `pnpm --filter server tsx --env-file=.env src/scripts/smoke-triage.ts` (requires a connected Google account + at least one ingested email).
