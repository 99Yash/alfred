# ADR-0017 — Skills + workflows: skills are markdown, workflows are trigger + brief + optional step DAG


**Decision.**

**Skills are markdown documents** with optional frontmatter for structured metadata (tools, default model, examples, activation hints). The body is the skill content; the frontmatter is parsed for runtime use. Skills are activated explicitly via `@skill:slug` references in workflow briefs or chat messages — the runtime resolves the slug, injects `content_md` into the system prompt, and applies frontmatter constraints.

**Workflows are `trigger + brief + optional explicit steps DAG`**:

- If `steps` is null/empty → pure agent run with the brief; boss decomposes at runtime. Most user-authored workflows live here ("mail me job listings every Tuesday in @skill:westerosi-dialect").
- If `steps` is present → runtime executes deterministically; node types: `run_skill` / `tool_call` / `llm_call` / `agent_run` / `condition` / `parallel` / `loop` / `hil_approve`. For built-ins like morning-briefing where the structure is known and reliability matters.
- Hybrid permitted: deterministic outer DAG with `agent_run(brief)` nodes for parts that should be LLM-decided.

**Schema sketch.**

```
skills
  id, user_id, slug (unique per user), name, description
  content_md      text      -- skill body (markdown), authoritative
  metadata        jsonb     -- parsed frontmatter: { tools?, default_model?, activation_keywords?, examples? }
  status          enum(active, draft, archived)
  created_at, updated_at

workflows
  id, user_id, slug (unique per user), name, description
  trigger         jsonb     -- cron schedule | integration event filter
  brief           text      -- natural-language workflow brief
  steps           jsonb?    -- optional explicit DAG; null = brief-only agent run
  hil_gates       jsonb     -- which steps require approval (only meaningful with explicit steps)
  status          enum(active, draft, paused, archived)
  last_run_id, last_run_at, last_run_status
  created_at, updated_at

workflow_runs
  id, workflow_id, started_at, ended_at, status
  -- references the durable agent runtime checkpoints (ADR-0006)
```

**Why this shape.**

- **Skills as markdown** matches the Claude-Code/Cursor pattern; trivial authoring (the user can write a skill in a text editor or paste it into a form), trivial inspection, naturally version-controllable if we ever want skills as files in `apps/server/skills/*.md` for built-ins.
- **Skills don't need to be referenced** — workflow briefs can inline instructions directly. Skills are a _reusability_ primitive, not a required indirection.
- **Brief-only workflows** match the dominant user authoring pattern ("here's what I want, figure it out"). Explicit DAGs are reserved for cases where reliability or structure matters.
- **Workflows compile down to durable runtime steps** (ADR-0006). HIL gates become runtime interrupts. Skills inside workflows spawn child agent runs linked via `parent_run_id`.
- **The 8 background agents in dimension's pattern** become 8 workflows, each cron-triggered, each invoking 1-2 skills.

**Authoring UX (later).**

- Skills: form in the app for body + frontmatter; markdown editor.
- Workflows: brief field, optional step builder; visual graph view is polish, not v1.
- For built-in workflows/skills owned by alfred itself: code in the repo (`apps/server/builtins/skills/*.md`, `apps/server/builtins/workflows/*.ts`), seeded into the DB at deploy time; user-authored ones live in DB only.

**Alternatives.**

- (β) Skills as templates, workflows as agent runs (rejected — loses determinism for known-structure workflows like morning briefing).
- (γ) Both agent-shaped (rejected — same; loses user-trust primitive of "I can read my Tuesday workflow as a list of steps").
- (δ) Both graph-shaped (rejected — graph editor authoring surface is too heavy for a one-person tool; brief-based is simpler with same expressive power).
