# The Boss Worker Harness

Most AI apps begin as a chat box.

You type. The model answers. The moment ends.

Alfred is trying to become something different: a personal assistant that keeps working when the window is closed. It reads new mail. It prepares briefings. It asks before taking risky actions. It can break a task into smaller investigations. It remembers enough state to resume after a deploy.

That required a different center of gravity.

Not a bigger prompt.

A harness.

## The Shape

At the heart of Alfred is a durable run.

A run is stored in Postgres. It has a workflow slug, state, transcript, current step, trigger, status, and cost attribution. A BullMQ worker claims one step at a time. After each step, the state is committed. If the process dies, another worker can resume from the last checkpoint.

For user-authored workflows, the shape is intentionally simple:

`boss-turn` calls the model once.

`dispatch-tools` executes the tool calls, records results, and either loops back to the boss or parks the run for human approval.

Then it repeats.

That ping-pong matters. The model does not own the loop. The runtime does.

That means Alfred can checkpoint between turns, meter each model call, stage outbound effects, pause for approval, compact long transcripts, and recover after a worker crash without pretending the model is an operating system.

## The Boss

The boss is the planning agent.

It sees the brief. It chooses tools. It decides whether to answer directly or delegate a focused investigation. It reads results and turns them into the final message.

Tools are not loose strings. They are registered actions with schemas, risk tiers, policy rules, and integration boundaries. A tool call is routed through the dispatcher, which validates input, enforces allowed integrations, resolves autonomy versus gated mode, writes an audit row, then executes or stages.

That gives Alfred a product property most prototypes lack: the same tool path can serve chat, workflows, approvals, smokes, and future agent-executable todos.

One harness. Many surfaces.

## The Worker

The worker is what makes the boss dependable.

It heartbeats while a step runs. It re-enqueues immediately when a run advances. It sweeps for stale runs left behind by deploys or crashes. It snapshots scratchpad state when a run completes.

This is not glamorous code, but it is the difference between a demo and an assistant.

We saw that clearly during the chat latency investigation. A run that looked like "the model is slow" was not slow because of the model. The model calls totaled 8.5 seconds. The six-minute wait came from orchestration gaps: loop re-entry reused the same step attempt number, collided with the unique step key, and waited for stale-lease recovery.

The fix was small. The effect was product-level. Make step attempts monotonic, and the next step can run now instead of waiting for the sweep.

That is why the harness exists. It gives us places to see the truth.

## The Scratchpad

Delegation needs memory, but not all memory should be trusted equally.

Alfred uses a namespaced scratchpad. Sub-agents write to their own `scratch.<subId>.*` space. The boss can read those findings and promote selected pieces to `shared.*`.

That promotion is the validation moment.

It keeps the cost shape sane. Sub-agents do not need the boss to retype every finding into durable state. The runtime persists their outputs. But it also keeps the correctness shape sane. Downstream agents know `scratch.*` is advisory. `shared.*` is boss-approved.

Redis holds the live scratchpad during the run. Postgres receives a terminal snapshot for audit and replay.

Fast while working. Durable when done.

## The Human Gate

An assistant connected to email and calendar should be useful before it is fully trusted.

So Alfred separates suggestion from action.

A todo suggestion can be created autonomously. It has no real-world side effect.

Sending an email, creating an event, or touching an external system goes through action staging when policy says it should. The run parks. The approval card appears. The user can approve, edit, reject, or reject and end the run. If the same rejected action is proposed again, the dispatcher suppresses the retry and returns a structured rejection to the boss.

The model does not get to nag its way past a boundary.

The boundary is code.

## The Larger Vision

The harness is the reason Alfred can treat the app as one assistant instead of several features.

Email tagging is a background workflow.

Todo suggestions are a passive materialization of open loops.

Briefings are a timed render of the day.

Meeting prep can become a gather-and-compose run.

Agent-executable todos can later become runs with approvals, progress, interruptions, and completion reflected back on the checkbox.

These do not need separate agent runtimes. They need different briefs, triggers, policies, and surfaces over the same durable substrate.

That is the real product bet.

The assistant should feel quiet. It should do the work that is safe to do, ask before the work that matters, and leave a trace when it makes a judgment.

The chat box is only one doorway.

The worker is what keeps the lights on.

## Source Notes

- Core docs: `decisions.md` ADR-0006, ADR-0014, ADR-0016, ADR-0026, ADR-0034, ADR-0035, ADR-0036, ADR-0040; `docs/plans/m13-plan.md`; `docs/plans/chat-latency-and-github-tools.md`.
- Implementation paths: `packages/api/src/modules/agent/worker.ts`, `packages/api/src/modules/agent/executor.ts`, `packages/api/src/modules/agent/workflows/user-authored-brief.ts`, `packages/api/src/modules/dispatch/index.ts`, `packages/api/src/modules/scratchpad`.
- Dev/prod investigation note: the PR-count chat run showed 8.5s total model latency inside roughly 6 minutes wall-clock before the orchestration fix, proving the bottleneck was step scheduling, not model speed.
- Dev DB aggregate checked 2026-06-09: completed runs include 389 `email-triage`, 43 `__chat-turn__`, 28 `memory-extraction`, 12 `morning-briefing`, and 2 `smoke-boss`.
