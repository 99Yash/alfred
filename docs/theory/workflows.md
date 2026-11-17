# The workflow class: one class, every workflow

Status: settled, 2026-11-17. The owner direction dated 2026-11-16 is from this page's first discussion; the direction dated 2026-11-14 is from the core-agent grill and the workflow-use research decisions; the owner word dated 2026-11-17 settles the two §4 mechanics.

Read first: [core-agent.md](./core-agent.md) (one runner, destination on the revision), [ADR-0017](../decisions/ADR-0017-skills-workflows-skills-are-markdown-workflows.md) (trigger + brief + optional step DAG), [ADR-0025](../decisions/ADR-0025-built-in-background-workflows.md) (built-ins in the same table), [ADR-0027](../decisions/ADR-0027-workflow-trigger-dispatch-generic-workflows.md) (occurrence dispatch), [workflows-v1.md](../plans/workflows-v1.md) (draft → revision → activation), and [workflow-use-2026-11-14.md](../research/workflow-use-2026-11-14.md) (owner decisions on replay and the rewrite).

---

## 1. The job

**Every workflow of Alfred is one class: the built-in defaults (email triage, todos, morning briefing, evening recap, reply drafting, meeting prep), the implicit system workflows (memory extraction), and the user-authored ones. Who wrote the workflow is metadata on the row, not a different class.** Owner direction, 2026-11-16. This settles, at the level of representation, the sentence in [core-agent.md §1](./core-agent.md#1-the-job): "everything Alfred does is a workflow on one engine."

The worst error this page guards against is the drift core-agent.md names as worst error 4 — two loops doing the same job differently. Today there are two workflow realities sharing one table: built-ins run as code state machines with no definition attribution, user workflows run as briefs over immutable revisions. The class exists so that history, settings, and the runner see one thing.

## 2. The class: five parameters

A workflow is a row that names five things. Provenance is not one of them.

| Parameter | What it holds | Settled by |
| --- | --- | --- |
| Trigger | cron, an event source, or manual | ADR-0017, ADR-0027 |
| Definition artifact | brief prose, a code-referenced spine, or system prompts + gates | this page (below) |
| Engine | the one runner | core-agent.md §2 |
| Destination | fixed at save; an internal store is a legal destination | core-agent.md §3 |
| Approval floor | per external effect; follows from the destination, not the kind | ADR-0069 |

Rules:

- **The class does not force one artifact format.** Triage is a spine with code-owned guarantees (dedup keys, floors, priors); flattening it into prose would trade guarantees for uniformity — that is worst error 5 (the core and the edge swap places). The class holds a *reference* to the artifact; the artifact differs by kind.
- **An internal destination is a full member.** Memory extraction's destination is the claims store. Nothing about it needs a special case: it has a trigger, an artifact, the runner, a destination, and no approval floor because it has no external effects.
- **The runner is not the class.** The runner is what executes a row; chat turns are runs of the runner and not rows (no trigger, no user-visible definition). The code already draws this line: internal slugs start `__` and are never seeded (`registry.ts`).

## 3. The three provenances

| Kind | Born | Activation | Settings |
| --- | --- | --- | --- |
| `builtin` (default) | authored in code, registered at boot, seeded per user at deploy | active at seed; the user may pause | shown, toggleable |
| `implicit` | authored in code like a built-in | system-owned; never paused, never user-toggled | never shown |
| `user` | chat draft | explicit high-risk approval card on an exact revision | shown, full control |

Two columns of metadata on the row carry this (`origin`, `activation`). Memory extraction is the proof the class is complete: it is a workflow whose only difference is metadata — and the owner's condition, 2026-11-16, is that it counts only **if it fits the definition completely**. It does: trigger (cron + events), artifact (extraction prompts behind deterministic gates, ADR-0079/0123), runner, internal destination, no external effects.

## 4. The lifecycle

One lifecycle for every row; the kinds differ only in who acts at each step.

| Step | builtin | implicit | user |
| --- | --- | --- | --- |
| Born | seeded at deploy | seeded at deploy | chat draft (workflows-v1) |
| Definition change | next deploy seeds the new fields | next deploy | a new immutable revision; the published one keeps running |
| Activation | active at seed | always on | approval card on the exact revision |
| Run | trigger → one durable occurrence claim → runner → typed outcome | same | same |
| Pause | user toggle | never | user toggle |
| Retire | seeder retires the slug | n/a | archive |

The owner reads theory, not code. One fact from the code belongs in the theory because it *is* the gap: **built-ins and implicit workflows run with no definition reference** (`tick.ts` dispatches built-ins with `revisionId: null`), and cron built-ins bypass the generic dispatch entirely (`briefing.tick`, `memory.extract.daily` run them; `workflows.tick` skips them). Settled, owner word 2026-11-17:

- **Every run names its definition.** A built-in revision is a code-referenced definition — its content hash is the registered module and prompt version, seeded at deploy like the row is today. This deletes the `revisionId: null` special case instead of adding a rule around it, and gives one History tab that does not care who wrote the workflow.
- **One dispatch path.** Every trigger — a webhook, a cron line, a chat draft — claims its occurrence through the ADR-0027 path. A module that owns its own tick today moves behind the trigger table; the trigger row, not module code, decides when a run happens.

## 5. What the model owns, and what code owns

| Question | Owner |
| --- | --- |
| Judgment inside a run, at the edges of the spine | Model |
| That every run is attributable to one definition | Code |
| That an implicit workflow has no toggle and no pause | Code |
| That settings shows what the user controls and hides what they do not | Code |
| That a run posts only to its destination, fixed at save | Code (core-agent.md §6) |
| Which user workflows exist | Model proposes, the user approves (workflows-v1) |

## 6. What the builder owes the owner

Owner direction, 2026-11-16: the owner reads the theory of the software, not the code; the theory pages are the owner's window into it. A mechanism whose purpose is not visible from its name — above all security and credential handling: gateway tokens, webhook verification, allowlists, redaction — carries a comment at its owner file that names the threat it prevents and gives one concrete example of the failure it stops. The comment is for the owner reading a pointed file, not for the reviewer. This page records the expectation; the per-area reference docs hold it for their areas when they next change.

## 7. Not in this class

- **Chat turns** are runs of the runner, not workflows: no trigger, no user-visible definition. core-agent.md owns them.
- **Plumbing jobs** — a dedup sweep, a sender extraction, a recovery navigation — have no trigger a person could name and no destination a person could name. They are jobs, not workflows. The line: *if it has a trigger and a destination a person could name, it is a workflow; otherwise it is a job.*

## 8. Theory state and code state

| Part | Theory | Code | The gap today |
| --- | --- | --- | --- |
| One class, five parameters, provenance as metadata | Settled as direction (owner, 2026-11-16) | Not built | Two execution realities behind one table |
| Implicit workflows in the class, no toggle | Settled (owner, 2026-11-16, conditional on fitting completely) | Not built | Memory extraction is a system process with no definition reference |
| Built-in and implicit runs name their definition (code-hash revisions) | Settled (owner, 2026-11-17) | Not built | `revisionId: null` on every built-in run |
| One dispatch path for every trigger | Settled (owner, 2026-11-17) | Not built | `briefing.tick` and `memory.extract.daily` bypass `workflows.tick` |
| The user lifecycle (draft → revision → activation → run) | Settled (workflows-v1) | Built | — |
| The runner and the destination on the revision | Settled (core-agent.md) | Not built | #535 first |

## 9. Order of work

Nothing queues behind this page today. It sits settled next to core-agent.md, and the order follows core-agent.md §8:

1. **Code Mode (#535)** — the read path; nothing above it builds without it.
2. **The runner** — with the destination on the revision.
3. **The workflow class mechanics** — built-in and implicit revisions close `revisionId: null`; the trigger table absorbs the module-owned ticks; `origin`/`activation` metadata lands with the settings surface. This is the rewrite that closes the MCP activation gap (owner, 2026-11-14), and the workflow-use decisions carry over unchanged: on deviation, fall back to the boss harness; a compiled revision gets a fresh approval card; a workflow may use every connection the user has, under the approval rules that already exist.
4. **The settings surface** — three provenances render from metadata; implicit rows never appear.

## 10. Not settled

- **Do chat-visible workflow kinds need names?** The settings page may say "Alfred's workflows" and "Yours" instead of exposing `builtin`/`user`. A wording question, parked until the surface is built.
- **Whether the eight-seeded-rows reality changes.** The seed plan seeds public slugs only and retires dead ones; whether implicit slugs join the seeded set or stay unseeded rows is a mechanics question for §9 step 3.
