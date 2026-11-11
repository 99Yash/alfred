Alfred is a single-user personal assistant on a system that the owner controls.

## Philosophy: what to build

Read [the theory start page](./docs/theory/README.md) before you design a change, add a prompt rule, a floor, a table, or a parser, or open an ADR. It holds the vision, the principles, and the theory state and code state of each stage.

- Build only on settled theory. If the theory of an area is open, work it out with the owner first. Do not patch the old code to cover the gap.
- Treat one owner correction as a rule for the whole area, not for one diff.
- Stop and rethink at the triggers on the theory page, for example the third patch in one area.
- File an issue only from a settled theory. Do not offer a patch as the next step.
- Read [decisions.md](./decisions.md) before you change architecture, and open only the ADRs that touch your change. Use the words in [CONTEXT.md](./CONTEXT.md).

## Implementation: how to write it

- Do not add tests. Make the compiler, a parse at the owning boundary, or a `pnpm check` gate carry the proof. State the residual risk in the PR body.
- Before you write a `format*`/`parse*`/`is*`/`to*`/`get*` function, find the existing one in [shared helpers](./docs/reference/shared-helpers.md) or with `codebases guide alfred "<intent>"`.
- Keep the repo root to config, entrypoints, and the four root docs. Tracked prose goes under `docs/`. Captures go in `references/`, one-off probes in `references/scratch/`, handoffs in `.handoff/`, and lessons in `.lessons/` (all gitignored).
- Write PR bodies with the sections that `scripts/check-pr-body.mjs` names, in ASD-STE100 English. Wait for CI with `node scripts/wait-pr-checks.mjs <n>`.

Conventions for each area: [review checklist](./docs/reference/review-checklist.md), [architecture](./docs/reference/architecture.md), [database](./docs/reference/database.md), [schemas](./docs/reference/schemas.md), [TypeScript](./docs/reference/typescript.md), [AI SDK](./docs/reference/ai-sdk.md), [Elysia](./docs/reference/elysia.md), [auth](./docs/reference/auth.md), [Replicache](./docs/reference/replicache.md), [tool runtime](./docs/reference/tool-runtime-map.md), and [state machines](./docs/reference/state-machines.md). Pipelines: [triage](./docs/reference/triage.md), [briefing](./docs/reference/briefing.md), and [cold start](./docs/reference/cold-start.md). Gates: [enforced rules](./docs/reference/enforced-rules.md) and [gate design](./docs/reference/gate-design.md).
