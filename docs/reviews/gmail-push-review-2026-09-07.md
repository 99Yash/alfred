# Gmail push review follow-up

Review target: commit `9a8b4054` and the supplied structural, standards, and spec review.

## Where this change sits

Gmail push stores a receipt and requests a recent-message sync. A scheduled
history poll recovers mail that this search misses. The account page displays
push evidence; workflow readiness decides whether event runs can proceed.

## Why this change is needed

The main timing claims are confirmed. For a five-minute sweep, a poll that
finishes 61 seconds after the previous sweep leaves a sync age of 239 seconds.
The old 240-second cutoff skips it. A fallback insert at 540 seconds after a
live receipt becomes stale when processing adds 61 seconds. Both defects follow
from completion timestamps. Watch renewal also overwrites the no-receipt
baseline, and the old UI incorrectly calls that baseline a successful push.

The four standards findings are confirmed: server policy in contracts, provider
literals, a manual maximum aggregate, and a repeated health type. The date-format
finding is only partly correct: the notes fallback matches the account format,
but the other displays have distinct wording or date options.

## What this change does

- Removes the sweep cutoff. Every active cursor is considered on each run.
  BullMQ retains one follow-up if a poll is already active, using the existing
  repository pattern. See [BullMQ deduplication](https://docs.bullmq.io/guide/jobs/deduplication#keep-last-if-active-mode).
- Records the poll start as fallback evidence and excludes inserted additions
  already covered by the highest received history ID. Numeric aggregation ignores
  invalid persisted IDs and handles receipt delivery out of order.
- Moves schedule and grace policy into assistant ingestion. The grace now names
  its purpose as a delivery latency budget.
- Preserves the watch installation time at the database update and stores the
  latest renewal time separately. The status response carries the baseline kind,
  and the UI labels it as a push receipt or watch installation.
- Adds `last_webhook_sync_at` for a successful fetch/persist pass. Empty results
  count; partial message errors and thrown failures do not. Downstream work is
  outside this timestamp.
- Moves Gmail status logic into its facts reader, derives the provider from the
  delivery registry, uses Drizzle `max`, derives health types, shares the matching
  date formatter, and records the receipt-retention dependency beside the schema.

## Preserved behavior

Document deduplication, ignored outcomes, full-sync exclusions from push evidence,
credential filtering, and the webhook receipt write before queue deduplication
remain. Receipts measure transport delivery; successful sync has its own field.
A quiet mailbox does not become stale from elapsed time alone.

Workflow readiness remains healthy when the fallback path provides coverage.
Thus the original request that a dead subscription must never read healthy in
readiness is still outside this change. Readiness is binary, and making it fail
would block runs that fallback can deliver. The account warning carries push
failure separately.

Residual limits: a five-minute schedule cannot bound queue, provider, or indexing
delays. Notifications can also be delayed or dropped by Gmail; the warning does
not establish permanent subscription failure. See [Gmail push reliability](https://developers.google.com/workspace/gmail/api/guides/push#reliability).
Old watch metadata cannot recover an already overwritten installation date.
Old fallback stamps can retain a warning until a new push arrives. No new tests
are added, as required by repository instructions. Compiler and repository checks,
existing focused tests, and temporary local checks provide validation.


## Validation

- Reproduced the old cutoff and stale-warning arithmetic at 61 seconds of delay.
- `pnpm db:generate` created migration 0122; `pnpm db:migrate` applied it to
  the configured local database at `localhost:5432/alfred`.
- `pnpm check-types` and `pnpm check` passed. The latter reports existing lint
  warnings but no errors.
- Existing readiness and Gmail ingestion tests: 35 passed, none skipped.
  Existing Gmail watch gate tests: 3 passed, none skipped. Existing Gmail
  webhook tests: 24 passed, none skipped. Total: 62 existing tests passed.
- Direct calls to the status function returned no warning for a poll that
  starts inside the grace, a quiet mailbox, a push during polling, and a
  non-Gmail integration. Missing push produced the receipt baseline; no prior
  receipt produced the preserved watch-installation baseline after renewal.
- A local transaction called the actual watch-renewal function with Gmail I/O
  replaced by fixed responses. It preserved the old installation time, recorded
  renewal, and advanced the watch baseline. The transaction was rolled back.
- No live Gmail load test was run. The queue and provider limits above remain.
