# Time awareness without cache breakage

Status: Research, 2026-11-19. This is not settled theory. It changes no ADR or runtime rule. It is input for a decision about `<runtime_context>` and the `system.current_time` kernel tool.

Each claim has a tag:

- **[fact]** has a receipt: a `file:line` at the current `main` (`38c84270c`), a query result, a probe result, or a URL.
- **[inference]** is my reasoning from the facts. No receipt proves it.

Prior-art source was read at these commits:

- opencode: [`anomalyco/opencode@56dc95b`](https://github.com/anomalyco/opencode/tree/56dc95bff5f002321a12de5bbbe2783cd0c87e2a).
- pi: [`earendil-works/pi@5a14e69`](https://github.com/earendil-works/pi/tree/5a14e69c067d40dfbff4f2fff7d3b34c897e2dc9).

## Summary

1. Today, the chat "now" line is not cache-safe across turns. A live probe on Haiku 5.5 shows the problem. On the second user turn, the current design read 1,230 tokens from the cache and wrote 5,444 again. The same thread with the time inside the stored user message read 5,757 and wrote 970. A control with no time read 5,700 and wrote 918. **[fact, probe in section 2.3]**
2. The cause is the placement. Alfred inserts `<runtime_context>` as an extra assistant message before the newest user message, and does not store it. On the next turn, the old copy is gone and a new copy sits at a new position. Thus no earlier cache entry matches, and the full verbatim history is written again on each new user turn. **[fact for the mechanism, from code; the probe confirms the effect]**
3. Inside one run, the cache holds. Prod Haiku 5.5 runs read 80.6% and 86.6% of input from the cache. The time anchor stays the same inside a run. **[fact, section 2.2]**
4. opencode does not refresh "after a gap". It puts the date only (no time of day) in the system prompt. When the date string changes, it appends a durable "Today's date is now: ..." message to the history. pi removed the date from its system prompt in July 2026 because of the cache, and it has no replacement. **[fact, section 3]**
5. Recommendation: put a minute-level send time on each user message. Render it from the stored `created_at` and the user's zone, so the bytes never change. Append a time note only when a run resumes after a park or when the local date changes. Remove the time line from `<runtime_context>`. Remove `system.current_time`. Code Mode scripts already read the live clock with `new Date()`. **[inference; section 5]**

## 1. Where "now" enters a model call today

### 1.1 Chat (`chat-turn.ts`)

| Item | Where in the request | Granularity | Relative to the cache breakpoints | Receipt |
|---|---|---|---|---|
| `<runtime_context>` time line | An assistant-role message, inserted just before the newest user message. It is not stored in the run transcript or in `chat_messages`. | Seconds. Local weekday, date, `HH:MM:SS`, IANA zone, and the UTC instant. | After the system and tool breakpoints. Before the moving breakpoint on the last message. So it is inside the cached message prefix. | **[fact]** `packages/assistant/src/execution/grounding.ts:18-23`; `packages/assistant/src/chat/chat-turn.ts:452-466`, `:530`; `packages/assistant/src/chat/compaction/turn-context-guard.ts:21-40` |
| Date line in the system prompt | Not used in chat. `buildChatSystemPrompt("")` gets an empty grounding. | None. | Not applicable. | **[fact]** `chat-turn.ts:214-217`, `:443-448` |
| `system.current_time` kernel tool | A tool definition in the tools array. Its result is a tool result in the transcript. | Seconds, live at execution. | The definition is behind the tool breakpoint. A result is appended at the end, so it does not break the cache. | **[fact]** `packages/assistant/src/tool-runtime/internal/tools/system.ts:101-108`, `:244-262`; `docs/theory/product-flow.md:137` |
| Prompt rules that name the snapshot and the tool | System prompt text. It is constant. | Not applicable. | Inside the system breakpoint. | **[fact]** `chat-turn.ts:153-154` |

The anchor rules:

- A run sets the anchor on its first step. Later steps keep the same instant, so the bytes stay the same inside a run. **[fact]** `grounding.ts:37-50`, `chat-turn-state.ts:140-141`.
- The anchor moves only when the local day changes, or when a park lasts 5 minutes or more. **[fact]** `grounding.ts:29`, `chat-turn-state.ts:228-245` (line 239).
- Each new user message starts a new run with a new state, so each user turn gets a new time string. **[fact]** the anchor lives in `ChatRunState` (`chat-turn-state.ts:141`).
- The same ephemeral message also carries `artifactThreadFacts` and `artifactReference` when they exist. **[fact]** `chat-turn.ts:459-466`.

A mismatch: the 5-minute grace says that it "matches the provider's idle cache lifetime" (`grounding.ts:25-29`). But chat writes with a 1-hour TTL. `AlfredAgent` defaults to `"1h"` (`packages/ai/src/agent.ts:109`, `:169-172`), and the chat agent sets no `cacheControl` (`chat-turn.ts:539-551`). Thus a park between 5 and 60 minutes re-stamps the line while the cache is still alive. **[fact for both values; inference that the re-stamp then costs a rewrite]**

### 1.2 The cache breakpoints

`decorateAnthropicPrompt` and `decorateAnthropicTools` set at most four breakpoints. **[fact]** `packages/ai/src/request-projection.ts:78-129`.

1. The system block (`:85-87`).
2. The last function tool (`:110-129`).
3. The message before the assistant message that made the trailing tool calls (`:63-76`, `:101-103`).
4. The last transcript message (`:104`).

Only `AlfredAgent` attaches the cache policy (`agent.ts:161`). `projectAnthropicRequest` returns the request without marks when no TTL is present (`request-projection.ts:152-163`). **[fact]**

Anthropic builds the prefix in this order: `tools`, `system`, `messages`. **[fact]** [prompt caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

### 1.3 Other runners

| Runner | How it gets "now" | Granularity | Placement | Receipt |
|---|---|---|---|---|
| Sub-agents and user-authored workflows (`user_authored_brief`) | `formatDateGrounding` in the system prompt, read again on each step | Date and zone, no time | System prompt, inside the system breakpoint. A new `AlfredAgent` is built on each step, so a date change does not throw. It only misses the cache. | **[fact]** `packages/assistant/src/execution/workflows/user-authored-brief.ts:182`, `:213`, `:236-257`; `grounding.ts:8-12` |
| Daily briefing | No "now" line. The tools give local times per item (`receivedAtLocal`, `occurredAtLocal`), and the slot sets the window. | Per item, minutes | Tool results | **[fact]** `packages/assistant/src/briefings/agent/prompt.ts:93-96`, `:164-181`; `briefings/agent/agent.ts:299-330` |
| Briefing cache | The briefing calls `meteredGenerateText`, not `AlfredAgent`, so it sets no cache marks. | Not applicable | Not applicable | **[fact]** `agent.ts:161` is the only caller of `attachProviderTurnPolicy` |

### 1.4 The user's zone

`settings({ userId }).timezone()` reads the `timezone` preference, then the legacy `briefing.timezone`, then falls back to `UTC`. **[fact]** `packages/assistant/src/settings/user-settings.ts:71-76`; `packages/assistant/src/time/user-timezone.ts`. Chat snapshots it once per run. **[fact]** `chat-turn.ts:364`.

## 2. Measurements

### 2.1 Data available

- Prod has 19 Haiku 5.5 chat calls in 2 runs, all on 2026-11-19. Both runs are the first turn of a new thread. **[fact, prod `api_call_log`]**
- Dev has 7 Haiku 5.5 calls in 1 run. **[fact, dev `api_call_log`]**
- Before today, prod chat ran on `gpt-6-luna` (126 calls, 17 runs). OpenAI caching is automatic and has a different mechanism, so it does not answer the Anthropic question. **[fact for the counts]**
- No Anthropic thread in prod or dev has two runs. Thus the stored data cannot show the cross-turn effect. I ran a probe for that (section 2.3). **[fact]**
- Per-call cache data is in `api_call_log` (`cached_input_tokens`, `cache_write_input_tokens`). `chat_messages.usage` has only the sum per turn. **[fact]**
- `system.current_time` appears in 0 of 19 prod assistant rows in the last 30 days (`chat_messages.tool_calls`). **[fact, prod query]**

### 2.2 Inside one run (prod and dev, Haiku 5.5)

| Run | Calls | Input | Cache read | Cache write | Read ratio |
|---|---|---|---|---|---|
| prod `run_53fo4lis0iy7` | 12 | 322,718 | 260,068 | 62,624 | 80.6% |
| prod `run_k8q2atc7e2o8` | 7 | 177,062 | 153,368 | 23,678 | 86.6% |
| dev `run_4tcmlwn3jgzf` | 7 | 141,542 | 112,425 | 29,101 | 79.4% |

**[fact, `api_call_log`]**

- On each step, the read is the previous input minus 2 tokens. The write is only the new tail. **[fact]** for example `run_k8q2`: 16,100 then read 16,096.
- The second prod run read 15,891 of 16,100 tokens on its first call, from a different thread. Thus the tools and system prefix is shared across threads. **[fact]**
- Two misses are not from the time line. `run_53fo:chat-turn:8` read 0 and wrote 20,541. Dev `run_4tcm:chat-turn:6` read 8,873 and wrote 9,671. Neither run parked, and neither crossed a local midnight, so the anchor did not move. **[fact for the numbers; inference for the cause]** The most likely cause is a change in the tools array, which comes first in the prefix. **[inference]**
- Thus a changing time string does not correlate with cache writes inside a run. **[fact for the code rule; the data agrees]**

### 2.3 Across turns (live probe)

The probe sends two turns of one thread to `claude-haiku-5-5` through the real Alfred cache projection (`alfredInternal.cacheTtl`, 5-minute TTL). History is about 4,500 tokens. Each case uses a new system prompt, so it starts cold. Probe: `references/scratch/time-cache-probe-2026-11-19.ts` (gitignored).

| Case | Turn 1 write | Turn 2 read | Turn 2 write |
|---|---|---|---|
| Current: ephemeral `<runtime_context>` before the newest user message | 5,756 | 1,230 | 5,444 |
| Time line inside the stored user message, kept in history | 5,757 | 5,757 | 970 |
| Control: no time | 5,700 | 5,700 | 918 |

**[fact, probe output 2026-11-19]**

- In the current design, turn 2 reads only the system block. The full history is written again. **[fact]**
- A time line stored with its user message costs the same as no time line. The extra write is 52 tokens, which is the line itself. **[fact]**
- Why: Anthropic writes a cache entry only at a breakpoint. On a miss, it walks back at most 20 blocks to find an earlier entry. **[fact]** [prompt caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching). Every earlier entry includes the old `<runtime_context>` at its old position. The new request does not have it there. Thus no entry matches. **[inference that agrees with the probe]**
- Cost: with the 1-hour TTL, a write costs 2x the base input price and a read costs 0.1x. **[fact]** same docs. So each history token costs about 20 times more on the first call of each new user turn. The cost grows with the verbatim history since the last compaction. **[inference]**

## 3. Prior art

### 3.1 opencode

- A built-in instruction source `core/date` reads `new Date().toDateString()`. The first render is `Today's date: <date>`. A changed value renders `Today's date is now: <date>`. It has no time of day. **[fact]** [`packages/core/src/instructions/builtins.ts` L25-31](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/core/src/instructions/builtins.ts#L25-L31).
- The first value is a frozen "epoch baseline" and goes into a system part of each request. **[fact]** [`session/model-request.ts` L115-125](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/core/src/session/model-request.ts#L115-L125), [`session/instruction-state.ts` L159-169](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/core/src/session/instruction-state.ts#L159-L169).
- Before each step and each retry, the runner reads the sources again and compares hashes. It writes an update only when a value changed. **[fact]** [`session/runner/llm.ts` L227-233](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/core/src/session/runner/llm.ts#L227-L233), [`instructions/index.ts` L144-161](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/core/src/instructions/index.ts#L144-L161), [`instruction-state.ts` L38-61](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/core/src/session/instruction-state.ts#L38-L61).
- The update is a durable system message, appended in time order to the history. **[fact]** [`session/message-updater.ts` L154-165](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/core/src/session/message-updater.ts#L154-L165).
- After compaction, a new baseline covers the old updates, and the history drops them. **[fact]** [`session/history.ts` L225-237](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/core/src/session/history.ts#L225-L237).
- For the Claude Code provider, opencode drops its own date because "Claude Code writes its own date". **[fact]** [`plugin/provider/claude-agent/instructions.ts` L17-18](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/core/src/plugin/provider/claude-agent/instructions.ts#L17-L18).
- In Code Mode, `Date.now()` and `new Date()` read the current time. **[fact]** [`packages/codemode/interpreter-support.md` L478-479](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/codemode/interpreter-support.md).
- The owner's memory ("refresh after a gap") is not correct. The trigger is a change in the date value, not a time gap. It has the same effect: a note appears only on the first step of a new day. **[fact for the trigger; inference for the effect]**

### 3.2 pi

- In March 2026, pi changed "Current date and time" (with seconds) to "Current date" (ISO date) in the system prompt. Issue #2131 has the title "Time in system prompt breaks prompt caching". **[fact]** commit [`4b9e600`](https://github.com/earendil-works/pi/commit/4b9e6006fad553dcca5aa69b23a039088064589f), [issue #2131](https://github.com/earendil-works/pi/issues/2131).
- In July 2026, pi removed the date from the system prompt. The reason was the cache miss after midnight or on resume. **[fact]** commit [`f4e9ca7`](https://github.com/earendil-works/pi/commit/f4e9ca7466b5576090d1093c27fe38d73909f3d2), [issue #6621](https://github.com/earendil-works/pi/issues/6621).
- At `5a14e69`, pi has no built-in date. A comment on #6621 says that no replacement was added. Users add their own extension. **[fact]** `packages/coding-agent/src/core/system-prompt.ts` has no date; [issue #6621 comments](https://github.com/earendil-works/pi/issues/6621).
- pi's Code Mode runs in UTC, and its test runtime keeps `Date.now()` deterministic. **[fact]** [`packages/codemode/test/deterministic.test.ts`](https://github.com/earendil-works/pi/blob/5a14e69c067d40dfbff4f2fff7d3b34c897e2dc9/packages/codemode/test/deterministic.test.ts) (L148).

### 3.3 Claude Code

- I found no official document that says how or when Claude Code refreshes its date. **[fact: absence after a search]**
- Community issues report a date-only `currentDate` line, no time of day, and a cache rewrite once per day. One asks to move the date into the first human turn. **[unverified, community reports]** [anthropics/claude-code#87487](https://github.com/anthropics/claude-code/issues/87487), [#32913](https://github.com/anthropics/claude-code/issues/32913).

### 3.4 Anthropic prompt caching

Source: [prompt caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching). **[fact for each item]**

- "Changes at each level invalidate that level and all subsequent levels." A change to a tool definition invalidates the full cache.
- Writes occur only at a breakpoint. The lookback checks at most 20 positions for each breakpoint.
- Tokens after the last breakpoint are billed as normal input (`input_tokens`). Alfred puts a breakpoint on the last message, so in practice no uncached tail exists (`request-projection.ts:104`). The probe shows 4 uncached tokens on each call.
- The docs give this advice: "For a prompt with a varying suffix (timestamps, per-request context, the incoming message), place the breakpoint at the end of the static prefix, not on the varying block."
- A cache hit refreshes the TTL at no cost. A 5-minute write costs 1.25x, a 1-hour write 2x, and a read 0.1x the base price.
- The minimum cacheable prompt for Claude Haiku 5.5 is 512 tokens.

## 4. Design options

The requirement: the model always knows "now" and the user's zone. No cache break. No `system.current_time`.

A chat run lasts seconds to minutes. Prod `run_53fo` lasted 93 seconds (03:01:02 to 03:02:35). **[fact]** A run can park for an approval or a sub-agent join, and an approval can wait for hours. **[fact]** `chat-turn-state.ts:189-205`.

### A. Date in the system prompt, exact time in the newest user message (ephemeral)

- Cache: the system date breaks the full cache once per day for each thread. If the time line is not stored, it causes the same cross-turn break as today. **[inference; section 2.3]**
- Staleness: same as today.
- Verdict: no. Both halves break the cache.

### B. Time stamp on each user message, rendered from stored data (recommended)

- Each user message in the model view starts with one short line, for example `<sent_at>Thu 19 Nov 2026, 09:10, Asia/Kolkata (UTC+05:30)</sent_at>`.
- Render it from `chat_messages.created_at` and the user's zone when the transcript is built. `ChatContextMessage` already has `createdAt` (`packages/assistant/src/chat/compaction/chat-context-assembly.ts:9-12`, `:97-101`). **[fact]**
- Cache: zero break. The bytes for an old message never change, so the prefix grows by append only. The probe shows the same cost as no time. **[fact, probe]**
- Granularity: minutes. Seconds add no value to a user and add noise. **[inference]**
- Staleness: the stamp is the send time. Without a park, the error is at most the run length, which is minutes. **[inference]**
- Extra value: the model sees the gap between messages, for example "you asked this yesterday". **[inference]**
- Zone: the `timezone` preference (`user-settings.ts:71-76`). If the user changes the zone, old stamps render again with the new zone. That is one full cache rewrite for each thread, one time. This is rare and acceptable. To avoid it, store the zone with each message. **[inference]**
- Risk: a user who never sets a zone gets `UTC`. That risk exists today too. **[fact for the fallback]**

### C. Time note appended only after a gap or a date change

- On resume after a park of N minutes or more, or when the local date changed since the last stamp, append one note at the end of the transcript, for example `Current time: 14:32, Asia/Kolkata. The run waited 2 h 10 min for approval.`
- Store the note in the run transcript, so later steps send the same bytes. `appendSystemNote` already appends a user-role note at the end (`packages/assistant/src/execution/transcript-notes.ts:24-38`). **[fact for the helper]**
- Cache: zero break, because it is append-only. **[inference from the docs]**
- This is the opencode pattern ("changed" render) plus the park case. **[fact for opencode]**
- Alone, it is not enough. It needs a baseline, and option B is that baseline. **[inference]**

### D. Time inside each tool result envelope

- Cache: zero break, because results are appended. **[inference]**
- Staleness: the best of all options.
- Cost: tokens on every result, and noise in results that the model must ignore. It also mixes time into every integration result. **[inference]**
- Verdict: not necessary when B and C exist.

### E. A host function `now()` in Code Mode

- The sandbox already has a live clock. A probe of `run@2.1.13` returned the real instant from `Date.now()` and `new Date()`. `run` keeps them deterministic across replay. **[fact]** probe 2026-11-19; `node_modules/.pnpm/run@2.1.13_typescript@7.0.2/node_modules/run/README.md:389-390`.
- The guest zone is the host zone. On a laptop it was `GMT+0530`. On the Railway server it is probably UTC. **[fact for the laptop; inference for the server]**
- Thus a script gets the live instant without a new host function. It needs the user's zone and offset, and the stamp in option B gives both. **[inference]**
- This covers the rare case where exact wall-clock time matters after slow work. It does this without a kernel tool. **[inference]**

## 5. Recommendation

Use **B + C**, and rely on **E** as it exists today.

1. Stamp each user message in the model view with its send time. Render it from `created_at` and the user's zone, at minute granularity. Never change the bytes after the first render. **[inference]**
2. Append one stored time note when a run resumes after a park of 5 minutes or more, or when the local date changed since the last stamp. Do not move or rewrite earlier text. **[inference]**
3. Remove the time line from the ephemeral `<runtime_context>` message. After that, the ephemeral message appears only when artifact context exists, and that removes the cross-turn break on most turns. **[inference from `chat-turn.ts:459-466`]**
4. Remove `system.current_time` from the kernel. It had 0 uses in prod chat in 30 days (section 2.1). Removing it changes the tools array one time, which is one full cache rewrite for each live thread. **[fact for the usage; inference for the cost]**
5. Change the prompt rules at `chat-turn.ts:153-154`. They must name the message stamp and the time note, and say that `new Date()` in a script is the live instant. **[inference]**

### Residual risks and side findings

- Direct read path (no Code Mode): no live clock inside a run. The error is the run length plus any park before the next note. **[inference]**
- The artifact facts and the artifact reference ride the same ephemeral message. They will still break the cross-turn cache on turns that have them. That is a separate decision. **[fact for the placement; inference for the effect]**
- The 5-minute park grace does not match the 1-hour chat TTL (section 1.1). Option C makes the grace a staleness rule only, not a cache rule. **[inference]**
- Sub-agents and workflows keep a date-only line in the system prompt. A step after local midnight misses the cache for that step. These runs are short, so the cost is small. They can use option C later. **[inference]**
- Two in-run cache misses in prod and dev are probably tool-array changes, not time. They need their own check. **[inference]**
