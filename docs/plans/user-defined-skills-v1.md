# User-defined skills (v1)

> **Status:** design proposal. Nothing is built yet.
>
> **Basis:** the repository state on 2026-08-02. It builds on the lazy tool
> surface (#405), the chat→memory capture pattern
> ([chat-memory-capture-v1.md](./chat-memory-capture-v1.md)), the capture gate
> (ADR-0079, [memory-capture-hardening.md](./memory-capture-hardening.md)), and
> the sibling tool spec
> ([research-source-discovery-v1.md](./research-source-discovery-v1.md)).

## Outcome

A user writes a skill and invokes it later. A skill is a saved procedure that
Alfred loads on demand. The user also asks Alfred to turn a chat into a skill,
and Alfred does so only when the chat holds a real, reusable procedure.

Two properties matter most:

1. Skills load lazily. An arbitrary user set cannot sit in the system prompt.
2. Capture is honest. Alfred never invents a hollow skill from a chat that has
   no procedure in it.

## What a skill is

A skill is data, not code. Keep it apart from a coded tool such as
`research.discover`, which has an `execute` function.

```ts
interface SkillRecord {
  id: string;
  userId: string;
  name: string; // the invoke handle, e.g. "resume-in-brand"
  summary: string; // one sentence of catalog copy — the router reads this
  tags: readonly string[]; // capability groups, e.g. ["writing", "research"]
  body: string; // the procedure and rubric, loaded at invoke time
  allowedTools?: readonly string[]; // tools this skill may use, before grants
  trigger?: { phrases?: readonly string[] }; // aliases for implicit selection
  status: "proposed" | "confirmed" | "disabled";
  source: { kind: "user_authored" | "chat_capture"; threadId?: string };
  createdAt: Date;
  updatedAt: Date;
}
```

- A **tool** answers "call this function."
- A **skill** answers "follow this procedure, with these tools."

## Storage and sync

- The skill row lives in Postgres, user-scoped, `user_id` foreign key with
  `CASCADE`.
- The browser reads it through Replicache. Put the synced model in
  `@alfred/sync`, per the repo boundary rule.
- Reuse the `proposed`/`confirmed` status machine from chat→memory capture:
  - A `proposed` skill is visible to the user for review. The boss cannot invoke
    it.
  - A `confirmed` skill joins the catalog. The boss can find and invoke it.
  - A `disabled` skill stays saved but leaves the catalog.

## Discovery and load

Skills ride the same catalog as tools. Do not build a parallel surface.

- **Catalog entry.** A confirmed skill registers with its `summary`, `tags`, and
  `trigger.phrases`. `preloadToolsForPrompt` ranks it against the user's turn.
  `system.search_tools` finds it by name mid-run.
- **Load path.** Invoke loads the skill `body` into a **run-pinned preamble** in
  the transcript, not the system prompt. Pin it for the whole run. It is stable
  within the run, so `assertStableSystem` does not throw. It costs one cold cache
  write on turn one, then it caches.
- **Tool scope.** Intersect `allowedTools` with the user's real grants. A skill
  never widens access. A named tool the user lacks is dropped, and the load note
  says so.

## Invocation

- **Explicit.** The user names the skill or types `/name`. Load it by name, the
  `resolveExactToolLoad` pattern. Skip ranking.
- **Implicit.** `preloadToolsForPrompt` ranks the skill by `summary` and `tags`,
  or the boss finds it mid-run with `system.search_tools`.

## Chat → skill capture

This is the core new pipeline. It mirrors chat→memory capture. It has two
triggers, one gate, one extractor, and a mandatory confirm step.

### Triggers

1. **Explicit (slice 1).** The user says "turn this into a skill." An in-band
   tool `system.propose_skill` runs. This generalizes `system.remember`
   (`system.ts:247`), which today only saves a narrow standing instruction.
2. **Implicit (slice 2).** An end-of-thread job scans a closed thread for a
   reusable procedure and proposes a candidate. This reuses the chat→memory
   end-of-thread extractor path.

### The gate — "did this chat hold a skill?"

The gate answers the user's real worry. It defaults to deny. The prompt is
recall guidance only; the floors are code. This mirrors ADR-0079.

**Deterministic floors (a fail here stops capture):**

- The thread must describe a **sequence or a standing preference**, not a single
  answer. Too little substance fails.
- The candidate must not duplicate a confirmed skill. On a match, propose an
  **edit** to that skill, not a new one. This mirrors the memory conflict rule.

**Judgment rubric (the model scores these; principles, not examples):**

- The procedure repeats. It is not a one-time request.
- The procedure generalizes. It works on more than the one case in the chat.
- The user framed it as "how I want X done," not "do X once."

**Honesty floor.** When the user asks explicitly but no procedure is present,
Alfred refuses and says why. It never saves a hollow skill. This is the "no
false success" charter invariant.

### The extractor

A cheap-tier model turns the ramble into a `SkillRecord` draft: a `name`, a
one-sentence `summary`, `tags`, a clean `body` with the steps and the rubric,
and a proposed `allowedTools` list from the tools the chat actually used.

### Propose, then confirm

A skill changes future behavior, so confirm is mandatory. There is no
auto-commit threshold like the fact path uses.

- Capture writes the skill as `status: "proposed"`.
- The user sees the draft, edits any field, then confirms or discards.
- Only a confirmed skill joins the catalog.

## Safety

1. A skill never widens tool access. Intersect `allowedTools` with real grants.
2. Load the `body` as a clearly delimited preamble block. Do not blend it into
   the charter. It is user data, not part of the system contract.
3. Confirm is mandatory for every new skill and every edit that changes the
   `body` or `allowedTools`.

## Non-goals

- No auto-commit. A skill never activates without a user confirm.
- No sharing between users. v1 is single-user and private.
- No coded capability. A skill composes existing tools; it adds no new
  `execute`. A new capability is a tool, per the sibling spec.
- No implicit trigger in slice 1. The explicit ask ships first.

## Acceptance

- **Explicit capture.** In a thread where the user describes a repeatable resume
  procedure, "turn this into a skill" yields one `proposed` `SkillRecord` with a
  filled `body` and `tags`. The user confirms. A later turn invokes it by name
  and the body loads into the run-pinned preamble.
- **Honest refusal.** In a thread that is a single question and answer, the same
  ask returns a plain refusal and writes no row.
- **Scope guard.** A skill that names a tool the user has not granted loads with
  that tool dropped and a clear note.

## Open questions

1. **Gate placement.** Does the explicit path share the implicit path's
   extractor, or run a lighter in-band draft? Recommendation: share one
   extractor so both paths produce the same record shape.
2. **Name collision.** How does a captured `name` avoid clashing with a tool
   action or another skill? Recommendation: validate the handle at confirm time
   and ask the user to rename on a clash.
3. **Edit history.** Does a confirmed skill keep past versions? Recommendation:
   keep the last confirmed body for undo; defer full history.
