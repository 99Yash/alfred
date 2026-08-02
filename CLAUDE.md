Alfred is a personal assistant.

## Directives

- Derive source-of-truth shapes: use named Drizzle row types, `$inferInsert`, and `z.infer` instead of parallel interfaces.
- Keep browser runtime code free of Node-only packages. Type-only imports are allowed only when TypeScript erases them; `pnpm check:web-boundaries` enforces the boundary.
- Treat external, persisted, and protocol data as `unknown`; validate it at the owning boundary instead of asserting it with casts.
- Apply database schema changes with `db:generate` then `db:migrate`.
- Put cross-boundary browser-safe contracts in `@alfred/contracts`, Replicache models in `@alfred/sync` and implementation details in the package or feature that owns them.
- Keep the repo root to config, entrypoints, and the four docs that live there (`README.md`, `CLAUDE.md`, `CONTEXT.md`, `decisions.md`). Everything else has a home, all four gitignored: screenshots, scraped assets, and DOM/network captures in `references/`; one-off DB/API probes in `references/scratch/` unless they earn a place in `scripts/`; HTML lessons and their runnable labs in `.teach/`; Markdown lessons in `.lessons/`. Tracked prose docs go under `docs/`.
- Reach for an existing helper before writing a new `format*`/`parse*`/`is*`/`to*`/`get*` function or adding to a route `helpers.ts`. Don't create new grab-bag `utils.ts`/`helpers.ts` for anything generic. Three things find the helper for you, so this list stays short:
  - `scripts/consolidation-rules.mjs` is the machine-checked half. `pnpm check` fails on a re-hand-rolled idiom, and `.claude/hooks/helper-hints.mjs` names the canonical helper from the same table while you are writing the line. Anything enforced there is deliberately **not** repeated here.
  - [shared helpers](./docs/reference/shared-helpers.md) is the full catalog and the colocation rule for where a new helper goes.
  - `codebases guide alfred "<intent>"` / `codebases source alfred "<symbol>"` searches this repo's rules and implementations semantically. Use it when you don't know the helper's name. Retrieval is a discovery aid, not a gate — it recalls roughly half the relevant docs in its top 5, so never rely on it to surface an invariant.
    What is left below is the residue: helpers whose absence a check cannot detect, because the wrong version is a plausible-looking call rather than a recognizable idiom.

  | About to write…                                | Reach for                                                                                                                                                                                                                                                                                                    | From                          |
  | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
  | read a nested field off `unknown`/JSON         | `getPath` / `getStringPath`                                                                                                                                                                                                                                                                                  | `@alfred/contracts`           |
  | normalize an email                             | `parseEmailAddress`                                                                                                                                                                                                                                                                                          | `@alfred/contracts`           |
  | gate a Gmail mailbox mutation                  | `gmailMailboxWritesEnabled()` (not the raw env field)                                                                                                                                                                                                                                                        | `@alfred/env/server`          |
  | normalize an entity identity before mint/dedup | `canonicalizeIdentityValue(kind, value)`                                                                                                                                                                                                                                                                     | `@alfred/contracts`           |
  | display a slug / complete tool name            | `humanizeSlug` / `humanizeToolName`                                                                                                                                                                                                                                                                          | `@alfred/contracts`           |
  | any calendar-day / zone / offset reading       | the timezone module — `resolveUserTimezone` for the zone, then `inZone(tz).day()` / `.hour()` / `.dayBounds()` / `.startOf(key)` / `.clock()` for anything needing one, and `addDays` / `weekdayIndex` / `formatDay` on the key for anything that doesn't. Zones are `IanaTimezone`, days are `LocalDateKey` | `@alfred/api` timezone        |
  | a model handle + its reasoning options         | `route(name)`                                                                                                                                                                                                                                                                                                | `@alfred/ai`                  |
  | a stored Google OAuth token                    | `getFreshAccessToken`                                                                                                                                                                                                                                                                                        | `@alfred/integrations/google` |
  | enforce prose voice                            | `sanitizeVoice`                                                                                                                                                                                                                                                                                              | `@alfred/api` voice-sanitize  |

- Read [decisions.md](./decisions.md) before changing architecture. It is a snapshot table plus an index; the ADRs themselves are one file each under `[docs/decisions/](./docs/decisions/)`. Open the two or three that touch your change — not all of them.
- When opening a PR, state the issues it closes in the body with GitHub closing keywords (`Closes #N`), one per issue the PR _fully_ resolves. Reference a partially-addressed issue as `Refs #N`.
- Write each PR body for a reviewer who knows the Alfred product but does not know the changed flow. Use the sections `Where this change sits`, `Why this change is needed`, `What this change does`, and `Preserved behavior`. Explain the user or background flow, the old and new ownership, the main implementation changes, and the invariants that must not change in ASD STE-100 English.
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
