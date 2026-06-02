# Email triage (m9)

Per ADR-0025 #1 alfred classifies every newly-ingested Gmail message into one of ten categories: `urgent`, `action_needed`, `follow_up`, `awaiting_reply`, `meeting`, `fyi`, `done`, `payment`, `newsletter`, `marketing`. Each category maps to an `Alfred/<Name>` Gmail label that gets written back to the message.

The pipeline:

1. A Gmail ingestion job inserts a fresh `documents` row. The realtime path is `gmail.poll_recent` (pub/sub → `messages.list?q=newer_than:5m`, ADR-0037); the catch-up path is `gmail.poll_history` (5-min sweep → `history.list` from the stored cursor). Both call into the same `persistMessage` helper so dedup behaves identically.
2. `packages/api/src/modules/integrations/queue.ts` enqueues an `email-triage` agent run per inserted doc (skipped on bulk re-ingest / `fullResync`). The realtime case enqueues triage _before_ awaiting embedding so the classifier worker overlaps with Voyage.
3. The `email-triage` workflow (in `apps/server/src/builtins/workflows/email-triage.ts`) runs `extract-sender-context` (deterministic parser) → `classify` (cheap-tier LLM via `@alfred/ai`'s `metered.object()`) → optional `deepen` (boss-tier structured refinement for live severity-suspect bot alerts only) → `apply-label` (`messages.modify`).
4. Result lands in `email_triage` (one row per thread, keyed by `(user_id, source_thread_id)`); the chosen `Alfred/`\* label id is persisted on `applied_label_id`.

Initial-sync seed: the OAuth callback (`google-routes.ts /callback`) enqueues a `gmail.ingest_recent` job with `maxMessages: 8, triageInsertedDocs: true` so a brand-new account has classified mail to look at immediately. The flag is the opt-in that narrows ADR-0025's "no triage on bulk re-ingest" rule — only callers that explicitly request triage get it. Re-connect is idempotent (dedup index → 0 inserts → 0 triage runs).

**One row per thread.** `email_triage`'s PK is `(user_id, source_thread_id)`. Every new message in a thread re-runs the classifier and _overwrites_ the row — the canonical alfred tag is always the latest message's outcome. `email_triage.document_id` is a soft pointer (no FK) to the latest classified Gmail message in the thread; it survives the underlying document being purged.

**Thread-level label collapse.** Gmail's thread view unions labels across every message in a thread, so an older `fyi`/`follow_up` message left next to a newer `done` reply would show both tags. The `apply-label` step fetches the thread from Gmail (`findThreadSiblingsWithAlfredLabels` → `threads.get` in `minimal` format) and strips every alfred label from every sibling message before applying the new one to the latest message. Source of truth for siblings is Gmail itself, not the DB — that self-heals across stale hand-labelling or older deployments.

Label management (`packages/integrations/src/google/labels.ts`):

- `ensureAlfredLabels(credentialId)` idempotently creates the ten labels and caches the id map on `integration_credentials.metadata.alfredLabels`. Pass `force: true` to rebuild if a label was deleted out-of-band.
- `applyTriageLabel({ credentialId, messageId, category, previousLabelId, threadSiblings })` adds the chosen label, removes the previous one on the same message, and (when `threadSiblings` is supplied) strips each sibling's alfred label so the thread collapses to a single tag.

Classifier guardrails:

- `meeting` is only for a personal/work calendar-style meeting the user is expected to attend, prepare for, schedule, reschedule, or answer availability for.
- Public events, product launches, webinars, conferences, keynotes, and bulk "save the date" blasts are `marketing`/`newsletter`/`fyi`, not `meeting`.
- Shareholder, AGM, annual report, proxy/e-voting, registrar/depository, and stock-market notices are usually `fyi`; use `action_needed` only when the email asks the user to vote, register, submit a form, or meet a concrete deadline.
- Review bots (`coderabbit`, Copilot review, GitHub Actions, Dependabot, Renovate) are advisory by default and usually land as `fyi`; they only become `action_needed`/`urgent` when the body shows real severity such as CVEs, exposed secrets, production impact, blocked deploys, or same-day remediation.

Sender/deepen flow:

- `extractSenderContext({ fromHeader, subject, body })` emits typed context (`fromKind`, `effectiveAuthor`, optional `bodyActor`, optional `botSlug`) so the model does not parse service envelopes from prose.
- The cheap classifier receives the email plus `SenderContext` only. It does **not** read user facts, preferences, profile, or memory.
- `deepen` executes live only when `botSlug` is in `SEVERITY_SUSPECT_BOTS` (`sentry`, `stripe-billing`, `google-security`, `vercel`, `datadog`). It reads a bounded Postgres user-context slice (profile, active integrations, confirmed facts, preferences, entities, recent memory) and returns the final category/rationale. Failure falls back to the cheap output.
- Low-confidence classifications and unknown-human important senders are shadow-logged (`triage.sender_extraction`) but do not execute boss `deepen` yet.
- Dossier auto-trigger/cache is intentionally deferred in this tree because ADR-0031 `person_profiles` / `person-research` are not implemented; if `deepen` requests a dossier, the workflow logs that it was deferred and still labels the email.

Smoke: `pnpm --filter server tsx --env-file=.env src/scripts/smoke-triage.ts` (requires a connected Google account + at least one ingested email).
