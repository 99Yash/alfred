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
