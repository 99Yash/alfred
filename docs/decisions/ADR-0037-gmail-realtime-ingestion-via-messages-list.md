# ADR-0037 — Gmail realtime ingestion via `messages.list`; `history.list` demoted to catch-up


**Decision.** The webhook path (pub/sub push → ingest) is rebuilt on `users.messages.list?q=newer_than:5m` + per-id `messages.get`, deduped against the existing unique index on `documents.(user_id, source, source_id)`. `users.history.list` stops being the realtime primitive and is demoted to the 5-min poll-fallback sweep + the initial-sync seed, where it earns its keep. A new BullMQ job kind `gmail.poll_recent` carries the realtime path; the webhook handler enqueues it, and `gmail.poll_history` retains the cursor-based delta logic for catch-up only.

**Why this is its own ADR.** ADR-0024 chose the watch+history.list pattern (the Gmail-canonical realtime shape) and ADR-0032 added burst dedup over it. Neither questioned the implicit assumption that pub/sub-notified history pages would *contain* the just-arrived message. They don't, reliably. The 2026-05-22 latency study (`email_triage` joined to `documents` over the prior 24h, n=29) showed avg `ingestion_lag_s` = 30.7s but p90 = 117.8s, p95 = 197.3s, max = 222.2s — entirely driven by webhook history pages returning label/system events with no `messagesAdded` and the cursor advancing anyway. The user-perceived case: a GitHub `Sudo email verification code` took 195s to ingest and 4.5s to classify; the classifier was never the bottleneck. ADR-0037 names the root cause as a wrong-primitive choice in ADR-0024 — not a tunable parameter on the existing path.

**Why `messages.list` is the right realtime primitive.**

- `users.history.list` is a change-log API with its own indexing pipeline. Pub/sub fires from one pipeline; history is populated from another. The two are eventually consistent, with the gap measured in seconds-to-minutes for the very write that triggered the push.
- `users.messages.list` queries Gmail's search index — the same surface the web UI's search box hits. Empirically that index updates within seconds of a message arriving and is what Gmail's own client treats as "live."
- A `q=newer_than:5m` window returns ≤ tens of ids in single-user steady state; the existing `documents_source_id_idx` dedupes anything we already have.

**Path layout after this ADR.**

```
Realtime (new — gmail.poll_recent):
  trigger:   pub/sub push → /webhooks/gmail
  primitive: users.messages.list?q=newer_than:5m  (capped to 50)
  per id:    skip if (userId, source, sourceId) exists; else
             messages.get + persist + embed + enqueueTriage
  cursor:    advance to max(message.historyId) observed, monotonic only
  dedup key: gmail.poll_recent.{credId}  (30s TTL, ADR-0032 shape)

Catch-up (kept — gmail.poll_history):
  trigger:   5-min poll-sweep (gmail.poll_sweep finds cursors > 5min old)
  primitive: users.history.list from stored cursor
  role:      backstop for anything realtime missed — bursts > 50, dropped
             pushes, multi-minute outages. Fans triage on any inserts.
  dedup key: gmail.poll_history.{credId}  (separate from realtime — both
             paths can run concurrently without one starving the other)

Initial-sync seed (unchanged — gmail.ingest_recent):
  trigger:   OAuth callback (small seed) + history-cursor-gone fallback
  primitive: users.messages.list with broad query (newer_than:30d)
  role:      cold-start, full re-ingest after a 404 from history.list.
```

The realtime path advances the history cursor monotonically (only forward, only if higher than current) so the catch-up path doesn't re-fetch already-ingested messages. The inverse race (catch-up moves cursor while realtime is mid-flight) is harmless because every `persistMessage` is idempotent against `(userId, source, sourceId)`.

**Why we don't replace `history.list` entirely.**

- `history.list` is the right shape for catch-up after downtime — a 12-hour outage's worth of deltas is one paged call, not a 12-hour-wide `newer_than` window.
- The poll-fallback was always the backstop; that role doesn't change.
- Initial-sync after a `historyId-gone` 404 needs a defined cursor to start from. `messages.list` has no comparable "from this id forward" semantic.

**Path we did not take: empty-page retry on `history.list`.** The first draft of this ADR proposed a 20s retry whenever a webhook-triggered `gmail.poll_history` returned `inserted=0 skipped=0` with the cursor advancing. That would have moved p95 from ~200s into the ~25s band — useful, but a bandaid: it doesn't change the underlying API choice, it only papers over the latency by repeating the wrong-primitive call. We chose the structural fix instead because the PR was already off main with its own review surface, the realtime path is small enough to land in one pass (a ~140-line new function reusing every helper from `ingestRecentGmail`), and 25s is still not the product target.

**Trade-offs being accepted.**

- One additional Gmail API call on the realtime path compared to history.list (≈5 quota units for `messages.list`). At ≤100 webhooks/day per credential this is ≤500 units against a 1B/day quota — non-issue.
- `messages.list` skips spam/trash by default; `history.list` did not. Acceptable for triage: we don't want to label spam. If a future workflow needs spam visibility, it can opt in via `q=newer_than:5m in:anywhere`.
- The realtime path's 5-min `newer_than` window will miss a burst of >50 messages arriving for one credential inside 5 min. At single-user scale this is essentially never; the catch-up sweep will pick up the overflow within 5 min.
- Webhook and catch-up paths now use distinct dedup keys, so both can fire for the same credential inside 30s. Cheap: `persistMessage` dedupes, the catch-up's history.list only walks the cursor delta (small), and triage only fires on actual inserts.

**Pipeline shape on the realtime path.** The job handler runs `pollGmailRecent` → `enqueueTriageRuns` → `embedDocument` (in that order). Triage is enqueued *before* embedding so the classifier worker can start working while Voyage is still hitting the wire. Triage reads the `documents` row, not `chunks`, so an in-flight embed is irrelevant to it. Embed is best-effort here; `gmail.embed_sweep` is the safety net for any embed that fails. Inside `pollGmailRecent` itself the three header loads (cred + token + cursor) run in parallel, an indexed `SELECT ... WHERE source_id = ANY(...)` skips `messages.get` for ids we already have, and the remaining per-message fetch+persist runs at concurrency 5. Triage enqueues fan in parallel too — N triage `createRun + enqueueRun` pairs take one DB+Redis roundtrip rather than N.

**Expected impact.** Predicted p95 total tag latency ≈ 6–8s steady state (pub/sub ~1s + messages.list ~1s + messages.get + persist ~1.2s + triage enqueue ~0.1s + classify ~4s). Embed (~200ms–2s once Voyage is live) is no longer on the critical path. Median was already 8.5s; this collapses the long tail. Verify with a fresh `email_triage` ⨝ `documents` aggregation after a week of production traffic.

**Trace back to the symptom.** 2026-05-22 ~10:24 IST: user reports a GitHub Sudo verification code took ~3 min to be tagged. Logs show the webhook fired at 04:54:06 UTC with `inserted=0 skipped=0` and the cursor advancing 73 ticks (label/system events only); the same message was finally ingested at 04:57:34 UTC on a subsequent webhook and tagged 4.5s later. Median tag latency for the same user in the prior 24h: 8.5s. This ADR replaces that webhook-triggered call with `messages.list`, which sees fresh sends within seconds rather than minutes.
