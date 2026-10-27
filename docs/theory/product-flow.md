# Product flow: the verified theory

This document records how Alfred works as a product, flow by flow. The owner states a model. The code and production then confirm or correct it. Update a section in place when a flow changes. Do not add a changelog.

Each section has three parts: the owner's model, the verified model, and the known gaps. File references are relative to `packages/` unless a different root is given.

Last verified: 2026-10-20 at `fd13e6427`.

---

## 1. Cold start (research about the user)

**Owner's model.** After sign-in, Alfred researches the user from email and from each connected integration.

**Verified model.**

- Sign-in does not start research. The Google *integration* connect starts it (`http/src/connections/google-routes.ts:273-314`, then `publishGoogleCallbackCompleted`). This flow is separate from the Better Auth Google sign-in.
- The research is web-only. The inputs are the user name, the email address and its domain, and the credential label. Alfred does not read the mailbox or the calendar for this step. The search engine is grounded Gemini web search (`assistant/src/knowledge/web-search.ts:102`).
- Steps: gather-signals → seed → research-aspects → synthesis → extract-facts → persist (`assistant/src/knowledge/cold-start/cold-start-research.ts`).
- Writes: `user_facts` proposals (`source.kind='cold_start'`, auto-confirmed at confidence ≥ 0.85) and one `memory_chunks` row (`kind='cold_start_research'`).
- The run occurs one time for each user. `dedupKey: () => 'cold-start'` and `agent_runs_dedup_key_idx` block a second run.

**Where mail reaches memory instead.** The `memory-extraction` cron (03:00 daily, last 7 days, max 20 documents) and the 8-message `gmail.ingest_recent` triage that the Google connect also starts.

**Gaps.**

- A new integration (GitHub and others) does not start research.
- Gmail and Calendar content are not research inputs (planned v2.1, not built).
- Alfred cannot do the research again without a manual cancel of the old run.

---

## 2. Action items (todos)

**Owner's model.** Alfred mints action items from Gmail only. Extension to other integrations is necessary but adds duplicates.

**Verified model.** Partly correct.

| Producer | Trigger | Live |
| --- | --- | --- |
| Email triage, `suggestTodo` from the classify step (`assistant/src/triage/workflow-operations.ts:521-541`, decision in `triage/todo-decision.ts:73-121`) | `gmail.message_received` | Yes. The only automatic producer. |
| `system.suggest_todo` tool (`tool-runtime/internal/tools/system.ts:606`) | Chat, sub-agent, or user workflow, when the model calls it | Yes, on demand |
| User, in the UI (`http/src/sync/write/todos.ts:23`) | Replicache mutator | Yes |
| GitHub notifications poller (ADR-0052) | none | Not built |

**Deduplication today.** `suggestTodo` (`assistant/src/tasks/suggest.ts:51`) takes a per-user advisory lock and compares source refs `(provider, kind, id)` (`contracts/src/todos.ts:73`). A shared ref merges into the live todo. A todo resolved in the last 30 days suppresses a new one with the same identity ref. Gmail todos also carry a loop ref from the subject, for example `github:pull_request:owner/repo#N` (`contracts/src/loop-key.ts:130`).

**Closure today.** `todos.resolved_by` / `resolved_reason` and the append-only `todo_events` table (ADR-0107) are built. The live closers are Gmail-only: a user reply dismisses `suggested` todos (`triage/workflow-operations.ts:585`), and a payment receipt closes its payment todo (`tasks/payment-reconciler.ts:95`).

**Gaps.**

- Object state does not touch todos. A merged PR does not close its todo.
- The ADR-0092 referent identity (`knowledge/referent-identity.ts:96`) is built but has no production caller.
- `todos` has no unique index.
- A second producer from a non-Gmail source needs the same source-ref scheme, or duplicates will occur.

---

## 3. Email tagging (triage)

**Owner's model.** Alfred tags each email as fast as possible and updates the tag from the thread messages. The thread update is not accurate. Standing instructions are not fully respected. The flow is possibly too complex and the context too large.

**Verified model.**

1. Gmail push or poll → `persistMessage` (`connections/ingestion/gmail-ingest.ts:266`) → `documents` row → `gmail.documents_ingested`.
2. One `gmail.message_received` event for each inbound document. A user reply emits the event again on the newest inbound message, with `force` (`runtime/adapters/gmail-ingested-consumers.ts:299`).
3. Classify (`triage/workflow-operations.ts:107`): gather observations (`:892`) → model pass on `route("cheap")` (`classifyEmail`, `triage/classify.ts:889`) → optional second pass on a conflict → 5 deterministic floors (`triage/floors/index.ts:160`: override → sender kind → spam → standing → meeting).
4. `upsertTriage` (`triage/store.ts:123`) writes one `email_triage` row for each thread, under a thread lock. A user override (`source='user'`) is never overwritten.
5. Todo decision → Gmail label (`triage/tags.ts:74`) → document ask → close-loop todos.

**Thread re-tag.** Each new inbound message classifies the whole thread again and overwrites the row. The model sees the new message body (6,000 chars) and at most 6 earlier snippets of 220 chars (`triage/thread-state.ts:73`). An open ask older than that is invisible. No thread state machine exists. "Immutable category" (ADR-0048, ADR-0064) only means that briefings and integrations do not rewrite the tag.

**Standing instructions.** The only stored shape is `action: "suppress"` with a `sender_email` or `sender_domain` target (`contracts/src/standing-instructions.ts`). Code applies two effects: no todo for that sender, and a demotion of `urgent` / `action_needed` to `fyi` (`triage/floors/standing.ts`). The model receives the phrasing as prose for all other effects.

**Gaps (standing instructions).**

- `awaiting_reply`, `follow_up`, `meeting`, and `payment` are not demoted.
- Only an exact address or exact domain matches. A subdomain, an ESP relay, or a person named in the body does not match.
- No "promote", topic, or keyword shape exists.
- A new instruction does not re-tag existing threads.

**Prompt size.** The static system prompt is about 42,400 chars (about 10.6K tokens). Rule 16 (the todo rubric) is about 9,600 chars of it. The dynamic part is typically 2-9K chars. Thus about 80% of each request is the fixed rubric. To / Cc and Subject are not bounded.

**Production latency.** See section 6.

---

## 4. Briefings and object state

**Owner's model.** Briefings use activity across integrations. Integration state objects tell if an item has a lifecycle to update, mostly at briefing time. The agent can also query at runtime as a final check.

**Verified model.** The concept exists as **object-state memory** (ADR-0062, ADR-0103, ADR-0109).

- **State in.** Reducers keep the state current all the time, not only at briefing time. Push: GitHub App webhooks (which also carry Vercel) and Sentry, through `objectStateStore.applyEvent` (`assistant/src/connections/object-state/store.ts:341`). Pull: verified pulls at each briefing gather for Railway and Vercel, plus approved MCP health reads.
- **Tables.** `integration_objects`, `integration_object_keys`, `integration_object_relations`, `integration_object_pulls`, `event_receipts`.
- **Registry.** `INTEGRATION_OBJECT_DEFS` (`contracts/src/integration-objects.ts:334-539`). Each kind declares `closesAskOn`, `closesAskFrom` (`stored_projection` or `live_confirmation`), `absorbing`, and `identity`.
- **Closure decision.** Code decides during gather, before the model runs: `dropClosedLoops` → `reconcileEvidence` → `firstClosingObject` → `assertClosure` (`assistant/src/briefings/gather.ts:451-520`). Sentry issues and Railway targets need a live read first.
- **Workflow.** `gather` → `compose` → `send` (`briefings/daily-briefing.ts:58-62`). A quiet cron morning is suppressed before compose, with no model call.
- **What the composing model can read.** `list_closed_loops` and `list_loop_relevance` return arrays that gather computed. `get_day_shape` is the only read at call time. No tool can close a loop.
- **Final check.** A deterministic open-ask guard (`briefings/open-ask-guard.ts:66`) runs after compose and again at send. It only checks GitHub PR URLs. It is not an agent query.

**Provider status.**

| Provider | Status |
| --- | --- |
| GitHub PRs | Works |
| GitHub CI | Reducer exists. No receipts in production (the App does not have the Checks permission). |
| Railway | Works (pull only) |
| Vercel | Writer works. No kind can close a loop. |
| Sentry | Reducer exists. No issue alert in production yet. |
| MCP health | Writer exists. No approved mapping. |

**The runtime agent check.** This is the ADR-0109 runtime closure verifier: the model selects reads and cites values, and code checks identity, time, and state. It is designed and deferred. The trigger to build it is the `[briefing.gather] soft-edge loops with no hard edge` log line (`briefings/gather.ts:415-442`). The 2026-10-20 replay found 35 such loops: 23 have no object state, and 12 are GitHub CI mails blocked by the Checks permission.

**Gaps.**

- Object state feeds briefings and chat (`system.search_context`) only. Triage and todos do not read it.
- The open-ask guard covers GitHub PRs only.
- The `projectReceipt` half of ADR-0103 is not built.

---

## 5. Chat (the boss agent)

**Owner's model.** Not stated yet. On 2026-10-22 the owner asked for the verified model first.

**Verified model** (at `1ec1f0082`).

1. **Send.** The web app writes the user message through Replicache (`http/src/sync/write/chat.ts:31`). Then it posts `/api/chat/threads/:threadId/turn` (`http/src/chat.ts:109`). The route is transport only.
2. **Admission** (`assistant/src/chat/turn-admission.ts:214`). One transaction writes the message, the attachments, the title seed, and one `agent_runs` row with the dedup key `chat:<userMessageId>`. A thread runs one turn at a time. A second message during a turn gets `busy` (`:113`). Then the run goes on the queue.
3. **Transcript.** The worker reads only `role` and `content` of each thread message (`chat-turn.ts:995`). A large thread puts its older messages into a summary (`chat/compaction/chat-context-assembly.ts:24`). The tool calls and tool results of earlier turns are not in the transcript. Only `system.read_chat_history` can get them back.
4. **Prompt.** A fixed charter (`chat-turn.ts:132`), then the artifact rules, then the self-identity line and the summary of connected integrations (`:196`). The date and time go in a separate runtime message, so the cached prefix stays stable. Alfred injects nothing about the user: no facts, no standing instructions, no todos, no recent briefing. The model must call a tool to get them.
5. **Tools.** Each run starts with a kernel of 10 tools: `search_tools`, `load_tool`, `current_time`, `read_chat_history`, `spawn_sub_agent`, `await_sub_agent`, `ask_user`, `read_user_context`, `web_search`, and `search_context`. The run adds the tools that the previous turn on the thread loaded (`chat/thread-tool-carryover.ts`). It also adds a deterministic preload from the latest user message. Other tools need `search_tools` and then `load_tool`.
6. **Model.** `route(tier)` (`chat-turn.ts:430`). Auto (`standard`) is `gpt-6-luna` at `medium` reasoning. Deep is the same model at `xhigh` (`max` for OpenAI). Both fall back to `gemini-3.8-flash` (`ai/src/provider.ts:78-88`). The loop has two steps: `chat-turn` (the model) and `dispatch-tools`. The step cap is 40 for standard and 60 for deep (`execution/workflows/turn-budgets.ts:12`). At the cap, the model answers one more time with no tools.
7. **Approval.** Each call writes an `action_stagings` row, except for 7 fast-path tools and 2 join tools. The rule is `policyMode === "gated" || riskTier === "high"` (`tool-runtime/approval-rule.ts:17`, called from `tool-runtime/internal/dispatch/pipeline.ts:706`). `system.*` tools are always `autonomy` (`action-policies/resolve.ts:104`). For other tools the order is: tool override, integration mode, user default. The signup default is `gated`, and the seed sets only `system` to `autonomy` (`action-policies/index.ts:31`). So in Review mode, a read such as `gmail.search` also waits for approval. An approval parks the run. It expires after 24 hours (`contracts/src/runtime.ts:10`).
8. **Sub-agents.** `spawn_sub_agent` starts a child run with the same tools, but the child cannot spawn. `await_sub_agent` parks the boss until the child ends (ADR-0073).
9. **Reply.** Text and tool cards stream over SSE (`chat.delta`, `chat.tool`). At the end the worker writes the assistant `chat_messages` row (`chat/chat-turn-closure.ts:355`). Then it starts three jobs and does not wait for them: memory capture, compaction, and the title (`:327`).

**Memory from chat.**

- `CHAT_MEMORY_CAPTURE_ENABLED` is off by default (`env/src/server.ts:305`). When it is on, a job runs 12 minutes after the thread goes quiet. The job extracts propositions, but it writes nothing (`chat/chat-memory-capture.ts:235`, `TODO(#399)`).
- The only chat tool that writes memory is `system.remember`, and it stores only a sender suppression (`tool-runtime/internal/tools/system.ts:491`). The other memory tools list, edit, or forget those instructions. So Alfred does not keep "I prefer morning meetings" or "I am on X this week".

**What chat can read.**

- `read_user_context` (`knowledge/user-context.ts:285`): profile, confirmed `user_facts`, the legacy `entities` and their relations, and recent memory.
- `search_context` (`context-search/default-sources.ts:13`): documents, memory chunks, object state, and Drive.
- The provider tools, after a load.
- No tool reads the user's todos, past briefings, or triage tags. A search for `todos`, `briefing`, and `email_triage` in `context-search/` and `knowledge/user-context.ts` finds nothing.

**Gaps.**

- Chat cannot see what the other flows produce: todos, briefings, and triage tags. "What is on my plate?" has no direct answer.
- Chat memory capture writes nothing. From chat, only a sender suppression persists. This is the main gap of the standing-instructions vision ("say it in chat, and Alfred keeps it").
- `read_user_context` reads the legacy `entities`, not `entity_nodes` (see `context-graph.md`, point 1).
- The prompt says "Write actions … are gated" (`chat-turn.ts:165`). The policy gates every non-system call in Review mode, reads too. The prompt and the policy do not agree.
- The results of earlier turns leave the transcript. A follow-up must fetch them again.
- Alfred cannot send a message outside a turn. The prompt tells the model not to promise a follow-up.

---

## 6. Production measurements

### Triage, 2026-10-13 to 2026-10-20 (Langfuse, 196 traces)

Method: traces tagged `role:triage`, generations `triage.classify` and `triage.classify.second_pass`, read through `/api/public/v2/observations`. The clock starts at the worker lease, not at Gmail ingest.

| Measure | p50 | p90 | max |
| --- | --- | --- | --- |
| Whole run | 4.9 s | 6.1 s | 7.6 s |
| `classify` step | 3.1 s | 4.4 s | 5.7 s |
| `apply-label` step (Gmail label calls, no span) | 1.6 s | 2.2 s | 2.9 s |
| Queue wait between steps | 0.02 s | 0.03 s | 0.1 s |

- Model: `gemini-2.5-flash-lite` for all calls. Input about 11.9K tokens (p90 13.8K) for an output of about 115 tokens.
- The first call usually has no cached input. Its p50 latency (2.84 s) is longer than the 2.5 s hedge delay, so the hedge call starts in 78% of runs and wins in 2%.
- A second pass runs in 10% of runs. It causes most of the slowest runs.
- Errors: 4 schema mismatches (2 runs), 1 "user location is not supported" (the server runs in the Railway Southeast Asia region), 1 aborted hedge call that Langfuse shows as an error.
- Cost for 7 days: $0.22.
