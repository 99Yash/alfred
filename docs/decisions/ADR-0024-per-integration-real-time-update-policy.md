# ADR-0024 — Per-integration real-time update policy

**Decision.** Webhooks-where-available as primary; polling-as-fallback. Polling cadence per-integration based on freshness sensitivity. Hybrid policy because webhook delivery is occasionally lossy and some providers don't support push at all.

**Important framing.** OAuth gives alfred the _capability_ to read provider data; it doesn't give us a _trigger_ to know when something changed. For user-initiated queries, alfred queries live (no infra needed). For _passive indexing_ (keep the chunked corpus current) and _proactive features_ (email triage on arrival, reply detection, meeting prep on schedule), alfred needs change notifications — that's what this ADR is about.

**Per-integration starting policy:**

| Integration             | Webhook                                                | Polling                                   | Notes                                                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Gmail**               | `users.watch` → Google Pub/Sub → our `/webhooks/gmail` | Every 5min as fallback (uses `historyId`) | **Required** for email-triage UX (ADR-0025). Push channels expire ~7 days; cron renewal.                                                                                                 |
| **Calendar**            | `events.watch` → push channel                          | Every 2min for next-24hr window           | Push channels expire 24hr–1mo; cron renewal. Fast polling because freshness dominates here per ADR-0010.                                                                                 |
| **Google Drive / Docs** | `changes.watch`                                        | Every 15min                               | Less time-sensitive; longer interval.                                                                                                                                                    |
| **Slack**               | Events API (subscribe to message + channel events)     | None (Slack discourages polling)          | Public URL needed for Events API delivery.                                                                                                                                               |
| **Linear**              | Webhooks per project/team                              | None                                      | Webhook + signature verify; webhooks reliable.                                                                                                                                           |
| **GitHub**              | App webhooks per repo/org (deferred — see ADR-0052)    | `/notifications` two-tier poll (~10min)   | **v1 polls** the authenticated API on the existing `repo` scope (ADR-0052); GitHub App webhooks are the deferred real-time upgrade, criterion = one-click connect, zero post-auth setup. |
| **iMessage**            | None (no API)                                          | N/A                                       | Local export ingestion only; deferred to a follow-up ADR (no clean ingestion path).                                                                                                      |
| **Notion**              | None (no public webhook API)                           | Every 10min via `last_edited_time` filter | Polling-only; expensive at high page counts but unavoidable.                                                                                                                             |
| **MCP servers**         | None (spec doesn't define push)                        | None                                      | Tools are call-on-demand; stateless from our side.                                                                                                                                       |

**Architectural shape:**

- One public webhook endpoint per provider: `POST /webhooks/<provider>`. Each verifies signature, parses payload, enqueues a BullMQ job for async processing.
- Polling jobs in BullMQ with cron triggers (`gmail.poll`, `calendar.poll`, `notion.poll`). Each fetches deltas using a `last_sync_token` column on `integration_credentials`. Idempotent — webhook + poll converging on the same change is safe.
- Webhook subscription renewal: cron jobs keep Gmail/Calendar push subscriptions alive; backoff on failure.
- Idempotency: every incoming webhook dedup'd by `(provider, provider_event_id)` in `webhook_events` table; replay-safe (matches ADR-0014's idempotency story).

**Public webhook URL.** Railway gives `*.up.railway.app` domains for free; webhooks register against those. Custom domain at production polish, not v1 requirement.

**iMessage caveat.** No API. Three options: (1) periodic local export script + manual upload; (2) read `chat.db` from a synced macOS file (privacy-fraught); (3) defer until clear ingestion path. **Default: defer iMessage** — not blocking morning-briefing or core agent value at v1.

**Why hybrid (not webhook-only or polling-only):**

- **Webhook-only** loses changes during webhook outages or subscription expirations; polling fallback catches drift.
- **Polling-only** kills proactive UX — auto-tagging email at 5–15min lag is visibly broken vs Gmail's instant-receive feel.
