# Server Operations Scripts

This folder is the operator command module for `apps/server`. Files are
entrypoints, not app modules; shared implementation should usually live under
`packages/api/src/modules/*` or the owning package.

## Categories

- `backfills/` - dry-by-default data backfills and projection jobs. Committed
  variants require `--commit` before writing.
- `dry-runs/` - read-only analysis, prompt comparisons, and fixture replays.
- `smokes/` - end-to-end checks that may need real env, Redis, Postgres, or
  connected credentials.
- `probes/` - provider or latency diagnostics. Prefer read-only external calls.
- `qa/` - manual UI or integration setup helpers.
- `repairs/` - narrow production repair commands. Dry-run first when supported.
- `ops/` - idempotent seeds or commands that enqueue real runs.

## Run Patterns

Local TypeScript:

```bash
cd apps/server
pnpm exec tsx --env-file=.env src/scripts/smokes/smoke-triage.ts
```

Bundled production command:

```bash
node dist/scripts/backfills/backfill-gmail-observations-committed.js --emails=user@example.com
node dist/scripts/backfills/backfill-gmail-observations-committed.js --emails=user@example.com --commit
```

If a script must run in the production image, add it as an explicit entry in
`apps/server/tsdown.config.ts`; most local smokes do not need bundle entries.

Scripts that initialize Redis-backed queues should call `closeScriptResources`
from `script-runtime.ts` in `finally`, passing queue or worker closers in
dependency order. It preserves best-effort cleanup while ensuring Redis and the
database close last—for example,
`closeScriptResources(closeAgentQueue, closeBriefingQueue)`.
