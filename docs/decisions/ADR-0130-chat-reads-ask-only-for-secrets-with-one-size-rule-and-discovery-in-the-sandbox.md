# ADR-0130 — Chat reads ask only for secrets, with one size rule and discovery in the sandbox (ACCEPTED — 2026-11-19)

**Status.** Accepted. Owner decisions, given in session on 2026-11-19. Decision 1 has amendment (a), 2026-11-19: the owner's review sets the class and the output of a read that code does not confirm. Decision 4 has amendment (b), 2026-11-19: the result of each card carries the cause. Amendment (c), 2026-11-20, replaces the stored list of amendment (b): the row keeps the reason, and one function derives the settings from current policy. Decision 7 has amendment (d), 2026-11-21: where the turn context is saved. Amendment (e), 2026-11-21, replaces one rule of decision 7: each user message carries a short send stamp, and `system.current_time` leaves the kernel. Decision 9 waits for a probe of the Linear read-only endpoint. The value of X in decision 7 comes from an eval.

Amends: [ADR-0034](./ADR-0034-human-in-the-loop-approval-taxonomy-action.md) (the tier is only a UX hint), [ADR-0069](./ADR-0069-high-risktier-tools-always-confirm-a-hard.md) (the approval formula), [ADR-0087](./ADR-0087-code-mode-rung-b-v1-is-context-virtualization.md) (handles), [ADR-0096](./ADR-0096-a-read-only-mcp-surface-downgrades-structurally.md) and its 2026-11-13 amendment, [ADR-0124](./ADR-0124-code-mode-is-the-chat-read-path.md) amendment (b) and decision 8, [ADR-0125](./ADR-0125-the-model-reads-github-through-the-github-mcp-only.md) decision 2, [ADR-0126](./ADR-0126-the-model-uses-google-workspace-through-the-google-mcp-servers.md) decision 4, and `CONTEXT.md:45-46`.

Research inputs (untracked, in `docs/research/`):

- `code-mode-prior-art-opencode-pi-2026-11-19.md`
- `code-mode-prior-art-cloudflare-2026-11-19.md`
- `read-sensitivity-classes-2026-11-19.md`
- `linear-read-authority-2026-11-19.md`
- `discovery-in-sandbox-2026-11-19.md`
- `time-awareness-cache-safe-2026-11-19.md`

## Problem

Live runs on 2026-11-19 used Haiku 5.5 with Code Mode on. Prod and dev each had one run. The question was "see alfred's issues". The runs showed four faults:

1. **Every read under `gated` asks.** The rule is `policyMode === "gated" || riskTier === "high"` (`approval-rule.ts:18`). A GitHub `list_issues` needs a card. A card sends the read to the direct route, so Code Mode gives nothing. The owner clicked 6 cards. Linear has no read authority, so a Linear read can never run in a script.
2. **The model cannot see where a tool runs.** Only `system.search_tools` gives the route (script or direct). The prompt sends the model to `mcp.list_tools`, which gives no route. Thus the first script read was refused in both runs.
3. **A cut on each string destroys list results.** The 8,000-character cut keeps about 8 items of a 9 KB JSON list. It probably also removes the cursor at the end, so the model cannot page. The chat boundary applies the same cut to the `code_run` value too, and the model does not know this. A script value that is more than 55 KiB is lost. Three prompt texts tell the model to "return a small result", so the model cut each issue body to 260 characters.
4. **The tool surface is large, and the turn context breaks the cache.** The first Code Mode turn sends 5,167 tokens of tools. The `<runtime_context>` message holds the time and the artifact context. It goes in before the newest user message and is not saved (`turn-context-guard.ts:21-40`). Thus each new turn writes the full history to the cache again. A probe on turn 2 read 1,230 tokens from the cache and wrote 5,444.

## Decision

### 1. A read asks only when it can return a secret (settled)

- **The owner rule:** a read that does not destroy data and does not show a secret runs with no card.
- **A secret** is a value that gives access. Examples are an env var, an API key, a token, a password, a private key, a webhook secret, and a secret-scanning alert. Mail bodies, files, issue bodies, and titles are not secrets.
- Each read with read authority has one class:
  - **`secret`:** for some valid input, the read can return a secret.
  - **`ordinary`:** no valid input returns a secret.
- **The approval rule becomes this:**
  - `high` always asks.
  - Under `gated`, a confirmed `ordinary` read runs with no card. Thus it can run in a script.
  - Under `gated`, a `secret` read and a read with no class still ask.
  - Under `autonomy`, the rule does not change.
  - Full Autonomy removes all cards for one thread. This does not change.
- **Code owns the class.** Each integration declares a default:
  - An integration that stores credentials as a product feature has the default `secret`. Examples are GitHub, Railway, and Vercel. A code pin marks each of its reads `ordinary`. When a pin drifts, the read asks. That failure is safe.
  - An integration that does not store credentials as a product feature has the default `ordinary`. Examples are Gmail, Calendar, Drive, and Linear. A code override marks a read on it `secret` if necessary.
  - Each curated read has a field for the class. The compiler requires the field.
  - An MCP tool with no integration default has no class. Thus it asks until code or the owner's review classifies it (amendment (a)).
- **Wrong texts.** ADR-0096:52 and `mcp/risk.ts:22` say that `low` reads already run with no card. That was false. The change that builds this decision corrects both texts.

#### Amendment 2026-11-19 (a): code owns the class of a read that it confirms, and the owner's review owns the class of any other read

Owner decision, 2026-11-19 (#1799 part 2). On a server that the owner added, for example Railway or Sentry, code never confirms a read: it has no code pin and no read-only endpoint. Only the owner's review confirms the read (ADR-0096). Before this amendment, a review held no class and no output kind. Thus a reviewed read always asked under `gated`, and it could never run in a script (`undeclared_output`).

- **The rule:**
  - Code owns the class and the output of a read that code confirms. Code confirms a read with a code pin of the exact descriptor or with a built-in read-only endpoint, for example GitHub and Google (`codeOwnsReadClass`). An owner review of such a read still decides the effect, but its class and its output have no effect.
  - For any other read, the owner's review of the exact descriptor sets the class and the output.
- **The review form** on the integrations page gets two fields: the read class (`secret` or `ordinary`) and the output kind (`structured` or `binary`). `mcp_tool_policy` gets two nullable columns, `read_class` and `output_kind` (migration 0176). The contract accepts the two fields only on a review with the effect `read`.
- **An empty field changes nothing on a server that the owner added.** An empty class gives no class, so the read asks under `gated`. The integration default does not fill it. An empty output gives no output, so the read stays direct (`undeclared_output`).
- **One change for a reviewed read that code confirms.** Before, the review cancelled code's class, so the read had no class and asked under `gated`. Now code's class applies. A pinned GitHub read that the owner reviewed as a read is `ordinary`, so it runs with no card under `gated`.
- **Drift:** a review under another descriptor hash confirms nothing, as before.
- **Residual risk:** the owner can mark a read `ordinary` that can show a secret. That read then sends the secret to the model with no card under `gated`. The owner owns this choice for a read that code does not confirm.

### 2. `system.*` tools run with no card (settled)

- Each `system.*` tool runs with no card in all modes. This includes the reads (`search_context`, `corpus_search`, `fetch_url`, `web_search`) and the writes.
- `system.remember` loses its confirm card. It saves at once, and the reply states what it saved.
- Two exceptions:
  - `system.activate_workflow` keeps its card. Activation gives a workflow future autonomy with writes. Its tier stays `high` (ADR-0069).
  - `system.ask_user` keeps its card, because the card is the question.

### 3. `system.fetch_url` fetches only a URL that came from outside the model (settled)

- **The threat.** With decisions 1 and 2, more third-party text gets into the context with no card. An injected mail or issue can tell the model to put private text into a URL. `system.fetch_url` then sends that URL out. It has no card (decision 2).
- **The guard.** `system.fetch_url` fetches a URL only if the URL appears exactly in the user's words, or in an earlier tool result in the thread. A URL that the model builds is refused with a cause. Decision 4 gives that cause to the model, and the model can then ask the user to paste the URL.
- The redirect checks and the private-host checks in `fetch-url.ts` stay.
- This matches the rule of Anthropic's server-side `web_fetch` tool. Before code, verify that rule against the Anthropic documentation.
  - Verified on 2026-11-19 ([web fetch tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool)). The tool fetches a URL from a user message, a client tool result, or an earlier search or fetch result. "Claude cannot fetch URLs that appear only in its own output." The error is `url_not_in_prior_context`. The page does not say how the match works.
- **The sources** (owner, 2026-11-19, built in #1803):
  - A chat turn: the user messages of the thread, their attachment text, and the stored tool results of each chat-turn run of the thread.
  - A sub-agent: the sources of its parent thread, and the tool results of its own run. Its brief does not count, because the parent model wrote it.
  - A workflow run: the brief that the user activated counts as the user's words. The trigger event and the tool results of the run count as tool results.
  - Each run: its own stored tool results, with the nested reads of a script. A sub-agent of a workflow also gets the sources of its parent run.
  - **A tool result counts only when it is outside text.** Each read declares `outsideText` when its result comes from outside Alfred and the model: a connected service, the web, or the user's synced data. A result that echoes the model never counts. Examples are a script's return value, a read of chat history, scratch, memory, and a write. An `mcp.call` result counts only as a confirmed read. Without this rule, the model can return a built URL from a script and then fetch it.
- **The match.** The URL, with no scheme and no final `/`, must appear in the text. The text around it must end the URL. Thus "yashk.xyz" from the user allows `https://yashk.xyz/`. The model cannot add a host label, a path segment, or a query.
- Writes are the other path out, for example a mail send. Writes keep their cards under `gated`. Full Autonomy waives those cards by owner choice.

### 4. A block names the setting that removes it (settled)

- **The owner rule:** when a setting blocks what the user asked for, the agent tells the user which setting the user can change.
- One function, `approvalCause`, sits beside the approval rule. For each card or refusal, it returns the cause and a closed list of the settings that remove it. The list holds the mode on the integration page, Full Autonomy for the thread, and "Always allow" for the tool.
- A new `Fix` kind, `change_setting`, carries the list to the model and to the web. The web shows the links. The model writes the words. No prompt rule is added. This follows "code supplies the facts, the model writes the copy".
- The staging row stores the real provider, for example `github`, not `mcp`. Then the card and the cause can name the provider.

#### Amendment 2026-11-19 (b): where the model gets the cause

Owner decision, 2026-11-19 (#1800). In chat, a card stops the turn, so the model cannot write while the card waits.

- **The rule:** the tool result of a card that the user approved, rejected, or let expire carries the cause (`approvalCause`). The script refusal `needs_approval` carries it too. The model then writes one line about the setting.
- **The web:** the card head shows a switch for the integration mode and for "Always allow" when the list holds them. For Full Autonomy, it shows a line that names the mode menu beside the card. The saved reply shows the setting links under the reply.
- **The list:** it holds only the settings that remove the card for this call.
  - A `high` card lists only Full Autonomy. Outside a chat thread, no setting removes it, so it has no cause.
  - A tool override that asks beats the integration mode, so only "Always allow" is listed.
  - The integration mode is listed only when a page can set it. A server that the owner added has the internal `mcp` slug, and no page sets its mode. Outside a chat thread, such a card thus has no cause.
  - "Always allow" is not listed for `mcp.call`. One override on it would cover every server, and it has no effect on a built-in provider.
  - A `confirm` card, a question, and a restaged card that may have run have no cause.
- **The row:** `action_stagings.approval_cause` keeps the cause (migration 0177). A replay reads the same row, so it gives the same cause.

#### Amendment 2026-11-20 (c): the reason is a fact of the call, and the settings are a fact of current policy

Owner decisions, 2026-11-20 (#1800 review). This amendment replaces "The list" and "The row" of amendment (b). The rule of amendment (b) for where the model gets the cause stays.

**The fault.** A review of #1800 found 12 faults. They have one root: amendment (b) stores a list of settings at the time of the card. The list mixes two facts with different times:

- The reason why the call waited. This fact does not change after the card.
- The settings that remove such a card. This fact is a fact of the current policy and of the controls that a page has.

Also, `approvalCause` applies the approval rule a second time, apart from dispatch. Thus the two can disagree, and five call sites attach the cause by hand. This was the third patch in this area, so the theory was written again (theory principle 2).

**The rule.**

- **One decision.** Dispatch makes one approval decision for each call. The decision holds the reason and the source of the mode:
  - the reason: `high_risk`, `may_write`, `secret_read`, or `unclassified_read`;
  - the source: the rule on one tool, the rule on one server tool, the integration mode, the global default, or the `high` tier.

  No other code applies the approval rule again to explain a card. The result boundary attaches the reason to each result that a card produced. This includes a rejected proposal that is replayed under a new call ID.

- **The row keeps the reason, not the settings.** `action_stagings` keeps the reason and the source. The reason is a durable fact of the call.
- **One function derives the settings.** A shared function takes the reason and the current policy. It returns each setting that removes such a card now. It runs when a surface shows the settings: the model fact, the card, the saved reply, the approvals queue, and a workflow card. The same eligibility rules apply to the settings that it gives and to the policy writes that the mutators accept.
- **Which settings.** The list holds each setting that removes the card, narrowest first. A one-time approval stays the main action.
  - "Always allow" for this action. For a call on an MCP server, this is a rule on one server and one remote tool. The rule is bound to the descriptor hash, so a changed tool asks again. One rule on `mcp.call` for all servers is still not offered.
  - The integration mode, only when the integration page has the mode control.
  - Full Autonomy for this chat, only in a chat thread.
  - The global default is named as the source when it supplied the mode. It is not offered, because it changes every integration.
  - A `high` card lists only Full Autonomy.
- **Each setting states its scope.** The card, the saved reply, and the model fact say what each setting authorizes: this action, this integration, or this chat.
- **Full Autonomy always opens the picker of ADR-0069.** No link or button turns it on at once. The picker says that the change applies to future calls that the mode can waive. A pending approval, a question, and a `confirm` card still wait.
- **The reason in the card comes from the decision.** The card does not infer the reason from the tier.
- **Code Mode.** A script refusal `needs_approval` gives typed reason facts to the host ledger. The `code_run` result carries them to the model, within its size bound. A script that catches the refusal does not lose them.
- **All approval surfaces.** The chat card, the saved reply, the `/approvals` queue, and the workflow approvals tab show the settings (ADR-0034).
- **The acceptance case.** A confirmed secret read, for example `vercel.request` under `gated`, gives a reason that the model receives. The owner can reach each named control. The Linear example of #1800 changes with #1804, so it is not the acceptance case.

**Owner decision 2026-11-20 (#1818): the switch.** "Always allow this action" shows on only for a rule that allows the action. Turning it off removes the rule, so the integration mode governs the action again. It does not write an "ask first" rule.

**The rule on one server tool (#1819).**

- **Where it is kept:** in the policy row beside the tool overrides, `integrationRules[integration].serverToolOverrides[connectionId][remoteName] = { mode, descriptorHash }`. `integration` is the server's provider, else `mcp`. The rule is synced and cached with the rest of the policy.
- **Not in `mcp_tool_policy`:** a row there is an owner review. A review changes the tier rules of ADR-0096: it beats a code pin, and a drifted review keeps the floor. "Always allow" must not change the tier.
- **The bind:** the rule applies only while the tool keeps `descriptorHash`. One connection keeps one rule for each remote tool, so a new rule replaces an old one.
- **The write:** the server accepts the rule only for a connection that the user owns, under the integration of that connection. It sets the rule only at the descriptor of the current catalog. A clear always applies.
- **The places:** the Permissions menu of a card, and the tool's switch in "View tools" of the server's connection. "View tools" also lists the rules of the connection, with Reset, so a rule on a tool that left the catalog can be removed. The page of a live provider lists the rules of its server tools under "Action exceptions", and it can add a tool exception.
- **Residual risk:** a removed connection leaves its rules in the policy row. They match no call. A list does not know the current descriptor, so it says that a changed tool asks again, and it does not mark an old rule.

**Rejected.**

- **Keep the stored list and fix each fault.** The list can be out of date, and each fix stays a patch on two copies of the rule.
- **Offer only the narrowest setting.** The owner wants each control that removes the card, with its scope stated.
- **A mode control on the pages of MCP-only providers.** The rule on one server tool is the narrow control. It also covers a server that the owner added.

### 5. One size rule: a result is bounded by its structure where it goes to the model (settled)

- Remove the cut on each string, at the direct boundary and at the chat boundary.
- Bound a result where it goes to the model:
  - Keep the JSON valid.
  - Keep whole items from the start.
  - Keep the cursor.
  - Give the count of dropped items.
  - Parse a JSON text in an MCP result, and bound it as structure.
- A script always gets the full result. Only the value that the script returns is bounded.
- An overflow does not lose data. It gives a handle (ADR-0087), and a later script reads the handle with `load(handle)`. This applies in three cases:
  - a direct result over the bound;
  - a script value over the bound;
  - a result from an earlier turn.

  The trigger of ADR-0124 decision 8 is met.

- **Earlier queries stay available to the model.** Today a new turn replays only the user text and the assistant text, not the tool results (`chat-turn.ts:1005-1045`). Thus the model must fetch the data again. With handles, the transcript keeps one short line for each earlier result:
  - the handle;
  - the query that made it;
  - the count of items;
  - the fetch time.

  The model does not get the data again, only the reference (context virtualization, ADR-0087 and `docs/plans/context-working-set-considered.md`). For a follow-up, the model runs `load(handle)` in a script, or it fetches new data when the old data is too old. The fetch time lets it choose.

- The `code_run` contract states the real limits. It says that a value over the bound becomes a handle. It also says that code can filter known fields but cannot judge prose. The three "return a small result" texts are removed.
- Each limit comes from a measurement in Alfred, not from the prior art. Cloudflare uses 6,000 tokens, and opencode and pi use 50 KB.

### 6. Discovery runs inside the sandbox after an eval proves it (settled, with conditions)

- `system.search_tools` and `system.load_tool` become host functions in the sandbox, for example `tools.search` and `tools.describe`. `mcp.list_tools` and `mcp.inspect_tool` already run only in scripts.
- The model-visible list becomes fixed for the run:
  - `system.code_run`
  - `system.ask_user`
  - `mcp.call`, for writes
  - the curated write path
  - one merged sub-agent tool
- The conditions:
  - **C1.** Each search hit gives its route, its approval need, and its class. The set that search shows is the set that a script can call. This rule alone fixes fault 2, before the move.
  - **C2.** `mcp.call` stays on the fixed list, so a write needs no load step. A curated write has one named path.
  - **C3.** One ranking function, `searchAvailableTools`, serves all search.
  - **C4.** Each host call stays a nested dispatch with its own route check and approval check.
  - **C5.** A third mode in `code-mode-paired.eval.ts` passes on Haiku 5.5 before the change ships. The eval adds three cases: a write, a repeat of the live run, and a request that names no tool. It measures refused calls, scripts that only discover, steps, and the share of cached input tokens.
  - **C6.** A run that started on the old surface keeps the old surface.
- The research found no security gain at the host boundary. The gains are a fixed tool list, which keeps the prompt cache, and fewer plumbing steps.
- Other surface cuts, with no new theory:
  - The `code_run` index lists only the reads that the user can call. This saves about 1,850 tokens on each turn.
  - `system.spawn_sub_agent` and `system.await_sub_agent` merge into one lazy tool. Prod used neither tool in 90 days.

### 7. The model asks for the time, and the runtime tells it only when time has passed (settled)

- **The owner rule:** the model must be able to know the current time, and the time must not break the prompt cache. A time line on each message is noise (amendment (e) replaces this sentence). The model must see when a message arrives after a long pause, and when a task or a wait was open during that pause.
- **The model asks.** The model gets the time when it needs it:
  - Until decision 6 ships, it calls `system.current_time`.
  - After decision 6 ships, it calls a host function `time.now()` in the sandbox. The function gives the local time, the user's timezone, and the UTC offset. A script's own `new Date()` uses the server timezone, so it is not sufficient.
- **The runtime tells the model only when time has passed.** The runtime adds one time note at the end of the transcript in two cases:
  - the first user message of a thread;
  - a user message, or a run that continues, after a pause of X minutes or more, or after the local date changes.
- **The time note.**
  - It holds the current local time and the time that passed since the previous message.
  - It also lists each open item on Alfred's side with its age. Open items are a parked approval, a sub-agent, a workflow run, an unanswered `system.ask_user`, and a long run.
  - The model judges if the pause matters. A wait on the user's side, for example "I will deploy and tell you", is in the transcript. The model judges it from the elapsed time. Code does not try to detect it (theory principle 4).
  - The note is saved, so it never changes later. A note at the end of the transcript does not break the cache.
- **The value of X** is one constant. It starts at 30 minutes. The eval in this decision sets the final value. The 5-minute value at `grounding.ts:29` goes away. Its comment says that 5 minutes "matches the provider's idle cache lifetime". That is false, because chat uses the 1-hour cache (`agent.ts:109`).
- **The time of each query.** Each handle line carries its fetch time (decision 5). Thus the model knows the age of each earlier query.
- **The artifact context.** It is saved with the user message of its turn, at the state of that moment. It no longer goes into an unsaved message before the newest user message.
- **Removals.** The `<runtime_context>` message goes away. Thus no part of the turn context breaks the cache.
- **The risk, and its eval.** The model can fail to ask for the time when it needs it. An eval case on Haiku 5.5 checks this. Examples are "is it too late to mail them today?" and "what is left on my calendar?". If the model does not ask, the fix is a change to the tool description, not a time line on each message.
- **Prior art.** opencode puts the date in the system prompt, and adds a saved message when the date changes. pi removed the date for cache reasons. In pi, code mode has no clock function (Ronacher, "What is Codemode", 2026-10-06).

#### Amendment 2026-11-21 (d): where the turn context is saved, the body rule, and the open items (#1802)

- **Storage.** The turn context of a user message is one row in `chat_turn_contexts`, keyed by the message id. Admission writes it once, in the transaction that creates the run. It is not a `chat_messages` column, because Replicache syncs each column of that table to the browser, and the context can hold an artifact body.
- **Place.** The context goes after the user's own text, in the same user message. A separate message would move the replay tail of the foreground compaction.
- **The body rule (owner, 2026-11-21).** The full body of the selected artifact shows only where its row version first appears in the replayed window. A later message with the same row version shows one line that points to that copy. The window changes only at compaction, and compaction replaces the cached prefix in any case.
- **Open items (owner, 2026-11-21).** At a new message, the note lists no open items. A thread has one run at a time, and a parent run waits for its sub-agents before it answers, so no item of the thread can be open. A resumed run names what it waited on (an approval, a question, or a sub-agent), the wait time, and the run's age.
- **The note of a resumed run** is a `[system]` note at the end of the run transcript. It is saved with the step. The next turn does not replay it, the same as tool results.

#### Amendment 2026-11-21 (e): each message carries its send time, and `system.current_time` leaves the kernel (#1802)

This amendment replaces the rule "a time line on each message is noise" in decision 7.

- **The owner rule (2026-11-21).** A full time line on each message is not necessary. But the model must always have a sense of the time. It must see the time between messages when that time is important, and not only when it asks.
- **The send stamp.** The send stamp is the short form of the time note. Each user message gets a short saved stamp of its local send date and time, for example `<sent>Sat Nov 21, 17:42</sent>`. The stamp costs about 12 tokens. It holds the date for two reasons. Compaction can remove the last full note. A message from before #1802 has no note.
- **The full note stays.** The first message of a thread, a message after a pause of `TIME_NOTE_PAUSE_MS` or more, and a message on a new local date get the full `<time_note>` in place of the stamp. Thus each user message has exactly one of the two.
- **What the model knows.** The time on the newest message is the time when the reply starts. The model compares the times on two messages to see the gap.
- **`system.current_time` is lazy.** The model needs the tool only when work inside one run takes long and the answer depends on the current time. Thus the tool leaves the kernel. The model can call it by name: the call loads it for the next step. The kernel loses 393 B on each prompt.
- **The resumed run.** The `[system]` note of amendment (d) does not change.
- **A new attempt.** A run can take a user message that an earlier run already took, for example a retry after a failure. The saved note gives the send time, not the time of the attempt. If the attempt comes after the pause or on a new local date, the run gets a `[system]` time note with the current time and the time since the send. The note goes at the end of the run transcript, so it does not break the cache.
- **One byte gate for each read path.** `schema-budget.test.ts` keeps the kernel ceiling of the direct path. It adds a ceiling for the first step of a Code Mode chat: the kernel without the reads that run only in a script, plus `system.code_run`. Code Mode is the default read path, so prod sends this list. Measured 2026-11-21: 23,878 B, and `system.code_run` is 17,863 B of it. #1806 cuts the `code_run` index.
- **The eval.** `time-awareness.eval.ts` scores the answer, not the tool call. The question comes 28 minutes after the last message (a stamp) or hours after it (a full note). A past event must not show as left or next.
- **The cost.** A message replays its saved stamp, so the cache holds. A call of `system.current_time` adds the tool to the list for the next step, and that step does not hit the cache. That call is now rare.

### 8. Rejected wording from the first draft (settled)

- The first draft split reads into `metadata` and `private_content`, so mail bodies and files still asked. The owner rejected that split: only secrets ask.
- Open questions 1 to 3 of the first draft are closed by decisions 1 and 2.

### 9. Linear gets read authority from its read-only endpoint (settled; waits for a probe)

- **Linear's flags are correct.** All 38 `list_*`, `get_*`, and `search_*` tools declare `readOnlyHint: true`, and no write declares it. Only `whoami` has the wrong flag.
- **Linear has a read-only endpoint.** It is `https://mcp.linear.app/mcp/readonly`, with the scope `read`. GitHub gets read authority from the same kind of endpoint, so the GitHub code applies.
- **The proposal.**
  - Probe `/mcp/readonly` with a grant that has only `read`.
  - If the probe passes, Linear reads use that endpoint and get structural read authority. Writes stay on the main endpoint.
  - The model sees one Linear connection. The host sends each call to the correct endpoint by its effect (owner: yes).
  - Linear has the default class `ordinary` (decision 1).
  - The probe also runs one Linear read in a script, end to end. A second gate can stop a read that has read authority. For example, a read with no output kind fails with `undeclared_output`. The probe must show that no gate refuses the read.
- **Rejected options.**
  - A code pin for each Linear read. Linear changed four read tools in 26 days, so each change would show a card until the next deploy.
  - Trust in `readOnlyHint` alone. The owner rejected this on 2026-11-13.

## Slices

Build in this order. Each issue names its decision.

1. #1807 — each search hit gives its route, approval need, and class (decision 6, C1).
2. #1799 — a read asks only for secrets, and `system.*` tools run with no card (decisions 1 and 2).
3. #1803 — `fetch_url` fetches only a URL from the user or a tool result (decision 3). Ship it with or before #1799.
4. #1800 — `approvalCause` names the setting (decision 4).
5. #1801 — one size rule and handles (decision 5).
6. #1802 — the saved time note and the turn context (decision 7).
7. #1804 — the Linear read-only endpoint probe (decision 9).
8. #1806 — the `code_run` index and the sub-agent merge (decision 6, other cuts).
9. #1805 — discovery and `time.now()` in the sandbox, after the eval (decision 6).

## Principles recorded for later theory

- **A handle and an artifact are one object in principle.** Both are stored outputs of a model run. A script can write a large dataset once. The model loads it as a handle, and the user sees it as an artifact. The UI must keep the two apart: a handle is not shown to the user as an artifact unless the model presents it. The UI design needs its own theory with the artifact engine (ADR-0086). This ADR does not build it.
- **Capabilities without a tool for each.** In pi, code mode calls internal APIs, for example `models.generateImages(...)` and `models.classify(...)`, so image generation needs no tool of its own (Ronacher, "What is Codemode", 2026-10-06). The same shape can let a script ask a small model to judge prose item by item. That removes the limit in decision 5, where code can filter known fields but cannot judge prose. It needs its own theory: model cost inside a script, the model choice, and the provenance of each judgment.

## Rejected

- **Shape A: the tier controls the card.** Each tier would need an audit, and the tier does not say if a read returns a secret.
- **Shape B: a third mode, "reads auto", for each integration.** It cannot keep a secret read on cards and let other reads run in the same integration.
- **A split by content (`metadata` against `private_content`).** The owner rejected it. See decision 8.
- **A larger limit on each string.** A cut on each string still breaks the JSON and drops the cursor.

## Residual risk

- **A pasted secret.** A mail body, a file, or an issue can hold a pasted key. An `ordinary` read then sends the key to the model with no card. Decision 1 accepts this.
- **The model provider.** An `ordinary` read sends private content to the model provider with no card. The provider already sees each mail body through triage (`triage/classify.ts:441`).
- **An injection through a write.** The URL guard (decision 3) does not cover writes. Under Full Autonomy, an injected instruction can send text out through a write with no card.
- **A false remember.** `system.remember` with no card can save a wrong instruction. The reply states what it saved, and the owner can remove it.
- **Discovery steps.** Discovery in the sandbox can cost more steps if the model discovers one tool for each script. The 2b eval on Luna took 9 steps against a ceiling of 4. Condition C5 must catch this on Haiku 5.5.
- **Handle storage.** The handle store keeps full results for a time. The time limit and the cleanup come from ADR-0087.
