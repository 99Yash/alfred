# Alfred Agent Guidance

Alfred is a personal AI assistant in a pnpm workspace monorepo. Packages use the `@alfred/*` scope, and `pnpm check-types` must work on a fresh tree without a prior build.

Read the nearest nested `AGENTS.md` before editing within its subtree.

## Repo-Wide Invariants

- Derive source-of-truth shapes: use named Drizzle row types, `$inferInsert`, and `z.infer` instead of parallel interfaces.
- Keep browser runtime code free of Node-only packages. Type-only imports are allowed only when TypeScript erases them; `pnpm check:web-boundaries` enforces the boundary.
- Treat external, persisted, and protocol data as `unknown`; validate it at the owning boundary instead of asserting it with casts.
- Use `serverEnv()` from `@alfred/env/server`; do not read `process.env` directly.
- Apply database schema changes with `db:generate` then `db:migrate`. Never use `db:push` outside local exploration.
- Put cross-boundary browser-safe contracts in `@alfred/contracts`, Replicache models in `@alfred/sync`, and implementation details in the package or feature that owns them.
- Reach for an existing helper before writing a new `format*`/`parse*`/`is*`/`to*`/`get*` function or adding to a route `helpers.ts`. Full catalog and owners in [shared helpers](./docs/reference/shared-helpers.md); the quick smell map is below. Don't create new grab-bag `utils.ts`/`helpers.ts` for anything generic.

  | About to write… | Reach for | From |
  |---|---|---|
  | check `unknown` is an object / coerce it | `isRecord` / `toRecord` / `toStringArray` (not `as string[]`) | `@alfred/contracts` |
  | read a nested field off `unknown`/JSON | `getPath` / `getStringPath` | `@alfred/contracts` |
  | caught error → string | `toMessage` (not `String(err)`) | `@alfred/contracts` |
  | parse+validate JSON | `parseJsonWith` (not `JSON.parse` + cast) | `@alfred/contracts` |
  | normalize an email | `parseEmailAddress` | `@alfred/contracts` |
  | read an env var | `serverEnv()` (not `process.env`) | `@alfred/env/server` |
  | gate a Gmail mailbox mutation | `gmailMailboxWritesEnabled()` (not the raw env field) | `@alfred/env/server` |
  | normalize an entity identity before mint/dedup | `canonicalizeIdentityValue(kind, value)` | `@alfred/contracts` |
  | display a slug / complete tool name | `humanizeSlug` / `humanizeToolName` | `@alfred/contracts` |
  | narrow a dynamic tool-name string | `isToolName` (not `as ToolName`) | `@alfred/contracts` |
  | validate a timezone | `isIanaTimezone` (not a hand-rolled `Intl` trial) | `@alfred/contracts` |
  | timezone resolve/format | `resolveUserTimezone` / `formatInstantInTimezone` | `@alfred/api` timezone |
  | a model handle | `getChatModel` / `getCheapModel` | `@alfred/ai` |
  | a stored Google OAuth token | `getFreshAccessToken` (not the persisted `accessToken` or `refreshAccessToken`) | `@alfred/integrations/google` |
  | enforce prose voice | `sanitizeVoice` | `@alfred/api` voice-sanitize |
- Read [decisions.md](./decisions.md) before changing architecture.
- When opening a PR, state the issues it closes in the body with GitHub closing keywords (`Closes #N`), one per issue the PR *fully* resolves. Reference a partially-addressed issue (e.g. `Refs #N`) without a closing keyword so it stays open.
- Relevant or appropriate locations of handoff docs: at /private/tmp/claude-501/-Users-yash-Developer-self-alfred/... or ./.handoff here along with ./.lessons.

## References

- [Code style and review checklist](./docs/reference/code-style.md) and [structural review](./docs/reference/structural-review.md)
- [Shared helpers — reach for these before writing new ones](./docs/reference/shared-helpers.md)
- [Architecture and package boundaries](./docs/reference/architecture.md)
- [TypeScript configuration](./docs/reference/typescript.md)
- [Elysia request lifecycle](./docs/reference/elysia.md)
- [Database conventions](./docs/reference/database.md)
- [Authentication](./docs/reference/auth.md)
- [AI SDK conventions](./docs/reference/ai-sdk.md)
- [Replicache synchronization](./docs/reference/replicache.md)
- Domain pipelines: [email triage](./docs/reference/triage.md), [morning briefing](./docs/reference/briefing.md), and [cold-start research](./docs/reference/cold-start.md)
