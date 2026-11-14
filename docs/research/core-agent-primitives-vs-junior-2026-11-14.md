# Core agent: what Alfred has, what Junior shows, what is missing

Status: research input, 2026-11-14. Nothing here is settled. The owner must settle the questions in section 4 before anyone builds.

Sources: [sentry-junior-2026-11-14.md](./sentry-junior-2026-11-14.md) (Junior at `cff5c657`, read-only) and an inventory of the Alfred code, schemas, and ADRs on 2026-11-14. Paths that start with `A/` are under `packages/assistant/src/`.

## The question

The owner wants one core Alfred agent with the foundational capabilities. It sits behind more than one surface: the web chat today, and perhaps Slack later. When the user tags it in chat, it can, for example, create a workflow and see it through. Triage and briefings are not part of the core. The rule: build on the primitives that exist, and invent nothing that a primitive already covers.

## 1. The short answer

Most of the core exists. Three gaps block it, and one gap breaks workflows today.

- **It exists.** One durable executor runs every agent workflow (`A/execution/executor.ts:245`). One tool runtime is built for each run from an identity, not from a transport (`A/execution/tool-surface.ts:258`). Risk tiers, action policies, and approvals do not depend on the surface (`A/execution/staged-action.ts:93`). Chat can already author a recurring workflow, the user approves its activation, and a tick each minute runs it (`A/automation/authoring.ts:40`, `A/automation/tick.ts:40`). This is the same shape as Junior's `createAutomation`.
- **Gap 1: a run does not know its surface.** `chat_threads` has no surface or channel column (`packages/db/src/schema/chat.ts:55`). Delivery is the outbox, then SSE, then a Replicache poke (`A/chat/chat-turn-closure.ts:225`).
- **Gap 2: Alfred cannot deliver outside a turn.** `notify()` sends email only (`A/delivery/notify.ts:47`). A workflow result is visible only on the web History tab. No notification kind carries a result (`packages/db/src/schema/notifications.ts:7`).
- **Gap 3: the core is two loops.** The chat turn (`A/chat/chat-turn.ts:917`, streaming, `CHAT_SYSTEM_PROMPT_BASE`) and the background boss (`A/execution/workflows/user-authored-brief.ts:562`, `BOSS_SYSTEM_PROMPT_BASE`) have two prompts and two model calls. Junior has one `executeAgentRun` for every source.
- **It is broken now: a workflow that needs MCP cannot activate.** GitHub and Google reads go through MCP only (ADR-0125, ADR-0126). The allowlist gate refuses `mcp` (`A/tool-runtime/internal/registry.ts:390`). Thus "every Monday, summarize my PRs" saves a draft and never runs. The owner accepted this on 2026-11-13, because the workflow surface will be rewritten.

## 2. Junior's parts, mapped to Alfred's primitives

| Junior part | Alfred primitive that covers it | State | What it needs |
| --- | --- | --- | --- |
| `AgentRun` with typed Source and Destination | `ToolRunIdentity` has `caller` and `interaction: live_chat \| background` | Partly | A destination on the run, and a binding from a surface thread to `chat_threads` |
| Store first, the queue only wakes | `agent_runs` and `agent_steps` checkpoints, BullMQ transport (ADR-0006, ADR-0014) | Built | Nothing |
| Turn, Run, slice; resume after a pause | Durable steps, approval wake, `ask_user` wake (ADR-0099) | Built | Nothing |
| One core loop for every source | Two loops: chat turn and background boss | Partly | One runner, one charter, with the surface as a parameter |
| Surface adapters (Slack webhook in, Slack post out) | Inbound ingress registry (ADR-0097), `resolveOwner` hook | In: built for GitHub only. Out: not built | A Slack descriptor, and an outbound delivery adapter |
| `createAutomation` from chat | `system.author_workflow` then `system.activate_workflow` (high tier, approval card) | Built | The MCP activation fix |
| Automation outcomes fixed at save; a run cannot pick where it posts | `workflow_revisions` are immutable and hold `allowed_tools` | Partly | A destination stored on the revision |
| Versioned automations | `workflow_revisions` | Built | Nothing |
| Deferred tool discovery | `system.search_tools`, `system.load_tool`, carry-over | Built | Nothing |
| Code Mode | ADR-0087, ADR-0116, ADR-0124 | Not built (#535) | The build. The triage gather and the memory check job need it too |
| Skills (`$skill-name`) | `skills`, `skill_revisions`; `parseMentions` exists | Partly: never loaded in a run | A loader in the runner |
| Cache-stable prompt, per-turn facts in a message | Run grounding snapshot, `assertStableChatSystem`, time in a runtime message | Built | Nothing |
| Answer tools: `reply`, `noReply`, `reportBlocked` | None. A turn ends when the model stops | Not built | A decision: is silence an explicit act? |
| Budgets: USD and tool-call caps | Step caps of 40 and 60 (`turn-budgets.ts`) | Partly | A decision |
| Guardian: a model reviews risky calls | Code decides: risk tier and action policy (`A/tool-runtime/approval-rule.ts:18`) | Different by design | Keep code. Principle 4 gives guarantees to code |
| "Ask" with no person becomes deny | `requiresLiveChat` refuses `ask_user` in the background | Built, harsher | A decision, once a surface can carry the question |
| Credentials at an egress proxy | Tools get lazy clients through `ctx.integrations` and never see a token | Built, other shape | Nothing for one user |
| Team visibility, email domains, shared memory | One user, `ALFRED_ALLOWED_EMAIL` | Not needed | Nothing |

## 3. What this shows

- **The surface is a destination, not a new agent.** Junior's seam is a value on the run: where the input came from, and where the outcome goes. Alfred's runner is already keyed by `userId` and run identity. Thus a Slack surface is an ingress descriptor, a thread binding, and a delivery adapter. It is not a second agent.
- **A surface that Alfred can post to is the push surface.** Three theory items wait for it: a journal remark outside a turn ([journal.md §9](../theory/journal.md#9-not-settled)), asks ([README stage table](../theory/README.md#3-the-user-lifecycle)), and the result of a workflow. One outbound adapter with notification kinds settles the mechanism for all three. ADR-0020's `notification_preferences.channels` was the planned home, and it was never built.
- **The two loops are the real core work.** A "core agent" is one runner with one charter, and with the surface, the interaction kind, and the budget as parameters. Today the charter names web parts ("side panel", "approval card") at `A/chat/chat-turn.ts:159-175`.
- **Code Mode is the shared blocker.** The triage gather, the memory check job, chat reads (ADR-0124), and the evidence map of the probe table all need it.

## 4. Questions for the owner

1. **One runner.** Join the chat turn and the background boss into one runner, with the surface and the interaction as parameters? Or keep two loops and share only the charter?
2. **The destination of a run.** Is a destination a value on each run, as in Junior? Is it fixed on the workflow revision at save, so a run cannot choose where it posts?
3. **The thread binding.** Does a Slack thread map to a `chat_threads` row through a new column, or through a binding table? One user can have many surfaces.
4. **The push surface.** Is the first outbound surface Slack, the web, or the existing email? Do journal remarks, asks, and workflow results share it?
5. **Silence as an act.** Does a turn or a workflow run end with an explicit "no reply", as Junior's `noReply` does? This fits "the default verdict is silence" in the journal theory.
6. **A question with no person present.** In a background run, does `ask_user` become a deny (Junior), or does it park and ask through the surface?
7. **Workflows that need MCP.** Is the workflow rewrite the next step, so that the MCP activation gap closes?
8. **Budgets.** Keep step caps, or move to cost and tool-call caps with a wrap-up step?

## 5. A possible order, not settled

1. Code Mode (#535). Many settled theories wait for it.
2. One runner, with a destination on the run.
3. One outbound delivery adapter with notification kinds. This is the push surface.
4. The workflow rewrite: a destination on the revision, and MCP steps that can activate.
5. The Slack surface: an ingress descriptor, the owner mapping in `resolveOwner`, the thread binding, and delivery through step 3.
