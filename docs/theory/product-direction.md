# Product direction: the owner's plan against Dimension and the built code

This document compares the owner's future plan with two references: Dimension (the product that Alfred studied) and the code that is built today. `product-flow.md` records how Alfred works now. This document records where the owner wants Alfred to go, and what each step costs from the current base. Update a section in place when a decision changes.

File references are relative to `packages/` unless a different root is given. "Dimension" facts come from the past recon (memory `reference_dimension_product_behavior.md`, `.tmp-screens/dimension-briefing-research.md`, `git show b0e9dfe69^:dimension-dev-recon.md`, and the `-dimension-ai-*` sibling dumps).

Last verified: 2026-10-21 at `fd13e6427`.

---

## 0. The owner's plan (as stated, 2026-10-21)

- Proper workflows.
- Code mode: the agent has the API from the code or the LLM providers, and can do anything that the API allows. Permissions come from memory or instructions. Example: the agent may delete the action items that it created when it closes the loop.
- A proper context graph.
- Sound like a PA. Remember past briefings. Use the Dimension samples from past sessions.
- Long-term agent memory like Zep.
- Developer features: remote agentic code execution and code review. `../warden` becomes a first-class integration through its new OpenCode review flow.
- Browser autonomy and browser workflows, possibly from browser-use.

---

## 1. Summary table

| Plan item | Dimension | Alfred today | Gap |
| --- | --- | --- | --- |
| Workflows | Scheduled or trigger workflows, editor | **Built.** Prose brief + trigger + allowed tools. Each run is a full agent loop. | No compiled step graph. `steps` is always `null`. |
| Code mode | Not present | **Absent.** Read-only passthrough (rung a) is built and default-off. | Everything. The owner's write scope conflicts with ADR-0087. |
| Context graph | Zep graph per user; see section 10 | **Partial.** Two graph substrates. Objects do not join people, threads, or todos. | The join. This is the same gap as the open-loop hypothesis. |
| PA voice, past briefings | Composes from prior briefing bodies | **Built.** `list_prior_briefings` + voice prompt + `sanitizeVoice`. | Quality, not mechanism. |
| Zep-like memory | Used for relationship context; not the source of continuity (section 10) | **Partial.** Valid-time facts with a supersession chain. pgvector chunks. | Chat capture is off by default. |
| Code execution, review | **Not present.** Only "PRs that wait for you". | **Absent.** Research done. | All. This is a differentiator, not parity. |
| Browser | Not recorded | **Absent** | All. |

---

## 2. Workflows

**Built.** A user defines a brief (prose, up to 20K chars), a trigger, and the allowed integrations and tools. There are two entry points: `system.author_workflow` in chat (`assistant/src/tool-runtime/internal/tools/system.ts:230`) and the web editor (`sync/src/mutators/workflows.ts:99`). Activation is `riskTier: "high"`, so it always asks for approval (`system.ts:280`). Revisions are append-only and content-hashed (`assistant/src/automation/revisions.ts`).

Triggers: `cron`, `manual`, `event` (Gmail `message_received`, and `{type:"raw", rawKind}` for GitHub and Sentry) (`contracts/src/agent.ts:420-447`, `contracts/src/event-triggers.ts`).

**How a run executes.** Every user workflow runs one agent loop, `userAuthoredBriefWorkflow` (`assistant/src/execution/workflows/user-authored-brief.ts:543`). The model decides the path each time.

**The gap.** `workflows.steps` and `hilGates` exist in the schema, but the seeder writes `steps: null` (`assistant/src/automation/seeder.ts:39`). The ADR-0017 step nodes are designed only. The vision "steady-state inference-free" (ADR-0050 D4) needs this step: the agent finds the path one time, then code replays it, and the agent repairs it only when a step fails.

**browser-use evidence for the same shape.** `workflow-use` records a run, compiles it into a JSON step list (`navigation`, `click`, `input`, `extract`, `agent`, and others), replays it with no model (`run_with_no_ai()`), and falls back to an agent when a step fails. It is AGPL-3.0, "very early", and has had no release since 2025-11-19. Take the design. Do not take the code.

---

## 3. Code mode and permissions

**Built.** Only ADR-0074 rung (a): read-only `<integration>.request` passthrough tools for 10 integrations, behind the default-off `feature.passthrough.<slug>` preference (`assistant/src/tool-runtime/internal/registry.ts:61`). A method gate allows GET/HEAD and allowlisted POST reads (`tools/passthrough/gate.ts:16`).

**Not built.** ADR-0087 (object handles, `isolated-vm`, host functions with no network). No package or source file uses `isolated-vm` or QuickJS. The feasibility study (`docs/research/code-mode-sandbox-feasibility.md`) gives GO for `isolated-vm@6.1.2` in a forked worker. It also finds that Railway cannot block the network at the OS level, so the only boundary is app-level.

**How approval works today.** `requiresApproval = policyMode === "gated" || riskTier === "high"` (`tool-runtime/approval-rule.ts:17`, called from `tool-runtime/internal/dispatch/pipeline.ts:706`). The policy mode is per tool or per integration, from `user_action_policies` (`assistant/src/action-policies/resolve.ts:69-117`). The default is `gated`.

**Owner decision (2026-10-22): code mode can write.** This supersedes the read-only scope of ADR-0087, which designs code mode as read-only and network-less for custody reasons. ADR-0116 (proposed) records the write scope: writes are host calls through dispatch, planned before they apply, under the ADR-0115 record. The set of write capabilities is not decided yet. The user can turn on some of them in settings.

**The owner's permission example is a new axis.** Today, permission is per tool. The owner's example ("the agent may delete what it created") is per record: it depends on who made the record. The provenance data exists: `todos.created_by` (`user|agent`), `agent_run_id`, and the `todo_events` actor, authority, and run for each change (ADR-0115 slice 1). No rule reads it. `system.resolve_todo` is `no_risk` and does not check `createdBy` (`assistant/src/tasks/resolve.ts:196`). A provenance rule is small and can come before code mode. ADR-0115 stores the provenance for each change, and ADR-0116 rule 4 reads it for Code Mode writes.

---

## 4. Context graph

**Built, but split.**

- Legacy `entities` / `entity_relations` (`db/src/schema/memory.ts:174,201`). Only `knowledge/user-context.ts` reads them.
- ADR-0067 user model: `observations`, `entity_nodes`, `entity_identities`, `entity_profiles`, `entity_edges` (`db/src/schema/user-model.ts`). Sources: user, chat, Gmail, Google account. The only product reader is triage sender kind (`assistant/src/triage/sender-kind.ts:51`).
- `integration_objects` (GitHub, Sentry, Vercel, Railway, MCP). Read by briefing gather and context search.
- `integration_object_relations` (object ↔ entity): schema only (`db/src/schema/integration-objects.ts:97`). No writer and no reader. Verified with `rg` on 2026-10-21.
- ADR-0092 referent identity: built, only tests call it.
- Todos link to things only through the `sources` jsonb.

**Link to `product-flow.md`.** Pass 1 found that no persisted loop entity exists. Four records each hold part of a loop. The missing context-graph join and the missing loop entity are one gap: the edge from an object (a PR) to a person, a thread, and a todo. ADR-0058 keeps this on Postgres: a graph model, not a graph engine. The past analysis said: "Dimension's real edge wasn't the engine — it was the populated data."

---

## 5. PA voice and past briefings

**Built.** The compose agent has `list_prior_briefings` (default 5, max 10), which its description calls "the memory mechanism" (`assistant/src/briefings/agent/tools.ts:150-163`). `DEFAULT_VOICE_PROMPT` goes into the briefing prompt (`ai/src/voice/prompt.ts:6`, `briefings/agent/prompt.ts:169`). `sanitizeVoice` runs on the subject and the body.

**The gap is quality.** The 2026-05-21 study named "memory at compose" as the main missing piece. It is now built. The tool is optional, so the model can skip it. Prod use of the tool is not verified in this pass.

---

## 6. Long-term memory ("like Zep")

**Dimension.** The web repo only creates and deletes Zep users. The Python backend (`-dimension-ai-ai`) does use Zep: one graph for each user, no custom ontology, a write path from Gmail, GitHub, Slack, Linear, Vercel, chat, and its own briefings and action items, and one read path (`search_memory_graph`, `apps/agent/agent/utils/memory_search.py:39`). Section 10 explains what Zep does and does not produce.

**Decision.** ADR-0058 rejects Zep and Graphiti. The 2026-08-20 note measured Graphiti at 18 to 33 LLM calls for each dense episode, with no vector index. That note is only at checkpoint `4bdf7aa03:docs/research/zep-graphiti-agent-memory.md`, not on `main`.

**Built.** `user_facts` has `valid_from`, `valid_until`, `supersedes_id`, and statuses (`db/src/schema/memory.ts:40-65`). A conflict from an autonomous source is held as `proposed` (ADR-0079, `knowledge/facts.ts:145`). `memory_chunks` uses pgvector. This is valid time plus a supersession chain. It is not bi-temporal, and no model invalidates facts.

**The gap.** Chat-to-memory capture exists but `CHAT_MEMORY_CAPTURE_ENABLED` is off by default (`env/src/server.ts:217`). So memory does not grow from chat. Memory growth is the gap, not the store.

---

## 7. Developer features

### 7.1 Remote agentic code execution

**Dimension.** Not present.

**Alfred.** Not built. The research is done: `docs/research/delegated-agent-runner-substrates.md` (2026-07-25) ranks:

1. GitHub Actions `workflow_dispatch` with the App installation token, which runs `claude -p` headless. Alfred already mints the tokens (`integrations/src/github/app.ts`). The completion signal is a webhook that the App already receives.
2. Claude Managed Agents. Best credential isolation and a real completion webhook. Beta.
3. Fly Machines as the DIY fallback. Railway has no one-off job primitive.

### 7.2 Code review through warden

**warden today** (`../warden`, verified 2026-10-21):

- A local CLI and a label-gated GitHub Actions tracer (`.github/workflows/warden-review.yml`). No server.
- Input: the diff of the checked-out working tree. Output: a `CommentSet` (`--json`). Nothing posts to the PR yet.
- New flow (ADR-0053): `warden opencode-review` runs OpenCode as the model loop. warden keeps the deterministic Phase 1 checks and the Phase 3 post-pass that the model cannot skip. Only the down lane is built.
- Library surface: `@warden/core` exports `review()` and `runPostPass()`. Packages export raw `src/index.ts`, are not published, and the name is not settled (ADR-0040).

**Owner decision (2026-10-22).** The developer lane is not a product bet until warden is in a decent shape.

**What blocks a first-class integration.**

- Parity gate #43 (the acceptance gate of the OpenCode pivot) has no GO.
- No PR comment posting, no hard cost cap, trace bridge #47 open.
- No OS sandbox. Lanes read untrusted PR text (ADR-0054).
- It reviews only a working tree, so the host must supply a checkout.

**The shared substrate.** Code execution and code review both need a checkout, model keys, and a scoped GitHub token. The GitHub Actions runner gives all three, and warden already has an Actions tracer. So one substrate can serve both: Alfred dispatches a workflow, the runner runs `claude -p` (execution) or `warden opencode-review --json` (review), and the result returns through the App webhook. The result can then become an `integration_objects` row, so briefings and todos see it like any other object state.

---

## 8. Browser autonomy (browser-use)

**Options for a Node server** (verified 2026-10-21):

- **Cloud API v4 through `browser-use-sdk`** (MIT, npm). Remote browser, so no Chromium on Railway and no Python. Pay as you go: $0.02 per browser hour, model tokens at the provider rate plus 20%.
- **Hosted MCP** at `https://api.browser-use.com/v3/mcp` (HTTP, Bearer key). The Alfred MCP broker can take it with no new code. It runs V3 sessions, not V4.
- **Python library** (MIT, 118.7K stars). Needs a sidecar and a local Chromium.
- **`workflow-use`** (AGPL-3.0, early). See section 2.

**Logged-in sessions.** Cloud profiles keep cookies and login state on browser-use servers.

**Custody (owner decision, 2026-10-22).** A third party may hold the user's session cookies and may run code. This supersedes the ADR-0087 objection to Freestyle.sh and Vercel Sandbox. The condition: Alfred must refresh the third-party session at intervals, as it does for MCP OAuth, and it must show when a session needs the user again.

**Security.** The docs have no prompt-injection guidance. `secretBindings.allowedDomains` limits where a secret goes, but it does not limit navigation.

---

## 9. One shape across three items

Workflows (section 2), browser workflows (section 8), and code mode (section 3) share one shape: the agent finds the path one time, code keeps the path, and the agent repairs the path only when a step fails. This is ADR-0050 D4 ("the machine that builds machines"). One compiled-step format can serve all three, with step kinds for a tool call, a browser action, and a code block.

## 10. Why Dimension's observation is more coherent

**Owner's model (2026-10-21).** Dimension observes what the user does much better than Alfred. The cause is probably its agent memory with a graph database and its collection of nodes. Dimension also had a meeting bot that listened to meetings.

**Verdict.** The observation is better. The cause is mostly not the graph. A meeting bot existed in code, but no briefing or prep code reads its output (corrected 2026-10-21, see below).

**Evidence: the Dimension emails** (work account, 40 threads, 2026-03-17 to 2026-05-19):

- Evening briefings carry work items across days: "the Datomic migration … is still on your plate … That one's been carrying since yesterday."
- Meeting prep lists open items for each owner with a status question ("Shipped?", "Merged? Demo out?"). It also notes "no meeting notes since May 13".
- When no signal exists, it guesses and says so: "No commits or todos logged today, so guessing it was heads-down work on the Views revamp with Akshay."
- The onboarding mail lists "What I learned" (product, customers, writing style) and three workflows that it proposed from inbox patterns.

**Evidence: the meeting bot (corrected 2026-10-21).** An earlier pass said that no bot existed. That was wrong. `-dimension-ai-ai/apps/agent/agent/apps/meeting-bot/` is a Rust service (axum) that sends a Recall.ai bot to a meeting (`POST /meetings/start`) and receives Recall webhooks. The live transcript webhook only writes a log line (`src/main.rs:183-200`). On `bot.done`, it fetches the transcript, merges it with the user's own notes through an LLM (gemini-3-flash via OpenRouter), and pushes the result to the web app (`meetingNotes.saveEnhanced`, `src/dimension_client/mod.rs:87`). But the `meetingNotes` router is not in the `-dimension-ai-web` dump, and no briefing, prep, or agent code in `-dimension-ai-ai` reads meeting notes. The only git commit is the dump itself ("feat: legacy", 2026-05-24), so the date when the bot went live is not known. The standup items came from Oliv's own notetaker email: `Meeting assist <meeting-assist@oliv.guide>`, "Post Meet Summary", sent to `engineering@oliv.ai`, with action items for each person ("Yash Kar: Relocate deal merging metadata from Datomic to the runs table"). Dimension read that email.

**Evidence: where the continuity comes from** (`-dimension-ai-ai`):

| Mechanism | Receipt | Zep? |
| --- | --- | --- |
| Prior briefing bodies are **injected** into the prompt: 3 past evenings + today's morning (evening); 2 past mornings + yesterday's evening (morning) | `apps/agent/agent/evening_briefing/main.py:60-142`, `morning_briefing/subgraphs/briefing_generator/main.py:109-120` | No, Postgres |
| Prompt rules: "close the loop", "Warm handoff", "Stale items … compress" | `config/evening_briefing/__init__.py:210`, `config/morning_briefing/briefing_generator.py:172,288` | No |
| Todos carry forward by SQL: `UPDATE ai.todos SET assigned_date=:local_date WHERE status!='done'` | `apps/agent/agent/db/repo.py:13417` | No |
| Meeting prep gets the previous prep notes, a meeting diff, and a staleness flag | `apps/agent/agent/meeting_prep/main.py:284-366` | No |
| Full email read tool (`READ_EMAIL_FULL`) and Linear/GitHub activity for the day | evening briefing tools | No |
| A per-person relationship summary (an LLM summary of each person with 3 or more exchanges) | `apps/rag/rag/consumers/gmail/sync.py:738-810` | **Yes** |
| Writing style from about 200 sent emails; product knowledge from skills over docs | `skills/dedicated_agents/email_tone/main.py:36` | No |

Zep answers only an optional `MEMORY_SEARCH` tool. The briefing prompts send it to personal context ("partner, hobbies, evening plans"). The estimate is that Zep gives less than a quarter of the continuity (medium confidence). Its real value is relationship context for meeting prep and reply drafts.

**Alfred, same inputs** (`packages/assistant/src/briefings/agent/`):

- `list_emails_since` returns "No bodies" (`agent/prompt.ts:96`). `read_email` exists, with the instruction "Use sparingly".
- The prompt drops FYIs and completed work: "a briefing is not a transcript" (`agent/prompt.ts:54`). A notetaker summary is triaged `fyi`, so its action items for the user never reach the briefing.
- Prior briefings are an optional tool (`list_prior_briefings`), not injected context.
- Todos have no carry-forward. The only automatic producer is email triage.
- The mail fact extractor looks only for "durable facts ABOUT THE USER" and expects zero from most mail (`knowledge/extraction.ts:44-49`).
- Relationship context: the ADR-0067 projection is not active in production (memory `project_user_model_epic_218.md`).

**What this means.** Alfred records who the user is. Dimension records what the user and the team are doing. The gap is in three places, and none of them needs a graph engine:

1. **Input.** Treat a meeting-notes email as a first-class source. Extract action items, owners, and decisions from it. Do not drop it as `fyi`.
2. **Carry.** Keep an open work item from day to day. Injected prior briefings give a weak form. A persisted work item with an owner, a status, a source, and a last-seen date gives a strong form. This is the same missing loop entity as in `product-flow.md` pass 1.
3. **Prompt.** Inject the recent briefings and the open work items, and add the continuity rules.

Relationship summaries for each person are the one place where Dimension's Zep use adds value. Alfred can make them on Postgres (ADR-0058) when the ADR-0067 projection is active.

### 10b. Day-by-day receipts (pass 2, 2026-10-21)

Source: all 40 Dimension mails in the work Gmail, read in full (`references/dimension-work-mails-2026-10-21.txt`, gitignored), plus the dates and headers of the `meeting-assist@oliv.guide` mails.

**The good observation came from 5 days and 2 prep notes, not from every day.**

- There are 30 evening briefings (2026-03-17, then 2026-04-19 to 2026-05-17). Only 5 of them use the standup notes: 04-27, 04-28, 04-29, 04-30, 05-01.
- Standup notes arrived before the evening run (13:00 UTC) on 13 days: 04-20, 04-21, 04-23, 04-24, 04-27 to 05-01, 05-05, 05-07, 05-11 (the 05-06 and 05-08 notes came late), 05-13. On 8 of the 13 days, the briefing does not use them.
- On 04-21 the briefing saw the notes and dismissed them: "Inbox was login codes and meeting notes, nothing needing action."
- On the other days the briefing fills the gap with a guess. 18 lines say "No commits or todos logged, so probably heads-down …" or similar. This is the same blind spot that Alfred has.
- The two standup preps (05-18, 05-19) map one to one to a single notes mail (2026-05-13). Each of the 8 "AI Summary" lines in that mail becomes one item with an owner and a status question. The prep does not keep a tracker over many meetings.

**Why the notes disappeared: a bulk-mail filter, not the model.**

- The notes go to the `engineering@oliv.ai` Google Group. Each one has `Precedence: list` and `List-Unsubscribe`, and the body has the group "To unsubscribe" footer.
- Dimension's evening tool `GET_TODAYS_EMAILS` keeps a mail only if its score is 3 or more (`apps/agent/agent/evening_briefing/tools/email/get_todays_emails.py:152`). The base is 3. `List-Unsubscribe` gives −15 and footer text gives −8 (`packages/shared/shared/utils/email_filters.py:474-503`). So the filter drops every group notes mail. `READ_EMAIL_FULL` needs a thread id from that list, so it cannot recover them.
- The proof is a control on the same day. On 2026-05-07 the same sender sent a `[TEST]` notes mail directly to the user, with no list headers. The briefing used it ("you ran a transcript path E2E test"). It did not use the real standup notes from the group mail that day.
- Unknown: why 04-27 to 05-01 worked. The dump has no git history, so the date of the filter change is not known. The likely cause is that the `List-Unsubscribe` penalty arrived after 05-01.
- Dimension's own triage tagged all 21 notes mails `6: fyi`, and they stayed in the inbox. So the tag did not hide them. The ranking filter hid them.
- Meeting prep found the 2026-05-13 notes through search. Its prompt says "MEMORY_SEARCH: always first" and also offers `HYBRID_SEARCH` (`apps/agent/agent/config/meeting_prep/agent.py:430-445`). The dump does not show which of the two returned the notes. Zep gets Gmail through an incremental sync that a code comment calls "weekly" (`apps/rag/rag/consumers/gmail/sync.py:1480-1560`).

**Carry was weak, even in the good week.**

- The Datomic task starts on 04-29 and carries to 04-30 ("carrying since yesterday"). After 05-01 it does not appear again. Dimension never closed it and never asked about it.
- One later carry exists: on 05-06 the briefing guesses "the Views revamp with Akshay". That item came from the 04-28 notes, through the injected prior briefings.
- The prep status questions ("Shipped?", "Merged? Demo out?") go to the user because GitHub was not connected. The onboarding mail says this. GitHub facts reached the briefings only as notification mails. Dimension does not penalize those mails when the GitHub integration is not connected (`email_filters.py:509-528`): PR #437, #444, #465.

**Other shapes worth a copy.**

- Team awareness: on 04-29 the briefing reports other people's work from the same notes ("Ayush got a 4x speed boost on graphs, … Pratik's building a CDC test harness"). A work item needs an owner who is not the user.
- Onboarding proposed three workflows from inbox patterns: an AWS alarm triage that labels an alarm new, recurring, or chronic from 7 days of history; a post-call follow-up draft from the notetaker notes plus email threads, in the user's style; a pre-call brief for customer calls. The user turned on two. The last mail says that they never ran.
- Final count from the shutdown mail: 1,401 mails tagged, 157 action, 21 urgent, more than 1,000 FYI, 2 call preps, 4 morning briefings, 6 action items.
- One error: the Company Meeting prep says "pulled forward to 7:30 PM", but its own header says 7:45 PM.

**What this changes in the proposal above.**

1. **Input is the main lever, and a general filter must not decide it.** Dimension's quality went up and down with one mail type. Recognize a notetaker mail by its kind (sender, subject shape, "Tasks" or "Action items" section), not by a general relevance score. Alfred has the same risk. The triage prompt says "unsubscribe → newsletter/marketing" (`packages/assistant/src/triage/classify.ts:181`), and the group footer sets `hasUnsubscribe` (`triage/observations.ts:78,100`).
2. **Carry must be a record.** Dimension's carry by injected text lasted 2 days for its best item. A persisted work item with a status beats the reference. It does not only match it.
3. **Closure must use evidence.** Each item can hold an expected closure signal (a PR merge, a ticket state, a later notes line). Alfred has GitHub connected, so it can answer "Shipped?" itself and ask the user only when no evidence exists.
4. **Say "no signal" honestly, or ask.** Dimension wrote a guess on most days. Alfred must not copy that. A quiet day with open items must name the open items, not guess the work.

### 10c. The personal account (pass 2, 2026-10-21)

Source: all 28 Dimension threads in `yashgouravkar@gmail.com` (`references/dimension-personal-mails-2026-10-21.txt`, gitignored). They are 22 evening briefings (2026-04-23 to 2026-05-16), 1 morning briefing, the "Skill documented" mail, the shutdown mail, and a 2024 invite.

**Here the observation was good every day, because GitHub was connected.**

- Every day with work names the repo, the PR number and title, the commit count, and the lines added. Examples: "PR #16 (M14) … boss loop, 6 workers, 7 prompts", "20 commits across 3 repos", "16 commits on PR #27". It also sees commits on open branches, not only merges.
- The source is `GET_TODAYS_GITHUB_ACTIVITY` (`-dimension-ai-ai/apps/agent/agent/evening_briefing/tools/github/get_todays_activity.py:226`). It reads the recently pushed repos, every branch, and the commit stats.
- No guess lines appear. On a day with no commits it says "No commits, no emails, no meetings", and that is a fact. The source is complete, so an empty result means "nothing happened". At work, "No commits or todos logged" was a guess, because GitHub was not connected there.
- So both accounts show the same rule. Observation quality follows the coverage of a structured source. It does not follow the memory engine.

**Mail and calendar gave the job-search thread, but only as single events.**

- Rejections (Porters, Powernaut, Sunrise Robotics, OtterHalf), an application (insettini through Wellfound), sent replies (KnowDis AI, Bynd AI), inbound roles (Z42 Labs, Crossing Hurdles), and interviews from the calendar (100ms hiring manager round, the Goodlabs chat).
- One carry by text: on 04-24 it says "Hope the Goodlabs call with Adam went well last night". This came from the 04-23 briefing.
- The briefings never keep a pipeline state (applied → interview → rejected). Only the "Skill documented" mail holds a "Current Pipeline (April 2026)" list. So the job search was a dossier written one time, not an object that changes over time.

**Carry by injected text makes counts that are wrong.**

- 05-01 says "Five straight days of shipping on alfred". But 04-30 says "No commits".
- 05-07 says "three days running now". But 05-06 says "No commits".
- 05-08 says "four straight days of heavy shipping this week". But 05-04 and 05-06 had no commits.
- These counts come from earlier briefing text in the prompt, not from data. Alfred's `get_day_shape` is deterministic (`packages/assistant/src/briefings/agent/prompt.ts:100`). A streak or a total must come from a query like that, not from earlier prose.

**The voice the owner liked.**

- The evening mail is a recap of what the user shipped, with a headline subject ("Alfred's flying, M4 landed"). It praises a big day ("You went off today") and tells the user to rest after a weekend of work. It gives comfort after a rejection, and it gives weather and a sign-off.
- Small personal facts appear: a food order, "Saw the Alfred sign-in code come through, so you're testing it too".
- Alfred's prompt does the opposite on purpose. It says: "Never enumerate merged PRs", and give shipped work "ONE collapsed clause" (`prompt.ts:54`, `prompt.ts:150`). This is a product decision for the owner, not a fault. The question is whether the evening slot is a recap of the day (Dimension) or a list of open loops (Alfred).

**The cold-start dossier ("Skill documented: Jobs 2026 Apr", 2026-05-03).** It used 20+ application mails (Oct 2024 to May 2026), Notion, and memory. It recorded criteria (remote only, a minimum salary, early stage), channels, the user's cold-mail structure and subject style, the technical profile, and the current pipeline. It is a snapshot. Later briefings do not update it.

**What the two accounts show together.**

1. Dimension's best observation came from a complete, structured source (GitHub API, calendar). Mail added events, and the notes mail added team work only when the filter let it through.
2. Zep and the graph do not appear in any visible result in either account.
3. Alfred already has the parts: GitHub is connected, and `get_day_shape` and the loop tiers exist. The gaps are the notetaker input (10b), a stored work item, and the evening voice decision.

### 10d. How Dimension stored open work (source read, 2026-10-21)

Roots: `WEB` = `-dimension-ai-web`, `AI` = `-dimension-ai-ai`.

- **Where the backend is.** Both repos are backend. `WEB` has a Fastify + tRPC API (`apps/api/src/index.ts`, 47 routers), NATS consumers (`apps/consumers`), and the only DB schema: Drizzle, Postgres schema `ai`, about 64 tables, 110 migrations (`packages/models/drizzle/`). `AI` (Python agents, RAG, webhooks) has no migrations. It reads and writes the same `ai.*` tables with raw SQL (`apps/agent/agent/db/repo.py`, about 17.5k lines). Zep and Turbopuffer are outside Postgres.
- **No lifecycle store for external objects.** Linear and GitHub state changes are events that create or delete action items. Briefings read GitHub and Linear live. Linear state is also in a Turbopuffer search index, not a tracked object.
- **Action item** (`ai.suggested_messages`): key `UNIQUE(user_id, integration, integration_identifier)` (Gmail thread, calendar event, `repo#pr`, Linear id). An agent makes at most one item for each source object ("One thoughtful action item … beats three", `config/action_items/gmail.py:127`). External evidence deletes it: a reply, a PR closed or reviewed, an issue done or unassigned, an event cancelled, or a model match on a `done` mail. It is shown for only 48 hours.
- **Todo** (`ai.todos`): UUID only, no dedup. The user or chat `ADD_TODO` makes it. It closes by check-off, by an LLM judge for agent runs, or by a cascade when its source action item closes. A daily SQL moves `assigned_date` forward.
- **A notes mail gives at most one item, because the key is the Gmail thread.** No code splits a meeting-notes mail into many items.
- **A commitment said in chat** ("I'm on X this week") goes only to Zep. Nothing closes it.

**Verdict.** Dimension had no "work item". Its open work was "one item for each source object, closed by that object's events". Alfred already has a stronger form of that model: object state (ADR-0062), evidence closure (ADR-0103, ADR-0109), and the referent (ADR-0092) that joins many messages on one real thing. The proposal for a separate work-item table is withdrawn. The real gaps are: one message about many referents, each with a person; the classifier `about` field (ADR-0092 D1), which is not built; and the notetaker input (10b).

**Owner decision (2026-10-21).** "Briefings can tell anything that helps build a coherent narrative. The order is left to the agent." This removes the content bans in `prompt.ts:54` (drop completed work, never list merged PRs). Code still supplies the facts (closure, counts, streaks). The model selects and orders them. The prompt is not changed yet.

---

## 11. Open questions for the owner

1. **Answered by §10d.** The context graph does not need a separate loop entity. `integration_objects` holds a thing with state, a referent holds an untracked thing, and `todos` holds the user's work ([context-graph.md](./context-graph.md)).
2. **Answered (2026-10-22).** Code mode can write (§3). Open: which write capabilities exist, and which ones the user turns on in settings.
3. **Answered (2026-10-22).** A third party may hold sessions and run code, if Alfred refreshes the session at intervals (§8).
4. **Answered (2026-10-22).** The developer lane is not a product bet until warden is in a decent shape (§7.2).
5. **The three gaps of 10d are drafted as an ADR-0092 amendment** (proposed, 2026-10-21; [ADR-0092 "Amendment 2026-10-21"](../decisions/ADR-0092-notification-referent-dedup-on-the-observation-log.md)). `about` becomes a list. Each item has an `owner` and a `quote` that code finds in the message. A resolved owner is an `owned_by` edge. Extraction runs in every triage category, so an `fyi` notes mail still gives referents. Open: may the classifier copy an open referent name from the same sender, so that one piece of work converges across days before D4 step 2 exists? No open issue tracks the amendment. #917 (S1 to S3) and #1247 (S2) are the nearest.
