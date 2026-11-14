# Research: Sentry's Junior, a Slack agent runtime

**Status:** done, 2026-11-14. Read-only study of the primary source.
**Source:** `https://github.com/getsentry/junior` at commit `cff5c6579beabe0d5c97e44213419ff01f2af6d8` (2026-11-14). Every `path:line` below is at that SHA.
**Method:** shallow clone into `/tmp`. Files read only. Nothing installed, built, or run. No secondary sources used.

## The question

The owner wants one "core agent" that sits behind several surfaces, for example a Slack bot. It must have the foundational capabilities. It must be able to, for example, create a workflow when someone tags it in chat. What does Junior do, how is it built, and what is worth borrowing?

## 1. What Junior is and how a message moves

### 1.1 Job and surfaces

- Junior is "a Slack bot runtime powered by Hono" (`README.md:5`). Its job is to investigate issues, summarize context, and take action from Slack with connected tools (`README.md:7`).
- `@sentry/junior` is the "Core agent, Slack, and ACP runtime" (`README.md:25`). Plugins are separate packages (`README.md:26-46`).
- An app is a small Hono app built with Nitro. `createApp()` owns the routes (`packages/docs/src/content/docs/start-here/overview.md:19`).
- Surfaces that reach the agent:
  - Slack webhook at `/api/webhooks/slack` (`packages/junior/src/app.ts:893`).
  - ACP v1 (Agent Client Protocol) over Streamable HTTP at `/api/acp` (`packages/docs/src/content/docs/reference/handler-surface.md:32-40`).
  - A remote MCP server at `/api/mcp`, with tools such as `send-message` and `create-conversation` (`handler-surface.md:42-46`; `packages/junior/src/api/mcp/tools/`).
  - A web dashboard that can send messages (`webSourceSchema`, `packages/junior-plugin-api/src/schemas.ts:113`).
  - A local CLI chat (`localSourceSchema`, `schemas.ts:104`; `packages/junior/src/chat/local/runner.ts`).
- Non-person inputs also start work: events, scheduled automations, event automations, plugin dispatch, and agent invocations (`packages/junior/src/chat/source.ts:36-40`; `TERMINOLOGY.md:30-32`).

### 1.2 Inbound path

1. Slack posts an event. `handleSlackWebhook` persists the message and enqueues durable conversation work (`packages/junior/src/chat/ingress/slack-webhook.ts:819-820`). `waitUntil` only extends the request (`slack-webhook.ts:132-133`).
2. A DM or a mention is a `new_mention`. A message in a thread that Junior already joined is a `subscribed_message` (`packages/junior/src/chat/ingress/message-router.ts:63-80`).
3. Work is stored before it runs. Queue messages only wake a worker. Stored state is the source of truth (`packages/docs/src/content/docs/concepts/execution-model.md:14-25`).
4. The queue is Vercel Queues by default, or BullMQ on Redis (`packages/junior/src/chat/queue/config.ts:4-6`, `:31`). BullMQ is "for local development only" (`packages/junior/src/chat/queue/bullmq.ts:214`).
5. The queue calls back `/api/internal/agent/continue` (`app.ts:845`). Workers per kind are built in `createConversationWork` (`packages/junior/src/chat/app/conversation-work.ts:76-169`).
6. Only one worker owns a conversation at a time (`execution-model.md:31`). The active lock has a 90 s TTL (`packages/junior/src/chat/state/locks.ts:4`).
7. A completed reply returns to the original destination (`execution-model.md:22`). Only a root conversation delivers to its Location. A child returns output to its parent (`TERMINOLOGY.md:38-40`).

### 1.3 The seam between core and surface

- The seam is the `AgentRun` value and the `AgentRunner` interface: `run(run: AgentRun): Promise<AgentRunOutcome>` (`packages/junior/src/chat/runtime/agent-runner.ts:14-21`).
- `executeAgentRun` is the core loop. It needs a destination and nothing else from Slack (`packages/junior/src/chat/agent/index.ts:232-245`).
- Each input carries a typed `Source` (`slack`, `web`, `local`, `event`, automation, dispatch). Output goes to a typed `Destination` (`schemas.ts:78-81`, `:92-123`).
- Delivery is Slack-shaped in practice. `createConversationWork` builds a `SlackRuntime`. A Slack destination uses the Slack worker (`conversation-work.ts:86-97`, `:170-172`). `destinationSchema` has only `slack` and `local` variants (`schemas.ts:78-81`).
- Verdict: the agent loop is separate from the surface. The delivery and automation layers are still Slack-first.

## 2. The agent loop

- Loop engine: `Agent` from `@earendil-works/pi-agent-core` (the "Pi" agent) (`packages/junior/package.json:78`; `agent/index.ts:1138`).
- Provider: Vercel AI Gateway. The API key resolves on each call. The gateway session id is the conversation id (`agent/index.ts:1139-1142`).
- Default models: `anthropic/claude-opus-5.5` at reasoning level `high`. Separate fast, Guardian, web-search, embedding, rerank, image, and vision models exist (`packages/junior/src/chat/config.ts:254-263`). `AI_MODEL` overrides the main model (`config.ts:311`).
- On a refusal, the rest of the run slice uses a fallback model (`agent/index.ts:1653-1665`).
- Tool calls: hooks `beforeToolCall` and `afterToolCall` wrap each call (`agent/index.ts:1155-1258`).
- Step limits: no fixed step count. A turn stops at 1,000 tool calls or USD 100 of model cost (`config.ts:26`, `:32`). Past a limit, the first blocked call asks the model to wrap up. A later call ends the turn (`agent/index.ts:1170-1222`).
- End of turn: an answer tool (`reply`, `noReply`, `reportBlocked`) ends the run (`agent/index.ts:1241-1246`; `TERMINOLOGY.md:90-92`).
- Steering: new messages join the active turn at the next safe boundary (`steeringMode: "all"`, `agent/index.ts:1154`, `:999`).

### 2.1 System prompt

- The prompt is one ordered set of blocks. Each rule has one home (`policies/system-prompt.md:5-9`).
- Order: identity, working principles, context trust, safety, tool and skill policy, output, then `SOUL.md` (voice), `WORLD.md` (operator facts), and plugin guidance (`policies/system-prompt.md:30-52`).
- Core rules win over `SOUL.md`, `WORLD.md`, and plugin text (`policies/system-prompt.md:52`).
- Three parts: the system prompt, a user-role context message with `<runtime-turn-context>`, and the current instruction as its own user message (`policies/system-prompt.md:15-19`).
- Cache rule: the system prompt is the same for every turn of one deployment, platform, and prompt mode. Per-request facts go in the context message (`policies/system-prompt.md:70-76`).
- Prompt changes are measured with evals, not string tests (`policies/system-prompt.md:91-92`).

### 2.2 Long-running work

- A **Turn** can span several **Runs**. A Run is one bounded attempt. An **execution slice** is one serverless invocation (`TERMINOLOGY.md:89-96`).
- Defaults: 12 min turn timeout and 300 s function duration (`config.ts:19`, `:53`).
- Completed tool work is saved. A turn resumes after an OAuth pause, a time limit, a worker crash, or a failed delivery (`execution-model.md:37-44`).
- The written policy: store state first, send small signed envelopes, slice long work, add leases, and recover stale states (`policies/serverless-background-work.md:11-24`).
- Subagents: `spawnAgent` creates child conversations of kind `thread` or `task` (`packages/junior/src/chat/tools/registry.ts:215`; `TERMINOLOGY.md:15-25`, `:111-119`).
- History compaction runs in the background after a model call passes a size mark (`agent/index.ts:928-932`).

## 3. Tools and capabilities

- Core tools live in one static registry in provider order. Gates read only platform, turn tools, and deployment config (`packages/junior/src/chat/tools/registry.ts:1-13`).
- Examples: `bash` (`registry.ts:155`), `createAutomation` (`registry.ts:172`), `spawnAgent` (`registry.ts:215`), Slack-only tools such as `slackChannelJoin` (`registry.ts:261`).
- Each tool declares `description`, `inputSchema`, optional `outputSchema`, `exposure`, and approval metadata (`packages/junior/src/chat/tools/definition.ts:38-80`).
- Exposure has five values: `direct`, `deferred`, `modelOnly`, `codemode`, `hidden` (`packages/junior-plugin-api/src/tools.ts:431-447`). Deferred tools are found with `searchTools` and run with `executeTool` (`openspec/changes/deferred-tool-discovery/proposal.md:11-20`).
- Code Mode: the model writes a script that calls `tools.<name>(args)`. Each nested call takes the normal tool path (`packages/junior/src/chat/codemode/tool.ts:1-9`).
- Skills: `SKILL.md` playbooks in `app/skills/` or in plugins. A user can invoke one with `$skill-name`. Skills grant no access (`packages/docs/src/content/docs/concepts/skills-and-plugins.md:27-39`).
- Plugins: loaded only from explicit app config (`skills-and-plugins.md:43-51`). A plugin is either a `plugin.yaml` package or `defineJuniorPlugin()` (`packages/junior-plugin-api/src/registration.ts:47-61`).
- A YAML plugin can wrap a remote MCP server with an allow-list of tools (`packages/junior-amplitude/plugin.yaml:9-50`).
- Code plugins get hooks: `systemPrompt`, `userPrompt`, `beforeToolExecute`, `afterToolExecute`, `issueCredential`, `heartbeat`, `routes`, `sandboxPrepare`, `tools`, and more (`packages/junior-plugin-api/src/hooks.ts:94-208`).
- MCP tools are activated per turn, with provider-prefixed names (`packages/junior/src/chat/mcp/tool-manager.ts:2-8`).
- Rule: core owns runtime and provider-neutral contracts. Plugins own provider routes, fields, permissions, and errors (`AGENTS.md:18-19`).

## 4. Permissions and boundaries

- Who can invoke: an operator can limit Slack authors to allowed email domains. Allowed bot user ids skip the check. With no list, every author may start a turn (`packages/junior/src/chat/ingress/slack-allowed-domain.ts:14-26`).
- Identity: the current user drives the turn. Thread history and channel membership grant nothing (`packages/docs/src/content/docs/concepts/security-and-authority.md:18-24`).
- Context binding: the harness owns actor, destination, conversation, and sandbox target. Model schemas do not accept target overrides (`policies/security.md:55-59`).
- Visibility is the only boundary between conversations. A private conversation is isolated from all others (`packages/docs/src/content/docs/concepts/data-and-privacy.md:36-43`).
- Per-channel settings: a `location_configurations` table stores user-authored key/value config per Location (`packages/junior/src/db/schema/location-configurations.ts:5-17`).

### 4.1 Approval before risky actions ("Guardian")

- A separate model, Guardian, reviews an exact action just before it runs. It returns allow, ask, or deny (`security-and-authority.md:28-40`).
- If review is unavailable, the action stays blocked (`security-and-authority.md:38`).
- Approval modes are `auto`, `review`, and `approve` (`packages/junior-plugin-api/src/tools.ts:374`).
- An `auto` tool skips review only if it is `readOnlyHint: true` and not destructive. Missing annotations count as unknown risk (`packages/junior/src/chat/guardian/gate.ts:185-199`).
- Core tools skip review unless they opt in. Plugin tools default to `auto` (`gate.ts:428-431`).
- When no person can confirm (for example, an automation run), an "ask" becomes a deny (`packages/junior/src/chat/guardian/reviewer.ts:131-137`).
- What `approve` does at run time: not verified.

### 4.2 Sandbox and secrets

- User-influenced commands run in an isolated sandbox. Long-lived secrets stay on the host (`policies/security.md:16-21`).
- Providers: Vercel Sandbox or Docker, chosen by `JUNIOR_SANDBOX_PROVIDER` (`packages/junior/src/chat/sandbox/provider.ts:18-23`, `:77-79`).
- Credentials are added at a host egress proxy, only for domains a plugin registered. Tool env vars hold placeholders (`policies/security.md:41-51`; `concepts/credentials-and-oauth.md:18-23`).
- Egress needs a Vercel OIDC token and a token that Junior signed (`policies/security.md:31-33`).
- Redis holds only ciphertext for credentials. Keys stay in the app environment (`policies/security.md:26-28`).
- OAuth links are private, short-lived, single-use, and bound to user, provider, and conversation. The blocked turn resumes after the grant (`credentials-and-oauth.md:33-39`).
- A lint rule blocks secret env reads outside the secrets module (`ast-grep/rules/no-secret-env-reads-outside-secrets-module.yml`).

## 5. Memory and state

- **Conversation** is the durable unit of work. In Slack, one conversation usually maps to one thread (`packages/docs/src/content/docs/concepts/conversations.md:14`).
- Storage: Postgres through Drizzle (`packages/junior/src/db/schema/`), 108 migrations (`packages/junior/migrations/`). Redis holds queue and runtime state and the turn checkpoint (`deploy-to-vercel.md:89-91`; `TERMINOLOGY.md:95-96`).
- `junior_conversations` holds source, location, destination, actor, execution status, run id, checkpoint time, and parent (`packages/junior/src/db/schema/conversations.ts:26-75`).
- `junior_conversation_events` is an append log: `(conversation_id, seq, history_version, idempotency_key, type, payload)` (`packages/junior/src/db/schema/conversation-events.ts:33-42`).
- Agent history items are `user_message`, `assistant_message`, and `tool_result` (`TERMINOLOGY.md:98-101`).
- A compaction writes a new history version. The Slack transcript stays the same (`conversations.md:20`; `TERMINOLOGY.md:100-101`).
- Thread context: follow-ups stay in the same conversation. Junior reads only the current thread, loaded skills, files, and tool results (`conversations.md:24-44`).
- Other stored kinds: Briefs (versioned intent, outcome, decisions, facts), Conversation notes, embeddings for search (`TERMINOLOGY.md:26-27`, `:43-44`; `db/schema/conversation-embeddings.ts:34`).
- Long-term memory is a plugin, `@sentry/junior-memory`. It uses pgvector with hybrid semantic and full-text recall before each user turn. It extracts memories from completed public sessions (`packages/docs/src/content/docs/extend/memory-plugin.md:13-21`).
- All memories are public. Private conversations recall but never store (`memory-plugin.md:15`).

## 6. Scheduled and recurring work from chat

Yes. This is a first-class, built-in feature.

- An **Automation** is a saved instruction with a creator, trigger, instruction, and ordered outcomes (`TERMINOLOGY.md:64-70`).
- Two kinds: scheduled ("every Monday at 9am…") and event ("when ACME-42 closes…") (`packages/docs/src/content/docs/concepts/automations.md:18-21`, `:27-32`, `:47-53`).
- A user asks in Slack. The model calls `createAutomation` (`packages/junior/src/chat/automations/tools/create.ts:193-216`).
- `createAutomation` is a deferred tool in `review` mode, so Guardian checks it (`create.ts:206-208`).
- Inputs: `instruction` or `skill`, optional `context`, `title`, `trigger` (`schedule` or `event`), up to 5 `outcomes`, and `credential_mode` (`creator` or `system`) (`create.ts:218-252`).
- Other tools: `searchAutomations`, `updateAutomation`, `deleteAutomation`, `runAutomationNow` (`tools/registry.ts:172-176`).
- Storage: `junior_automations` with kind, Slack team and channel, creator, status, instruction or skill, `next_run_at_ms`, and event filters (`packages/junior/src/db/schema/automations.ts:24-51`). Each edit writes a row to `junior_automation_versions` (`db/schema/automation-versions.ts:13-22`).
- Execution: a Vercel cron calls `/api/internal/heartbeat` every minute (`packages/junior/src/deployment.ts:5`; `packages/junior/src/nitro.ts:169-177`). It settles finished runs and enqueues a bounded batch of due automations (`packages/junior/src/chat/scheduled-automations/heartbeat.ts:270-274`).
- Calendar math is time-zone aware and handles DST gaps and folds (`scheduled-automations/cadence.ts:155-156`, `:325-326`, `:404-405`).
- A run ends with one result: Message, No action, or Misconfigured. A run cannot pick its own channel (`automations.md:78-86`).
- Runs use Junior's credentials by default. The creator's account is used only when delegated to that exact automation (`automations.md:90-97`; `credentials-and-oauth.md:27-29`).
- Event automations are rate-limited to 10 runs per rolling minute by default (`automations.md:72`).
- Event content is data, not a user instruction (`automations.md:96`).
- Eval: a reminder request must call `createAutomation` once. The saved instruction must say "Automation creator", not "me" (`packages/junior-evals/evals/scheduler/creation.eval.ts:6-23`).
- A **Watch** is a separate, temporary link that delivers matching events to one conversation (`TERMINOLOGY.md:73-74`).

## 7. Observability and evals

- Telemetry goes to Sentry (`@sentry/node`, `packages/junior/package.json:87`). Names are fixed in `TELEMETRY.md` (`AGENTS.md:64`).
- Key spans: `chat.turn`, `gen_ai.invoke_agent`, `gen_ai.execute_tool`, `queue.process` (`packages/docs/src/content/docs/operate/observability.md:22-29`).
- Key events: `agent.turn.failed`, `agent.turn.timed_out`, `conversation.work.failed` (`observability.md:14-20`).
- Logs and traces carry safe ids, counts, and error classes. No prompts, bodies, or tokens (`data-and-privacy.md:51`).
- A dashboard package shows conversations, people, automations, and system state (`packages/junior-dashboard/`).
- Test policy: integration tests through real wiring, fake only Slack and LLMs. Evals for agent interpretation. Telemetry is not a test oracle (`AGENTS.md:34-40`).
- Four eval suites (`policies/evals.md:12-21`):
  - **integration**: hard pass/fail full-runtime behavior.
  - **behavioral**: rubric-judged, CI needs 80% pass.
  - **guardian**: exact allow/ask/deny decisions.
  - **classifiers**: exact choices of a decision model.
- Assert behavior, not wording. The rubric sees only user-visible text (`policies/evals.md:40-47`).
- Each suite has its own CI workflow (`.github/workflows/evals-*.yml`).
- Many `ast-grep` rules enforce architecture, for example no direct core model calls and no raw Slack posts from a turn (`ast-grep/rules/`).

## 8. Deployment shape

- Runtime: Node, Hono, Nitro. Target host: Vercel (`overview.md:19`; `apps/example/vercel.json:1-4`).
- Needs: Postgres (`DATABASE_URL`, Neon or Vercel Postgres), Redis (`REDIS_URL`), Slack signing secret and bot token (`deploy-to-vercel.md:89-91`).
- Uses Vercel Queues, Vercel Sandbox, Vercel Blob, Vercel OIDC, and Vercel AI Gateway (`packages/junior/package.json:74-96`).
- Each deploy runs SQL migrations, builds a sandbox snapshot, then builds the app. `juniorNitro()` adds queue triggers and crons (`deploy-to-vercel.md:62-69`).
- Docker sandbox and BullMQ let it run off Vercel. That path is for local development (`queue/bullmq.ts:214`). A full non-Vercel production setup: not verified.
- Tenancy: one deployment is one Junior app with one Slack bot token (`deploy-to-vercel.md:89-91`). Multi-org hosting is not described. Treat it as single-tenant per company (inference, not verified).
- It is a library. A company runs `junior init` and owns its app (`overview.md:29`).

## 9. What to borrow and what is Sentry-specific

### 9.1 Worth borrowing

1. **A typed Source and Destination on every run.** The loop takes an `AgentRun` and a destination. Surfaces only build the run and deliver the outcome (`agent-runner.ts:14-21`; `schemas.ts:78-123`).
2. **Store first, queue wakes only.** The durable record is the truth. Queue messages carry ids (`execution-model.md:25`; `policies/serverless-background-work.md:11-14`).
3. **Turn, Run, slice vocabulary.** One request can survive pauses, OAuth, and crashes with the same identity (`TERMINOLOGY.md:89-96`).
4. **Answer tools end a turn.** `reply`, `noReply`, and `reportBlocked` make "say nothing" an explicit choice (`TERMINOLOGY.md:90-92`).
5. **Budgets instead of step counts.** A cost cap and a tool-call cap, with a wrap-up step first (`agent/index.ts:1170-1222`).
6. **Automations as data with versions.** A chat request calls one reviewed tool. The row has a trigger, instruction or skill, outcomes, and credential mode (`create.ts:206-252`; `db/schema/automations.ts:24-51`).
7. **The run cannot pick where it posts.** Outcomes are fixed at save time (`automations.md:78-86`).
8. **A risk gate driven by tool annotations.** Read-only and non-destructive skips review. Unknown counts as risky. "Ask" with no person becomes deny (`gate.ts:185-199`; `reviewer.ts:131-137`).
9. **Credentials at the egress proxy.** The model and sandbox never hold real tokens (`policies/security.md:41-51`).
10. **Ordered, cache-stable system prompt.** Static blocks first, per-request facts in a context message (`policies/system-prompt.md:30-76`).
11. **Deferred tool discovery and Code Mode.** Keeps the model tool list small as plugins grow (`tools.ts:431-447`; `codemode/tool.ts:1-9`).
12. **Eval suites split by kind of truth.** Hard pass/fail for fixed effects, rubric only for visible text (`policies/evals.md:12-47`).

### 9.2 Specific to Sentry's context

- Slack is the primary surface. Automations store a Slack team and channel (`db/schema/automations.ts:29-31`). Outcomes can only be Slack destinations (`schemas.ts:83-89`).
- Multi-user team concerns: public vs private channel visibility, Participants, allowed email domains, and Slack Connect handling (`data-and-privacy.md:36-43`; `slack-allowed-domain.ts:14-20`).
- Vercel is the assumed host for queue, sandbox, blob, OIDC, and model gateway (`package.json:74-96`).
- Plugin set: Sentry, GitHub, Linear, Datadog, PagerDuty, Hex, and similar engineering tools (`README.md:28-46`).
- Workspace snapshots, code changes, and repository previews target engineering teams (`TERMINOLOGY.md:7-14`).
- Memory is shared and public across the team (`memory-plugin.md:15`). A single-user assistant would scope it per person.
