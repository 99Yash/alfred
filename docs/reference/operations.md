# Operations scripts

`apps/server/src/scripts` is the local/prod operator command module. It
intentionally contains entrypoints, not application modules. Prefer unit tests
for normal regression coverage; use scripts for smoke checks, backfills, prod
repair, and manual activation.

## Script classes

| Folder | Prefix / shape | Use | Safety default |
| --- | --- | --- | --- |
| `smokes/` | `smoke-*` | End-to-end or integration smoke. Often needs real env/credentials. | May mutate local DB; read header before running against real mailbox. |
| `backfills/` | `backfill-*-committed` | Backfill existing data. | Dry by default unless `--commit` is passed. |
| `dry-runs/` | `dry-run-*` | Read-only analysis or fixture replay. | No writes expected. |
| `backfills/` | `project-*-committed` | Projection run / activation style job. | Dry by default; `--commit` persists; extra flags may activate. |
| `repairs/` | `repair-*-committed` | Narrow prod repair. | Treat as high risk; dry first if supported. |
| `probes/` | `probe-*` | Diagnostic latency/provider probe. | Usually read-only or external-call only. |
| `qa/` | `qa-*` | Manual QA seed/helper. | Local/dev preferred. |
| `ops/` | `trigger-*-committed` | Enqueue a real run. | Dry by default unless `--commit` is passed. |
| `ops/` | `seed-*` | Seed idempotent app data. | Idempotent by design; still read header. |

## Current inventory

| Class | Scripts |
| --- | --- |
| Smoke | `smoke-agent`, `smoke-agent-resume`, `smoke-boss`, `smoke-brief-execution`, `smoke-briefing`, `smoke-cold-start`, `smoke-compaction`, `smoke-daily-briefing`, `smoke-dispatch`, `smoke-embed`, `smoke-expiry`, `smoke-extract`, `smoke-fallback`, `smoke-github-app`, `smoke-google`, `smoke-google-poll`, `smoke-learn-skill`, `smoke-memory`, `smoke-metered`, `smoke-metered-fail`, `smoke-scratchpad`, `smoke-sender-context`, `smoke-skill-documentation`, `smoke-sub-agents`, `smoke-tools-types`, `smoke-triage`, `smoke-triage-clickup`, `smoke-triage-upsell`, `smoke-web-search`, `smoke-workflows-tick` |
| Backfill | `backfill-gmail-observations-committed`, `backfill-gmail-sent-committed`, `backfill-label-self-mail-committed`, `backfill-object-state-github-committed`, `backfill-org-affiliation-committed`, `backfill-purge-document-facts-committed`, `backfill-retire-self-mail-committed`, `backfill-retire-self-mail-aliases-committed`, `backfill-team-graph-committed`, `backfill-triage-committed` |
| Dry run | `dry-run-attribution-fixtures`, `dry-run-reply-reeval-reconcile`, `dry-run-triage-backfill`, `dry-run-triage-recategorize-committed` |
| Probe | `probe-chat-ttft`, `probe-railway-token` |
| Projection / activation | `project-user-model-gmail-shadow-committed` |
| QA / seed / trigger / repair | `qa-gated-staging`, `seed-builtin-workflows`, `trigger-cold-start-committed`, `repair-sent-mislabeled-triage-committed` |

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
