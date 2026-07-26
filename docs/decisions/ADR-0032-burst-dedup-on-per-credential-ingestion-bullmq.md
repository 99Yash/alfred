# ADR-0032 — Burst dedup on per-credential ingestion: BullMQ `deduplication: { id, ttl }`, never a static `jobId`


**Decision.** Both call sites that enqueue `gmail.poll_history` (the webhook handler and the 5-min sweep) collapse simultaneous enqueues for the same credential via BullMQ's `deduplication: { id, ttl }` option — never via the legacy `jobId` option as a dedup key. The dedup id is `gmail.poll_history.{credentialId}` and the TTL is 30 seconds. The webhook and sweep share the same dedup id so a webhook arriving inside the same 30s window as a sweep enqueue collapses into a single poll, not two redundant ones.

**Why this is its own ADR.** The static-`jobId`-as-dedup pattern is the obvious-looking choice and it almost works. It bit prod twice in one session before we understood the failure mode and switched. The choice deserves the same surface area as a real ADR so future contributors don't reach for the same gun.

**Why static `jobId` fails.** BullMQ uses `jobId` for identity, not for dedup. The shape of the bug:

1. `defaultJobOptions.removeOnComplete` keeps completed jobs around (`{ count: 50, age: 24h }`) so the queue's history view is useful.
2. Once a job with a custom `jobId` has reached the `completed` set, a later `queue.add(..., { jobId: <same id> })` becomes a silent no-op until that completed row is garbage-collected. There is no error, no retry, no enqueue.
3. The mailbox keeps publishing pubsub notifications. Each one tries to enqueue with the same custom `jobId`. Each one is a no-op. Sync stalls without any failure signal until `removeOnComplete` evicts the stale entry — which can be hours later, or never if `age` hasn't elapsed.
4. The 5-min sweep doesn't rescue this because it uses the same static `jobId` and gets the same silent no-op.

We hit this twice in a single afternoon: PR #18/#19 first re-introduced the bug while fixing a different one (a `:` separator that BullMQ forbids in jobIds), and PR #20 finally diagnosed and replaced the static-id pattern with TTL dedup.

**Why `deduplication: { id, ttl: 30_000 }` works.**

- **It is documented dedup, not accidental identity.** BullMQ's `deduplication` option (v5+) is explicitly for "collapse enqueues for `id` that arrive within `ttl` of each other." It tracks dedup independently of the completed-set, so completion doesn't poison the next enqueue.
- **It releases on a wall-clock window, not on completion.** A real pubsub notification arriving 30s after the previous one enqueues a fresh job. A burst of notifications inside 30s collapses into one — which is exactly the load-shedding behavior we want.
- **Webhook and sweep share the same id.** `gmail.poll_history.{credentialId}` is used by both call sites. A sweep tick firing one second after a webhook delivery collapses into the webhook's poll; the next sweep 5 minutes later sees a fresh window.
- **30s is the right TTL.** Gmail publishes notifications at near-real-time cadence; bursts in the same second or two are common (a 5-message conversation, a thread settlement). 30s is long enough to collapse those bursts but short enough that a legitimate second push after a quiet period still enqueues. Longer TTLs (e.g. 1 minute) start swallowing real signal; shorter TTLs (e.g. 5 seconds) don't collapse the bursts that motivated this.

**Schema sketch.** No DB change; this is pure queue-config.

```ts
// packages/api/src/modules/integrations/gmail-webhook.ts
await queue.add(
  "gmail.poll_history",
  { kind: "gmail.poll_history", credentialId: cred.id, reason: "webhook" },
  { deduplication: { id: `gmail.poll_history.${cred.id}`, ttl: 30_000 } },
);

// packages/api/src/modules/integrations/queue.ts (sweep branch)
await queue.add(
  "gmail.poll_history",
  { kind: "gmail.poll_history", credentialId: c.credentialId, reason: "poll-fallback" },
  { deduplication: { id: `gmail.poll_history.${c.credentialId}`, ttl: 30_000 } },
);
```

The dedup id format is `gmail.poll_history.{credentialId}` with `.` separator (BullMQ forbids `:` in jobIds and we standardize on `.` for any id-like string we hand BullMQ, dedup-id or otherwise — a separator slip-up was its own session-of-pain).

**Worker log shape.** PR #22 added `skipped=` and `cursor=before->after` to the `gmail.poll_history` worker log so that the next time someone reads `inserted=0 errors=0`, they can tell at a glance whether Gmail returned no messages, returned messages that all dedup'd via `onConflictDoNothing`, or simply advanced the cursor during a quiet window. Worth restating: the dedup we're documenting in this ADR is at the queue layer (collapsing redundant *jobs*); `onConflictDoNothing` on `(userId, source, sourceId)` is the orthogonal dedup at the storage layer (collapsing redundant *documents*).

**Alternatives.**

- (a) Static custom `jobId` per credential (rejected — the bug this ADR exists to prevent).
- (b) Random `jobId` per enqueue, dedup-at-handler-time via SELECT-FOR-UPDATE on `ingestion_state` (rejected — pushes load-shedding into the worker, costs a DB row lock per burst event, and adds a code path that does nothing useful 99% of the time).
- (c) Webhook-only enqueue, no sweep fallback (rejected — Gmail pubsub is best-effort; a missed notification could stall a mailbox for hours, and the sweep cost is trivial at single-user scale).
- (d) Sweep-only, no webhook (rejected — 5-minute median ingest latency is unacceptable for the morning-briefing and triage UX).
- (e) Longer TTL (e.g. 5 minutes, matching sweep cadence) (rejected — sweep ticks are already idempotent against recent polls via `last_sync_at`, and a 5-min dedup window swallows real second-event signal; the 30s window collapses true bursts and lets sweep do its job).

**Generalization.** The same pattern applies to any future per-credential or per-account real-time poll: when both a push channel and a fallback sweep can enqueue the same kind of work, share a dedup id and a short TTL. Don't reach for `jobId`.
