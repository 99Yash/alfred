# ADR-0090 — `event_receipts`: audit trail + gap detection source of truth

**Decision.** The `event_receipts` table is the durable audit trail for provider webhook deliveries and the source of truth for the `coverageGap` signal that workflow trigger readiness reads. Each row is one provider delivery — one Pub/Sub push, one GitHub webhook, etc. — deduplicated by `(provider, provider_delivery_id)` via a full unique index with `onConflictDoNothing`.

**Why this exists alongside `webhook_events`.** `webhook_events` is the raw event log (one row per delivery, provider-agnostic, keyed by `provider_event_id`). `event_receipts` is the processing-lifecycle layer: it tracks verification outcome (`oidc_valid` / `oidc_skipped` / `oidc_failed`), processing status (`pending` / `completed` / `failed`), and the provider-specific `historyId` that gap detection reads. The two tables serve different consumers: `webhook_events` is the audit-of-receipt; `event_receipts` is the audit-of-processing and the control-plane signal.

**Why a full unique index, not a partial one.** The original design considered a partial unique index `WHERE processing_status != 'failed'` to allow retry rows for failed deliveries. This was rejected: the added complexity (multiple rows per delivery, index maintenance on status transitions) is not justified at single-user scale. A failed delivery stays as-is; the next redelivery creates a new receipt only if the previous one succeeded (unique index catches the duplicate). The `onConflictDoNothing` insert is the simplest dedup path.

**Gap detection reads receipts, not job data.** The BullMQ queue deduplicates rapid-fire pushes for the same credential (ADR-0032). When push B arrives 5 seconds after push A, the queue drops job B. If gap detection relied on the job's `pushHistoryId`, the higher historyId from push B would never reach the gap detector. Instead, `pollGmailRecent` reads the latest `historyId` from `event_receipts` — which is written by every webhook handler, even when the queue deduplicates the job. This makes receipts the source of truth for "what is the highest historyId we have seen?"

**Alternatives.**

- (a) Store `lastPushHistoryId` in `ingestion_state` JSONB from the webhook handler (rejected — adds a cross-layer write from HTTP to assistant state; receipts already have the data).
- (b) Pass `pushHistoryId` through the queue job and accept that deduped pushes lose their historyId (rejected — this is the class of bug this ADR exists to prevent).
- (c) Skip dedup entirely and let every push enqueue a job (rejected — Gmail bursts can produce dozens of pushes per second; the load-shedding from ADR-0032 is necessary).

**Schema.** See `packages/db/src/schema/integrations.ts` — `eventReceipts` table. The webhook handler's `defaultPersistReceipt` function writes receipts with `onConflictDoNothing` on `(provider, provider_delivery_id)`.

**Provider extension.** When adding GitHub (or any new provider), the implementer must choose: write to `event_receipts` with the provider's delivery ID (`X-GitHub-Delivery`), or rely on `webhook_events` alone. This ADR says: write to `event_receipts` if the provider's delivery ID is stable across redeliveries and the provider needs gap detection or processing-status tracking. Otherwise, `webhook_events` is sufficient.
