# ADR-0097 — Inbound ingress registry: one descriptor per source behind one route

**Status.** Accepted (issue #562, Seam 1 of #554).

**Decision.** Inbound webhook sources are a typed registry, not an enum edit in three places.

1. **The contracts record is the source space.** `EVENT_SOURCE_ENTRIES` in `packages/contracts/src/event-triggers.ts` is one record keyed by source slug. Each entry names its `producer` (`in_process` or `inbound_webhook`) and its event-type tuple. `EVENT_SOURCES`, `EventSource`, `InboundEventSource`, `InProcessEventSource`, `EVENT_TYPES_BY_SOURCE`, and `EVENT_TYPES` are derived from it. This amends ADR-0047 item 3: the pair is still closed and const-narrowed, but it is one record, and per-source `*_EVENT_TYPES` constants are gone.
2. **One descriptor per inbound source, typed against its entry.** `InboundSourceDescriptor<S>` in `packages/assistant/src/connections/ingress/descriptor.ts` owns exactly the provider-specific knowledge: `verify(raw, headers)` over the raw bytes in constant time, a required `dedup` rule, `project(payload, headers)` to an event type the entry declares, `resolveOwner`, and an optional `subscription.health`. The registry `INBOUND_SOURCES` is typed `{ [S in InboundEventSource]: InboundSourceDescriptor<S> }`. An `inbound_webhook` entry with no descriptor, or a descriptor whose slug the record does not declare, is a compile error. The slug-matches-key and lowercase-header facts the type system cannot see are asserted when the module loads.
3. **One route.** `POST /webhooks/inbound/:source` in `packages/http/src/connections/inbound-webhook.ts` hands the raw body and headers to `receiveInboundDelivery`, which runs the shared path: look up, verify raw, parse, key, project, attribute, insert one `event_receipts` row with `onConflictDoNothing`, enqueue `ingress.deliver`. The route maps the outcome to a status and knows no provider. `POST /webhooks/github` stays as an alias because the GitHub App's hook URL points there.
4. **The receipt is the delivery.** `event_receipts` gains a nullable `payload` column (migration 0114). An inbound row stores the verified body under `provider = <slug>`, `provider_delivery_id = <dedup key>`, `event_type = <slug>.<type>`. The `ingress.deliver` job publishes `{ receiptId, deliveryKey }` on the trigger bus and marks the row `completed` or `failed`. The domain event is a pointer, the same rule ADR-0047 set for Gmail.
5. **A degraded subscription is a readiness problem, not silence.** `readInboundTriggerHealth(userId)` reads each descriptor's `subscription.health`. A workflow whose event trigger names an inbound source with an unhealthy or missing entry gets the new `trigger_degraded` code on the `trigger` field; the runtime treats it like `provider_unhealthy` and defers. A descriptor with no `subscription` adapter reads as degraded.
6. **The registry is the ceiling, not the definition.** `AUTHORABLE_EVENT_SOURCES` in `@alfred/sync` stays `["gmail"]`. The registry removes the enum ceiling; which sources a user may subscribe a workflow to remains a curated subset.
7. **Gmail stays on its own route.** Its Pub/Sub push is OIDC-authenticated and carries a pointer, not the event; the ingestion worker publishes Gmail's domain events, so its entry is `in_process`.

**Why.**

- **Three edits per source is no capability.** Before this change a new push source was an enum edit in contracts, a hand-written route in `@alfred/http`, and a switch case in the trigger module. `github-webhook.ts` was already the descriptor pattern by hand: raw-body HMAC, then `onConflictDoNothing` keyed on `X-GitHub-Delivery`. The work generalizes it.
- **Verification before parse is the trust boundary.** The `parse` hook hands the handler the exact bytes. Re-serializing a parsed body changes whitespace and breaks the HMAC. No agent-authored verifier exists: each `verify` is a few lines of provider code that must be right.
- **Dedup is declared, never guessed.** `dedup` is a required discriminated union. A source with no stable delivery id must declare a synthetic key over the payload. A source that declares neither does not compile, which is stronger than the issue's "fails at boot".
- **Acknowledge fast, then work.** The request returns as soon as the receipt row exists. The bus, the object-state fold, and any workflow run happen in the `ingress.deliver` job and its consumers. A slow handler ends delivery for some providers (Sentry auto-unsubscribes after 1000 timeouts in 24h), so nothing runs inline.
- **Fan-out stays on the bus.** ADR-0047 removed hardcoded fan-out. The old route called the ADR-0062 object-state reducer inline; that fold is now the `github-activity-fold` trigger consumer in `packages/assistant/src/runtime/adapters/github-activity-consumer.ts`, which reads the receipt payload by id, inserts `webhook_events` idempotently, and runs the reducer only for a newly inserted row.
- **Seam 2 depends on this.** Rung B and rung C completion notices arrive as inbound webhooks. A delegated run cannot report home without a descriptor to report into.

**Alternatives rejected.**

- (a) **Keep `EVENT_SOURCES` and add a `github` route by hand.** Preserves the three-edit cost the issue names.
- (b) **Descriptor in `@alfred/contracts`.** `verify` needs the webhook secret and `resolveOwner` needs the database; neither is browser-safe. Contracts keeps the entry, the server keeps the descriptor, and the mapped type joins them.
- (c) **`deliveryId(): string | null` with an implicit "probably unique" fallback.** The spec forbids it. The required `dedup` union makes the fallback unrepresentable.
- (d) **Publish the body on the bus.** Duplicates content at rest and puts third-party text in `agent_runs.trigger.payload`, which ADR-0047 rejected for Gmail.
- (e) **Store unattributable deliveries with `user_id NULL`.** `event_receipts.credential_id` is `NOT NULL` with a cascade, and a row nobody owns has no consumer. Such deliveries are acknowledged and logged, not stored. `webhook_events` used to keep them; that behavior changes.
- (f) **Run the fold inline in the route.** Reintroduces hardcoded fan-out and puts reducer latency on the provider's timeout budget.

**Implementation notes.**

- The `ingress/` files import no queue. `receive.ts` takes `enqueue` as an argument, and the HTTP route supplies `enqueueInboundDelivery` from `@alfred/assistant/connections/ingestion`, because `queue.ts` imports the trigger bus and `deliver.ts` publishes on it.
- The `ingress.deliver` job uses `jobId = ingress.deliver.<receiptId>`. A duplicate delivery whose receipt is not yet `completed` enqueues again; the id makes that a no-op for a live job and closes the crash window between the insert and the first enqueue.
- `deliverInboundReceipt` skips a `completed` receipt and retries a `failed` one, so the queue's retry attempts are not defeated by the status the previous attempt wrote.
- `findCredentialByInstallationId` in `packages/integrations/src/github/credentials.ts` replaces `findUserByInstallationId`: the receipt needs the credential id and the account id, not only the user.
- No feature tests (CLAUDE.md). The compiler proves the registry is exhaustive, `parseJsonWith` and `inboundDeliveryPayloadSchema` parse at the boundaries, and `check:exports` and `check:architecture` hold the module lines. Residual risk: the receive path's insert-then-enqueue ordering and the duplicate re-enqueue are proved by reading, not by a test.
