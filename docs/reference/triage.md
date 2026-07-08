# Email triage (m9)

Per ADR-0025 #1 alfred classifies every newly-ingested Gmail message into one of ten categories: `urgent`, `action_needed`, `follow_up`, `awaiting_reply`, `meeting`, `fyi`, `done`, `payment`, `newsletter`, `marketing`. Each category maps to an `Alfred/<Name>` Gmail label that gets written back to the message.

The pipeline:

1. A Gmail ingestion job inserts a fresh `documents` row. The realtime path is `gmail.poll_recent` (pub/sub → `messages.list?q=newer_than:5m`, ADR-0037); the catch-up path is `gmail.poll_history` (5-min sweep → `history.list` from the stored cursor). Both call into the same `persistMessage` helper so dedup behaves identically.
2. `packages/api/src/modules/integrations/queue.ts` enqueues an `email-triage` agent run per inserted doc (skipped on bulk re-ingest / `fullResync`). The realtime case enqueues triage _before_ awaiting embedding so the classifier worker overlaps with Voyage.
3. The `email-triage` workflow (in `apps/server/src/builtins/workflows/email-triage.ts`) runs `extract-sender-context` (deterministic parser) → `classify` (context-rich cheap-tier LLM via `@alfred/ai`'s `metered.object()`, fed deterministic observations) → optional second cheap pass on tightly-gated conflicts → override floor → `apply-label` (`messages.modify` through the shared `reconcileThreadLabel` writer). There is no routine boss `deepen` path in triage v3.
4. Result lands in `email_triage` (one row per thread, keyed by `(user_id, source_thread_id)`); the chosen `Alfred/`\* label id is persisted on `applied_label_id`.

Initial-sync seed: the OAuth callback (`google-routes.ts /callback`) enqueues a `gmail.ingest_recent` job with `maxMessages: 8, triageInsertedDocs: true` so a brand-new account has classified mail to look at immediately. The flag is the opt-in that narrows ADR-0025's "no triage on bulk re-ingest" rule — only callers that explicitly request triage get it. Re-connect is idempotent (dedup index → 0 inserts → 0 triage runs).

**One row per thread.** `email_triage`'s PK is `(user_id, source_thread_id)`. Every new message in a thread re-runs the classifier and _overwrites_ the row — the canonical alfred tag is always the latest message's outcome. `email_triage.document_id` is a soft pointer (no FK) to the latest classified Gmail message in the thread; it survives the underlying document being purged.

**Thread-level label collapse.** Gmail's thread view unions labels across every message in a thread, so an older `fyi`/`follow_up` message left next to a newer `done` reply would show both tags. The `apply-label` step fetches the thread from Gmail (`findThreadSiblingsWithAlfredLabels` → `threads.get` in `minimal` format) and strips every alfred label from every sibling message before applying the new one to the latest message. Source of truth for siblings is Gmail itself, not the DB — that self-heals across stale hand-labelling or older deployments.

Label management (`packages/integrations/src/google/labels.ts`):

- `ensureAlfredLabels(credentialId)` idempotently creates the ten labels and caches the id map on `integration_credentials.metadata.alfredLabels`. Pass `force: true` to rebuild if a label was deleted out-of-band.
- `applyTriageLabel({ credentialId, messageId, category, previousLabelId, threadSiblings })` adds the chosen label, removes the previous one on the same message, and (when `threadSiblings` is supplied) strips each sibling's alfred label so the thread collapses to a single tag.

Classifier guardrails:

- `meeting` is only for a live personal/work calendar-style meeting where the user has a scheduling or attendance action: accept/decline an invite, answer availability, handle a time/location change, join soon, or negotiate room/attendance details. Meeting notes/recaps/minutes, pre-meeting prep/agenda briefs, future-event announcements with no invite or set date, and task-tracker/product notifications that merely mention meeting language are `fyi` (or `done` when they explicitly close a loop).
- Public events, product launches, webinars, conferences, keynotes, and bulk "save the date" blasts are `marketing`/`newsletter`/`fyi`, not `meeting`.
- Shareholder, AGM, annual report, proxy/e-voting, registrar/depository, and stock-market notices are usually `fyi`; use `action_needed` only when the email asks the user to vote, register, submit a form, or meet a concrete deadline.
- Review bots (`coderabbit`, Copilot review, GitHub Actions, Dependabot, Renovate) are advisory by default and usually land as `fyi`; they only become `action_needed`/`urgent` when the body shows real severity such as CVEs, exposed secrets, production impact, blocked deploys, or same-day remediation.

Sender/observation flow:

- `extractSenderContext({ fromHeader, subject, body })` emits typed context (`fromKind`, `effectiveAuthor`, optional `bodyActor`, optional `botSlug`) so the model does not parse service envelopes from prose.
- `gatherObservations` feeds the cheap classifier deterministic context: sender-prior histogram for bulk/service senders, account persona, thread state, known-contact flag for human senders, Gmail-native signals, and cheap content flags.
- `detectConflict` may run one second cheap pass when the first output conflicts with a strong deterministic expectation: passive category despite a security flag, or important category from a strong-bulk sender with no supporting severity signal.
- `applyOverrideFloor` forces `urgent` only on high-precision secret-exposure wording such as an API key/token/private key/password/secret being exposed, leaked, committed, compromised, found, or detected. CVEs, payment urgency, and generic auth vocabulary stay model-owned.
- `applyMeetingDemotionFloor` demotes false `meeting` tags to `fyi` for post-hoc recaps, prep/agenda briefs, passive collaboration-tool relays, investor/legal meeting notices, and public-event blasts. Real Calendar action subjects stay `meeting`, even from service/no-reply addresses.
- `agent_decision_traces` stores a `triage.classification` row with sender context, observations, first/second pass categories, second-pass failure, floor match/force, and todo-rubric outcome so tuning happens from observed misses in SQL rather than transient progress logs.
- The dormant `deepen`/dossier hooks remain in code for future non-triage work, but triage v3 does not call them.

Smokes:

- From `apps/server`, `pnpm exec tsx --env-file=.env src/scripts/smokes/smoke-triage.ts` exercises the Gmail-backed end-to-end workflow and requires a connected Google account plus at least one ingested email.
