# Alfred Agent Guidance

Alfred is a personal AI assistant.

## Repo-Wide Invariants

- Derive source-of-truth shapes: use named Drizzle row types, `$inferInsert`, and `z.infer` instead of parallel interfaces.
- Keep browser runtime code free of Node-only packages. Type-only imports are allowed only when TypeScript erases them; `pnpm check:web-boundaries` enforces the boundary.
- Treat external, persisted, and protocol data as `unknown`; validate it at the owning boundary instead of asserting it with casts.
- Apply database schema changes with `db:generate` then `db:migrate`. Never use `db:push`.
- Put cross-boundary browser-safe contracts in `@alfred/contracts`, Replicache models in `@alfred/sync`, and implementation details in the package or feature that owns them.
- Reach for an existing helper before writing a new `format*`/`parse*`/`is*`/`to*`/`get*` function or adding to a route `helpers.ts`. Don't create new grab-bag `utils.ts`/`helpers.ts` for anything generic. Three things find the helper for you, so this list stays short:
  - `scripts/consolidation-rules.mjs` is the machine-checked half. `pnpm check` fails on a re-hand-rolled idiom, and `.claude/hooks/helper-hints.mjs` names the canonical helper from the same table while you are writing the line. Anything enforced there is deliberately **not** repeated here.
  - [shared helpers](./docs/reference/shared-helpers.md) is the full catalog and the colocation rule for where a new helper goes.
  - `codebases guide alfred "<intent>"` / `codebases source alfred "<symbol>"` searches this repo's rules and implementations semantically. Use it when you don't know the helper's name. Retrieval is a discovery aid, not a gate — it recalls roughly half the relevant docs in its top 5, so never rely on it to surface an invariant.

  What is left below is the residue: helpers whose absence a check cannot detect, because the wrong version is a plausible-looking call rather than a recognizable idiom.

  | About to write…                                | Reach for                                             | From                          |
  | ---------------------------------------------- | ----------------------------------------------------- | ----------------------------- |
  | read a nested field off `unknown`/JSON         | `getPath` / `getStringPath`                           | `@alfred/contracts`           |
  | normalize an email                             | `parseEmailAddress`                                   | `@alfred/contracts`           |
  | gate a Gmail mailbox mutation                  | `gmailMailboxWritesEnabled()` (not the raw env field) | `@alfred/env/server`          |
  | normalize an entity identity before mint/dedup | `canonicalizeIdentityValue(kind, value)`              | `@alfred/contracts`           |
  | display a slug / complete tool name            | `humanizeSlug` / `humanizeToolName`                   | `@alfred/contracts`           |
  | timezone resolve/format                        | `resolveUserTimezone` / `formatInstantInTimezone`     | `@alfred/api` timezone        |
  | a model handle                                 | `getChatModel` / `getCheapModel` / `getBossModel`     | `@alfred/ai`                  |
  | a stored Google OAuth token                    | `getFreshAccessToken`                                 | `@alfred/integrations/google` |
  | enforce prose voice                            | `sanitizeVoice`                                       | `@alfred/api` voice-sanitize  |

- Read [decisions.md](./decisions.md) before changing architecture. It is a snapshot table plus an index; the ADRs themselves are one file each under [`docs/decisions/`](./docs/decisions/). Open the two or three that touch your change — not all of them.
- When opening a PR, state the issues it closes in the body with GitHub closing keywords (`Closes #N`), one per issue the PR _fully_ resolves. Reference a partially-addressed issue (e.g. `Refs #N`) without a closing keyword so it stays open.
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
