# Alfred API Guidance

`@alfred/api` has no importable door. Its `exports` map is empty, so Node refuses every
subpath with `ERR_PACKAGE_PATH_NOT_EXPORTED` and TypeScript cannot resolve one either. The
two transitional doors this package used to publish, `@alfred/api/backend` and
`@alfred/api/runtime`, are deleted. `packages/api/test/no-transitional-doors.test.ts` holds
that closed.

Nothing new belongs here. The package is a residue that campaign item 12 deletes, and it now
holds three things:

- `src/scripts/backfill-chat-usage.ts` — one operational backfill script, run in place.
- `test/` — suites that still cover assistant-owned behavior and have not moved yet.
- `evals/` — the Evalite suites and their shared helpers and config.

## Where the code went

- Product behavior, queues, and domain services: the `@alfred/assistant` module subpath that
  owns each name, such as `@alfred/assistant/briefings` or `@alfred/assistant/triage`.
- Worker lifecycle, bootstrap, and teardown: `createAssistantRuntime` at
  `@alfred/assistant/runtime`. A host process builds one runtime and drives `start` and
  `stop`.
- The authenticated HTTP surface, the root Elysia app, the derived `App` type, middleware,
  routes, SSE, webhooks, and the Replicache protocol: `@alfred/http`.

Each of those packages carries the boundary rules for the code it now owns. Read them there
rather than here.

## Commands

```bash
pnpm --filter @alfred/api test        # no env file; the CI arm
pnpm --filter @alfred/api test:db     # loads apps/server/.env when it exists
pnpm --filter @alfred/api eval
pnpm --filter @alfred/api eval:watch
```

A fresh worktree has no `apps/server/.env`, so `test:db` there skips the DB-backed suites and
still exits 0. Pass `--env-file=<main checkout>/apps/server/.env` to `tsx` when you need those
suites to run. Guard a DB-backed suite with `dbBackedSkip` from `test/support/db-backed.ts`,
never with a hand-rolled `process.env` read: a suite-level skip is invisible in the node:test
counters, so the helper throws instead of skipping when `CI` is set.
