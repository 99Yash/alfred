# Operations scripts

`apps/server/src/scripts` is the local/prod operator command module. It
intentionally contains entrypoints, not application modules. Prefer unit tests
for normal regression coverage; use scripts for smoke checks, backfills, prod
repair, and manual activation.

## Script classes

| Folder       | Prefix / shape         | Use                                                                | Safety default                                                        |
| ------------ | ---------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `smokes/`    | `smoke-*`              | End-to-end or integration smoke. Often needs real env/credentials. | May mutate local DB; read header before running against real mailbox. |
| `backfills/` | `backfill-*-committed` | Backfill existing data.                                            | Dry by default unless `--commit` is passed.                           |
| `dry-runs/`  | `dry-run-*`            | Read-only analysis or fixture replay.                              | No writes expected.                                                   |
| `backfills/` | `project-*-committed`  | Projection run / activation style job.                             | Dry by default; `--commit` persists; extra flags may activate.        |
| `repairs/`   | `repair-*-committed`   | Narrow prod repair.                                                | Treat as high risk; dry first if supported.                           |
| `probes/`    | `probe-*`              | Diagnostic latency/provider probe.                                 | Usually read-only or external-call only.                              |
| `qa/`        | `qa-*`                 | Manual QA seed/helper.                                             | Local/dev preferred.                                                  |
| `ops/`       | `trigger-*-committed`  | Enqueue a real run.                                                | Dry by default unless `--commit` is passed.                           |
| `ops/`       | `seed-*`               | Seed idempotent app data.                                          | Idempotent by design; still read header.                              |

## Current inventory

The filesystem is the inventory:

```bash
ls apps/server/src/scripts/*/
```

A list transcribed into this file is only ever a stale copy of that output.

## Run patterns

Local TS:

```bash
cd apps/server
pnpm exec tsx --env-file=.env src/scripts/smokes/smoke-triage.ts
```

Prod bundle:

```bash
node apps/server/dist/scripts/backfills/backfill-gmail-observations-committed.js --emails=user@example.com
node apps/server/dist/scripts/backfills/backfill-gmail-observations-committed.js --emails=user@example.com --commit
```

## Rules

- Read script header first; most scripts document exact env and risk.
- Dry-run before `--commit` when available.
- Never use `db:push` for prod ops; migrations only.
- For Gmail-mutating smokes, confirm `GMAIL_MAILBOX_WRITES_ENABLED` intent.
- Add new scripts under the folder from the table. If no class fits, update
  this doc and `apps/server/src/scripts/README.md`.

## Provider webhook subscriptions

The raw receipt tier (ADR-0097 item 9) keeps every verified delivery that an
active credential owns. It can keep only what the provider sends, so each
provider console is set to send every event resource it offers. A future gap
is a configuration change, not a code change. Check this list first.

Rules for the GitHub App page: do not change the callback URLs, and keep
"Redirect on update" on. A callback URL swap saves silently as a no-op.

### GitHub App `alfred-99yash` (set 2026-09-06)

Subscribed to all 29 events that the current repository permissions offer:

`commit_comment`, `create`, `delete`, `fork`, `gollum`, `installation_target`,
`issue_comment`, `issue_dependencies`, `issues`, `label`, `merge_queue_entry`,
`meta`, `milestone`, `public`, `pull_request`, `pull_request_review`,
`pull_request_review_comment`, `pull_request_review_thread`, `push`, `release`,
`repository`, `repository_dispatch`, `security_advisory`, `star`, `sub_issues`,
`watch`, `workflow_dispatch`, `workflow_job`, `workflow_run`.

An event that needs a permission the App does not hold is not offered on the
page. Adding a permission asks the installation to approve it again.

### Sentry internal integration `Alfred` in `yashs-projects` (set 2026-09-06)

Webhook URL: `https://api.alfred.beauty/webhooks/inbound/sentry`. Alert Action
is on, so `event_alert` deliveries arrive from alert rules that target the
integration. Resources subscribed:

- `issue`: `created`, `resolved`, `assigned`, `ignored`, `unresolved`
- `comment`: `created`, `updated`, `deleted`
- `seer`: `root_cause_started`, `root_cause_completed`, `solution_started`,
  `solution_completed`, `coding_started`, `coding_completed`, `pr_created`,
  `iteration_started`, `iteration_completed`
- `preprod_artifact`: `size_analysis_completed`, `build_distribution_completed`
- `error` (`error.created`): not available. Sentry offers it on the Business
  plan and up, and the checkbox is disabled on this plan.

`metric_alert` and `installation` are not resource checkboxes on this form.
Sentry sends `installation` deliveries to every integration, and metric alerts
arrive through the Alert Action on a metric alert rule.

### Gmail push: Pub/Sub subscription `gmail-push-prod` (recreated 2026-09-06)

Project `vermithor-485206`, topic `projects/vermithor-485206/topics/gmail-push`.
The topic grants Pub/Sub Publisher to the Gmail push service account.

| setting | value |
| --- | --- |
| Delivery type | Push |
| Endpoint URL | `https://api.alfred.beauty/webhooks/gmail` |
| Authentication | On, service account `gmail-push-pusher@vermithor-485206.iam.gserviceaccount.com` |
| Audience | `https://api.alfred.beauty/webhooks/gmail` (must equal `GOOGLE_PUBSUB_AUDIENCE` on Railway) |
| Retry policy | Exponential backoff, 10 s to 600 s |
| Expiry period | **Never expire** |

Why "Never expire" matters. The first subscription of this name was created on
2026-05-20 with the console default, which deletes a subscription after 31 days
with no subscriber activity. The production database was emptied in July 2026.
With no credential there was no Gmail watch, no published message, and no push
delivery, so the subscription expired on its own about a month later. The GCP
audit log holds no DeleteSubscription entry, because the expiry is a system
action. From then until 2026-09-06 every Gmail sync ran as `reason=poll-fallback`
and a new email waited up to 10 minutes for a tag. If push stops again, check
this subscription first. A `gmail.poll_recent` line in the server log proves that
push is live: only the webhook enqueues that job. The first one after the
recreation ran at 14:33:52 UTC on 2026-09-06, between two sweeps.

The following code supports recovery and diagnosis (#998):

- Each sweep considers every active Gmail cursor. It does not use the previous
  sync completion time as a cutoff. `GMAIL_POLL_SWEEP_INTERVAL_MS` belongs to the
  assistant ingestion policy. A sweep during an active poll retains one follow-up
  through BullMQ `keepLastIfActive`. Queue delays, Gmail calls, and indexing can
  still extend delivery beyond the five-minute schedule.
- The Gmail integration page shows "Push stale" when a fallback poll inserts an
  unannounced message and its start time is more than
  `GMAIL_PUSH_DELIVERY_GRACE_MS` after the last push receipt. This ten-minute
  grace is a push delivery latency budget. Poll processing time does not count.
  A receipt with a history ID at or above the inserted addition's ID excludes
  that change from the evidence, even if an old `internalDate` hid it from the
  realtime search. The receipt query uses the highest numeric ID, so delivery
  order does not change this decision.
- `gmailPushStaleStatus` supplies the timestamp and its meaning to the account
  row. With a receipt, the UI says "Last push". Without one, it says "Watch
  installed". Renewal preserves `installedAt` and updates `renewedAt`.
  Existing rows retain the installation timestamp available at this upgrade;
  earlier installation times cannot be recovered from overwritten metadata.
- `ingestion_state.last_webhook_sync_at` records successful webhook fetch and
  persistence, including empty or deduplicated results. A thrown error or a
  partial message failure does not advance it. Embedding, attachment jobs, and
  triage run after or outside this timestamp. Receipt time proves transport
  delivery; it does not prove successful sync completion.

Workflow trigger readiness still permits delivery through the fallback sweep.
A dead push subscription can therefore leave readiness healthy while the account
row shows a warning. This is an explicit limit of the binary readiness model:
marking push failure unhealthy there would defer Gmail-triggered runs that the
sweep can deliver. A separate push health dimension is outside this change.

The warning is evidence of missing delivery, not proof that the subscription is
permanently dead. Gmail can delay or drop notifications; see the
[Gmail push reliability limits](https://developers.google.com/workspace/gmail/api/guides/push#reliability).
Receipt retention must preserve delivery time and the highest history ID before
old receipts are removed. Existing fallback timestamps written before this fix
can retain an old warning until the next push arrives.
