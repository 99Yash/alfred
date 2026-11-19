# ADR-0130 — Chat reads ask only for secrets, with one size rule and discovery in the sandbox (ACCEPTED — 2026-11-19)

**Status.** Accepted. Owner decisions, given in session on 2026-11-19. Decision 1 has amendment (a), 2026-11-19: the owner's review sets the class and the output of a read that it confirms. Decision 9 waits for a probe of the Linear read-only endpoint. The value of X in decision 7 comes from an eval.

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
  - An MCP tool with no integration default has no class. Thus it asks until code classifies it.
- **Wrong texts.** ADR-0096:52 and `mcp/risk.ts:22` say that `low` reads already run with no card. That was false. The change that builds this decision corrects both texts.

#### Amendment 2026-11-19 (a): the source that confirms a read sets its class and its output

Owner decision, 2026-11-19 (#1799 part 2). Decision 1 says "Code owns the class". That holds only for a read that code confirms. On a server that the owner added, for example Railway or Sentry, only the owner's review confirms a read (ADR-0096). Before this amendment, a review cancelled the code class and held no class of its own. It also held no output kind. Thus a reviewed read always asked under `gated`, and it could never run in a script (`undeclared_output`).

- **The rule:** the source that confirms the read sets its class and its output.
  - Code confirms a read with a code pin or a built-in read-only endpoint, for example GitHub and Google. Code sets the class (decision 1) and the output (`builtInOutputKind`).
  - The owner's review of one exact descriptor confirms a read on any server. The review then also sets the class and the output.
- **The review form** on the integrations page gets two fields: the read class (`secret` or `ordinary`) and the output kind (`structured` or `binary`). `mcp_tool_policy` gets two nullable columns, `read_class` and `output_kind` (migration 0176). The contract accepts the two fields only on a review with the effect `read`.
- **An empty field changes nothing:**
  - An empty class gives no class, so the read asks under `gated`. The integration default does not fill it.
  - An empty output falls back to code's output. A server that the owner added has none, so the read stays direct (`undeclared_output`).
- **One floor stays with code:** a read in code's secret list (`BUILT_IN_SECRET_READS`, for example GitHub's `run_secret_scanning`) is `secret` under any review.
- **Drift:** a review under another descriptor hash confirms nothing, and it cancels the code class and the code pin, as before.
- **Residual risk:** the owner can mark a read `ordinary` that can show a secret. That read then sends the secret to the model with no card under `gated`. The owner owns this choice for a server that the owner added.

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

- **The owner rule:** the model must be able to know the current time, and the time must not break the prompt cache. A time line on each message is noise. The model must see when a message arrives after a long pause, and when a task or a wait was open during that pause.
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
