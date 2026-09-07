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

Two code guards sit behind this record (#998):

- The sweep cutoff is one minute shorter than the sweep cadence
  (`GMAIL_POLL_SWEEP_STALE_AFTER_MS` in `@alfred/contracts`). With push dead, the
  sweep polls a credential on every run, so new mail waits one cadence at most.
- The Gmail integration page shows "Push stale" on the account row when the sweep
  inserts mail and the last push receipt in `event_receipts` is more than two
  cadences older than that insert (`gmailPushStaleSince` in
  `@alfred/assistant/connections`). The time shown is the last push receipt, or the
  watch install when no push has ever arrived. A quiet mailbox never reads stale,
  because the signal needs a message that only the sweep found. Workflow trigger
  readiness stays healthy while the sweep delivers, so a stale push does not
  defer Gmail-triggered runs.
