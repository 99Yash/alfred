# Tool discovery inside the Code Mode sandbox

Status: research, 2026-11-19. This file changes no ADR, prompt, or runtime rule. It answers one owner question: should tool discovery move inside the `system.code_run` sandbox, as Cloudflare's durable runtime does? The owner says yes only if the move gives better responses or better security.

Labels:

- **Fact** — the source states it. A `file:line`, a URL, or a measurement follows the claim. Local source was read at `38c84270c` with the working tree of 2026-11-19.
- **Inference** — my conclusion from the facts. No source states it.

Inputs: [Cloudflare prior art](./code-mode-prior-art-cloudflare-2026-11-19.md), [opencode and pi prior art](./code-mode-prior-art-opencode-pi-2026-11-19.md), [problems note](./code-mode-problems-and-boundaries-2026-11-18.md), [ADR-0124](../decisions/ADR-0124-code-mode-is-the-chat-read-path.md), [ADR-0087](../decisions/ADR-0087-code-mode-rung-b-v1-is-context-virtualization.md), the paired-evaluation receipts in [code-mode-object-handles-v1.md](../plans/code-mode-object-handles-v1.md), and `packages/assistant/evals/code-mode-read.eval.ts`.

## Verdict

**Conditional yes, in two steps. The evidence today does not show "better" for either criterion. One eval run can show it.**

- **Security:** the move does not change the security boundary. The gain is small. It is not a reason to move by itself. (Inference; see section 3.)
- **Responses:** the move can remove one to two model steps for each task that must find a tool. It can also add steps, because a model that writes one script for each discovery call is slower. The 2b eval shows that second pattern. (Inference from facts in section 2.)
- **Cost:** first-turn tool tokens stay almost the same (about −80 tokens of 5,167). The real cost gain is a fixed tool list for the run. Today each `system.load_tool` and each search fold changes the tool list, and on Anthropic that invalidates the whole prompt cache for the next step. (Fact for the cache rule; inference for the size of the gain.)

Move discovery only when all of these conditions are true:

1. **C1. The in-sandbox search quotes the route of each hit.** It must say "script", "direct", or "direct with a card", and why. Today only `system.search_tools` does this. `mcp.list_tools` inside the script does not (section 1). Without C1, the move makes the refused-read pattern of the live run more frequent.
2. **C2. A write is reachable with no load step.** `mcp.call` must be on the fixed surface of a `code_run` run. A curated write needs one named path: keep `system.load_tool` for writes only, or prove that the #407 auto-activation works for a tool that is absent from the tool list.
3. **C3. One ranking.** The host function `tools.search` calls the same `searchAvailableTools` (`discovery.ts:111`) that `system.search_tools` calls today. No second ranker.
4. **C4. The host keeps every check.** Each host call stays a nested dispatch with the route decision, the approval rule, and the broker check. This is true today (`host-bindings.ts:1-5`, `host-bindings.ts:93-105`). The move must not add a host function that skips dispatch.
5. **C5. The paired eval passes in a third mode** (section 6): answer quality not lower on any case kind, refused calls not more, median steps not more, and cost not more. Add a write case and a direct-route custom-server case first.
6. **C6. Old pinned runs keep their surface.** The hide rule must key on a new pinned value, not on `readPath: "code_run"` alone (section 5).

Step 1 (C1 to C4) helps in both shapes and has low risk. Step 2 removes `system.search_tools` and `system.load_tool` from the `code_run` surface only after C5.

## 1. The current shape (verified)

Facts:

- `registerBuiltinTools` builds `system.code_run` last, from every tool with `codeModeRead` (`builtin-tools.ts:43-46`). The description holds the safe-script rules and one index line for each host function (`code-mode/index-text.ts:34-71`). The output types come from `guest-index.generated.ts`, which has 18 host paths and 9,190 bytes (measured with `wc`). The boot check throws when the index and the `codeModeRead` tools disagree (`index-text.ts:20-32`).
- The kernel has ten tools: `system.search_tools`, `system.load_tool`, `system.current_time`, `system.read_chat_history`, `system.spawn_sub_agent`, `system.await_sub_agent`, `system.ask_user`, `system.read_user_context`, `system.web_search` (`internal/tools/system.ts:118-739`), and `system.search_context` (`internal/tools/context-search.ts:23`). The test asserts ten for a live chat boss (`test/tool-runtime/tools/tool-surface.test.ts:89-95`).
- In a `code_run` run, `evaluateReadPath` hides each declared read that never meets a card (`internal/registry.ts:633-655`). The surface builder skips each hidden tool (`surface-adapter.ts:77`). Thus the four kernel reads leave the surface, and the model sees seven tools: `system.code_run`, `search_tools`, `load_tool`, `current_time`, `ask_user`, `spawn_sub_agent`, and `await_sub_agent`.
- Measured schema tokens of these seven tools (the production `estimateToolSurfaceBudget`, chars/4, run on 2026-11-19): `code_run` 3,617; `ask_user` 622; `spawn_sub_agent` 290; `search_tools` 226; `await_sub_agent` 159; `load_tool` 150; `current_time` 103. The sum is 5,167, which agrees with the brief. Other sizes: `mcp.call` 299, `mcp.list_tools` 221, `mcp.inspect_tool` 138.
- **Correction to the brief.** `mcp.list_tools` and `mcp.inspect_tool` are `codeModeRead` and `fast_path` (`internal/tools/mcp.ts:361-440`). A `fast_path` tool never waits for a card (`registry.ts:670-675`), so its static route is the script. Thus in a `code_run` run these two tools are host functions only. They are direct lazy tools only in a direct-read run. MCP discovery is already inside the sandbox in Code Mode. Only `system.search_tools` and `system.load_tool` stay outside.
- `system.search_tools` is the only discovery output that quotes the route. A script-route MCP hit comes back as `system.code_run` with `hostFunction: "mcp.read"` (`discovery.ts:258-271`). A curated script read comes back the same way with its tool name (`discovery.ts:296-308`). Other hits keep their direct name.
- `mcp.list_tools` returns `namespace`, `connection`, `title`, `description`, and `ref` for each hit, with no route and no approval fact (`guest-index.generated.ts`, key `mcp.list_tools`).
- The search fold adds the best available hit to the active tools, except `mcp.call` and `system.code_run` (`system.ts:170-180`). `system.load_tool` adds its tool (`system.ts:241-242`). Active tool names are sorted (`tool-runtime/index.ts:158-159`).
- Writes stay direct (ADR-0124 decision 5). A connected write goes through `mcp.call` (`chat-turn.ts:204`). `mcp.call` is not a kernel tool. The model loads it with `system.load_tool` (`chat-turn.ts:142`).

Live-run facts (from the brief; no run id was given): the model first tried a script read that the runtime refused. Then it called `system.search_tools` and `system.load_tool`. Then it called `mcp.call`.

## 2. Response quality

### What the model gains

- **Discovery and the read in one script.** When the route is "script", one script can search, select, and read. Today a script can already do this with `mcp.list_tools` and `mcp.read` (`index-text.ts:63-66`). The gain applies to curated reads that the model finds with `system.search_tools` today. (Inference.)
- **Filter and rank in code.** A script can drop hits from the wrong connection before the model sees them. Cloudflare makes the same argument: search "returns ranked paths, not complete schemas" ([docs](https://developers.cloudflare.com/agents/tools/codemode/how-it-works/)). (Fact for Cloudflare; inference for Alfred.)
- **The model learns the boundary before the call.** Cloudflare's search and describe return `requiresApproval` for each method ([README](https://github.com/cloudflare/agents/blob/1a450e71325c25ca1ec8b0013d756fe0c733b6f3/packages/codemode/README.md)). opencode tells the model which tools run only inside `execute` ([instructions.ts](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/core/src/codemode/instructions.ts#L9)). If `tools.search` quotes the route (C1), the model does not learn the route from a refused call. (Fact for the prior art; inference for Alfred.)

### What the model loses

- **A script for each discovery.** The model must write code to find a tool. The 2b eval receipt shows the cost: on `gpt-6-luna`, "Discovery used six scripts with one read each (`list_tools`, `inspect_tool`, `search_context`, `read_user_context`, `list_issues`, `inspect_tool`)". The run took 9 steps against a ceiling of 4 ([plan](../plans/code-mode-object-handles-v1.md), "2b eval receipt"). (Fact.) This is the same shape as today's MCP discovery, which is already in the sandbox. The receipt is for Luna, not Haiku 5.5. (Fact.)
- **A write needs an extra round trip.** A script cannot call a write. The model must return the ref and the input schema from a script, then call `mcp.call` in the next step. Today the path is `search_tools` → `load_tool mcp.call` → (often a script with `mcp.inspect_tool`, because `mcp.call` says "Use mcp.inspect_tool if you need the full schema", `mcp.ts:209`) → `mcp.call`. With C2, the path becomes script (search and describe) → `mcp.call`. That is one or two steps fewer for each write. Without C2, it is the same or one step more. (Inference.)
- **A curated write is harder to reach.** A curated write (for example `system.create_artifact` or `system.suggest_todo`) is lazy. Today the search fold loads it. Inside the sandbox, search can name it, but nothing loads it. The undeclared-tool hint says "any other candidate loads when you first call it" (`dispatch/pipeline.ts:1614-1615`), and chat has a #407 auto-activation (`chat-turn.ts:946-947`). I did not find a measurement that Haiku 5.5 calls a tool that is absent from the tool list. (Fact for the code; the behavior is not measured.)
- **The prior art warns about a weak fit.** Anthropic names "Tools that require immediate user feedback between calls" as a weak fit for programmatic calls. On τ²-bench, programmatic calls "left scores unchanged and cost roughly 8 percent more" ([PTC docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling)). Anthropic also says "Keep your 3–5 most frequently used tools non-deferred" ([tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)). (Fact.)

### The live run, step by step

- Step 1, the refused script read: the model called `mcp.read` on a tool whose route was direct. `mcp.list_tools` gave it no route. Thus the cause is the missing route in the in-sandbox search, not the place of the search. C1 removes this step in both shapes. (Inference from the facts in section 1.)
- Steps 2 and 3, `search_tools` and `load_tool`: the model needed the direct form and `mcp.call`. If `mcp.call` is on the fixed surface (C2), the refusal already gives the route, and the model can call `mcp.call` at once. That removes both steps in both shapes. (Inference.)
- Conclusion: C1 and C2 fix the live-run fault. Moving `system.search_tools` inside the sandbox does not fix it by itself. (Inference.)

### Selection accuracy is not the problem

Anthropic says selection "degrades once you exceed 30–50 available tools" ([tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)). The `code_run` surface has seven tools. A drop to five or six tools does not change selection accuracy in a measurable way. (Fact for the source; inference for Alfred.)

## 3. Security

### What the sandbox already does

- The sandbox has no network, no credentials, no modules, and no file system (ADR-0087, amendment 2026-08-19). (Fact.)
- Each host function is a nested dispatch. Thus the gate, the staging row, the span, and the result envelope stay in dispatch (`host-bindings.ts:1-5`). `mcp.read` passes to dispatch, and dispatch decides the route. The broker checks the live descriptor again (`host-bindings.ts:93-105`, ADR-0124 amendment 2026-11-18). (Fact.)
- A script can call only a confirmed read. The hint of a custom server alone does not confirm a read (`read-route.ts:14-23`, `read-route.ts:38-48`). (Fact.)

### Third-party descriptions as an injection surface

- `system.search_tools` sends each MCP hit's description into the model context. The summary is cut at 240 characters (`connections/mcp/list-tools.ts:41`, `list-tools.ts:145-146`), and the default limit is five hits (`discovery.ts:198`). (Fact.)
- `mcp.inspect_tool` returns the full descriptor (`guest-index.generated.ts`, key `mcp.inspect_tool`). In a `code_run` run it is script-only (section 1). Thus a full descriptor reaches the model today only if a script returns it. (Fact.)
- If search moves inside, the five 240-character summaries reach the model only if the script returns them. That is the whole reduction. (Inference.)
- For a write, the model must see the input schema to build the arguments. Thus the script returns the descriptor, and the exposure is the same as today. (Inference.)

### What an injected description can do

- **Inside the sandbox:** the description is a string in a variable. QuickJS has no dynamic evaluation (ADR-0087, amendment 2026-08-19). The string cannot run. (Fact for the runtime; inference for the conclusion.)
- **A ranking attack:** a custom server can write a description that ranks high for common words. A script that calls the top hit without a check can then pick that tool. But a custom-server read has no read authority, so its route is direct, and dispatch refuses it in a script (`read-route.ts:39`). Thus the script cannot call it. (Inference from facts.)
- **After the script returns:** if the script returns an injected description, the model reads it as it does today. The boss still has direct tools with egress, such as `mcp.call`. ADR-0087 names this as the accepted residual risk: "injection → `broker.read` private data → boss-steered send through a real tool remains open". The move does not change it. (Fact for the ADR; inference for "does not change".)
- **The approval check stays at the host for every call.** Writes stay direct, and dispatch evaluates approval when each call runs (ADR-0124 amendment 2026-11-18). Search only quotes the route. "Search reports the current decision. Dispatch decides again." (Fact.) opencode states the same rule: "Tool filtering is catalog visibility, not execution authorization" ([tool/AGENTS.md](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/core/src/tool/AGENTS.md)). (Fact.)

Conclusion: the move gives a small reduction in default exposure. It does not change what an injected description can make the system do. Security is not a reason to move. It is also not a reason to stay. (Inference.)

## 4. Cost

### Tokens on the first turn

| Change | Schema tokens |
| --- | --- |
| Remove `system.search_tools` | −226 |
| Remove `system.load_tool` | −150 |
| Add `mcp.call` to the fixed surface (C2) | +299 |
| Add `tools.search` and `tools.describe` lines to the index | about +60 to +120 (inference) |
| Net | about −80 to −20 |

Facts: the per-tool numbers come from the measurement in section 1. Inference: the index-line estimate assumes two lines like the existing `mcp.*` lines.

- The large term is the `code_run` description (3,617 tokens). About 9 KB of its 14.5 KB is output types from the generated index (fact: 9,190 bytes; inference: the share of the description). Cloudflare keeps the description small with one hint line for each connector, and it gives types through `describe()` ([proxy-tool.ts](https://github.com/cloudflare/agents/blob/1a450e71325c25ca1ec8b0013d756fe0c733b6f3/packages/codemode/src/proxy-tool.ts#L148-L156)). opencode and pi cap the inline catalog at about 2,000 and 3,000 tokens (prior-art doc, L8). (Fact.) A smaller index is a separate decision from the place of search. (Inference.)
- If the move also removes `system.current_time` (103 tokens), the net saving grows by 103 tokens. See the time note in section 5.

### Tokens for each discovery

- Today, a `search_tools` result sends up to five hits with summaries into the context. Inside the sandbox, the script can return one ref. (Fact for today; inference for the saving.) The saving is a few hundred tokens for each search. (Inference.)

### Steps for each task

| Task | Today (`code_run` run) | Discovery inside, with C1 and C2 |
| --- | --- | --- |
| Read a curated tool that the index lists | 1 script | 1 script (no change) |
| Read an MCP tool, route script | 1 to 2 scripts (`list_tools`, then `mcp.read`) | the same |
| Read an MCP tool, route direct (the live run) | refused script, `search_tools`, `load_tool`, `mcp.call` = 4 | script that sees "direct", `mcp.call` = 2 |
| MCP write | `search_tools`, `load_tool`, often a schema script, `mcp.call` = 3 to 4 | script (search and describe), `mcp.call` = 2 |
| Curated lazy write | `search_tools` (fold loads it), call = 2 | script, then load or auto-activation, then call = 2 to 3 |

All rows are inference from the code paths in sections 1 and 2. Most of the step gain comes from C1 and C2, not from the move.

### Prompt cache

- Anthropic caches the prefix in the order tools, system, messages. "Modifying tool definitions (names, descriptions, parameters) invalidates the entire cache." ([prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)). (Fact.)
- Alfred marks the last function tool, the system block, and two transcript points for the cache (`packages/ai/src/request-projection.ts:79-128`). Both chat tiers run on Haiku 5.5 (commit `38c84270c`). (Fact.)
- Thus each `load_tool` and each search fold that adds a tool changes the tool list. On the next step, the full prefix (tools, system prompt, and transcript) is a cache write, not a cache read. (Inference from the two facts.) In a long thread, this cost grows with the transcript. (Inference.)
- A fixed `code_run` surface with no load step keeps the tool list the same for the whole run. Then every step after the first reads the cache. This is the clearest cost gain of the move. It needs C2: if writes still need `load_tool`, the gain applies only to read turns. (Inference.)
- **A per-user index does not cache across users, but Alfred has one user.** The `code_run` description is static today, because it lists no MCP tool: "Each user's MCP tools are different, so the description stays static" (plan, "The index"). (Fact.) If a later change adds per-connection hint lines (Cloudflare's `connectorHints`), put them in the system prompt, not in the tool description. A change to the system prompt keeps the tools cache. A change to a tool description invalidates everything. pi keeps the `codemode` description fixed and appends a changed section to the conversation ([docs/mcp.md](https://github.com/earendil-works/pi/blob/5a14e69c067d40dfbff4f2fff7d3b34c897e2dc9/packages/coding-agent/docs/mcp.md)). (Fact for pi and the cache rule; inference for the placement.)

## 5. The minimal surface

### The model-visible surface of a `code_run` chat run (proposal)

| Tool | Why it stays direct |
| --- | --- |
| `system.code_run` | All reads and all discovery. |
| `system.ask_user` | It changes the chat UI and waits for the user. A script cannot show it. |
| `mcp.call` | All connected writes, and each read whose route is direct. It shows the approval card. |
| `system.spawn_sub_agent`, `system.await_sub_agent` | A sub-agent is a second model run, not a read. |
| `system.load_tool` (optional) | Only for curated writes, until auto-activation is measured (C2). |

Six or seven tools. The count is near today's seven, so this is not mainly a token change. It is a change in what the model must do to find a tool. (Inference.)

### The host-function surface (proposal)

- `tools.search({ query, limit? })`: the same `searchAvailableTools` as today (C3). Each hit returns `{ name, title, summary, route: "script" | "direct", reason?, approval: "none" | "card", hostFunction?, ref? }`. The route uses `decideReadRoute` (`read-route.ts:38`), so the table has one owner. (Inference; the fields exist in `discovery.ts:232-309`.)
- `tools.describe({ name } | { ref })`: the input schema and, for a script read, the output type. For MCP it can wrap `mcp.inspect_tool`. (Inference.)
- `mcp.read(ref, args)`: no change.
- The curated reads: no change.
- `mcp.list_tools` and `mcp.inspect_tool`: keep them, or fold them into `tools.search` and `tools.describe`. One name for each job is better (ADR-0124 "One read path", principle 7). (Inference.)

The boot check requires each index path to be a `codeModeRead` tool or `mcp.read` (`index-text.ts:20-32`). Thus `tools.search` and `tools.describe` must be registered tools with `codeModeRead: true`, `readEvidence`, and named output types in `codegen/code-mode-guest-index.ts`. (Fact for the check; inference for the work.)

### Current time

- The owner requires that the model always knows the current time. Today chat has two sources: the `runtime_context` line at the start of each model turn (`chat-turn.ts:130`, `chat-turn.ts:154`) and the live `system.current_time` tool. (Fact.)
- Inside a script, `Date.now()` is "fixed for the run" (`index-text.ts:62`). Thus a script cannot read the live time from `Date`. A `now()` host function must be a real host call, and its value goes into the evidence record. (Fact for the runtime; inference for the design.)
- If `system.current_time` leaves the surface, the turn-start `runtime_context` line becomes the only time that the model sees without a script. That is safe only if the cache-safe time design (researched by another agent) keeps that line out of the cached prefix and keeps it present on each turn. Do not couple this decision to the discovery move. Keep `system.current_time` on the surface until that design is settled. (Inference.)

## 6. Migration risks

Each item names a place that must change. Facts unless marked.

- **Prompt texts.**
  - `chat-turn.ts:142` tells the model to use `system.search_tools` and to load `mcp.call` with `system.load_tool`.
  - `chat-turn.ts:149` and `chat-turn.ts:155` name `mcp.call`.
  - `chat-turn.ts:199-206` (`CODE_RUN_READ_GUIDANCE`) explains how `search_tools` returns a script hit.
  - `execution/connected-summary.ts:153-154` names `system.search_tools` in the connected list.
  - `index-text.ts:42` and `mcp.ts:411` name `system.search_tools` in a ref hint. `mcp.ts:209` (`mcp.call`) names it too.
  - `dispatch/pipeline.ts:1614-1615` tells the model to call `system.load_tool` or `system.search_tools` after an undeclared tool.
  - `execution/workflows/user-authored-brief.ts:155` and `:168` name them for a background brief. That run has no `code_run`, so this text stays.
- **Two discovery paths.** Sub-agents and background runs never get `system.code_run` (plan, "As built in 2b"). They keep `system.search_tools` and `system.load_tool`. Thus the product has two discovery paths. Principle 7 asks for the fewest parts. C3 (one ranker) limits the cost. (Fact for the run kinds; inference for the cost.)
- **Tests.**
  - `test/tool-runtime/tools/tool-surface.test.ts:86-128` asserts ten kernel tools for a live chat and "the ladder (search_tools + load_tool) is projected in every context". A `code_run` context needs its own case.
  - `test/tool-runtime/tool-surface.test.ts:62-66` asserts the kernel list.
  - `test/tool-runtime/schema-budget.test.ts:25` has a 3,300-token kernel ceiling. The plan already says that this check "measures only the static kernel", not the effective first-turn surface.
  - About 15 more test files name `system.search_tools` or `system.load_tool` (`git grep`; for example `dispatch/active-tools.test.ts`, `surface.test.ts`, `tool-call-round.test.ts`).
- **Evals.** `code-mode-read.eval.ts`, `boss-judgment.eval.ts`, and `voice-ai-tells.eval.ts` name these tools.
- **Web.** `apps/web/src/routes/-chat/tool-call-presentation.ts:23-26` hides `search_tools` and `load_tool` from the trail as plumbing. A script that only discovers shows as one `system.code_run` card, "Read with a script" (`contracts/src/tools.ts:380-384`). Thus the user sees plumbing as work. The trail must read the host calls of a script, or the card must hide a script whose host calls are all discovery. `animated-tool-icons.tsx` and `evidence.ts` also name these tools.
- **Contracts.** `contracts/src/tools.ts:329-342` (`TOOL_LABELS`) and `:537-539` (the category map) are keyed by `ToolName`, so a new tool name fails to compile without a label. That is a guard, not a risk.
- **The generated index.** New host paths need entries in `codegen/code-mode-guest-index.ts`, a new run of `scripts/generate-code-mode-index.mjs`, and a pass of `pnpm check:code-mode-index` (plan, "The index").
- **Stored runs.** `migrateActiveTools` restores the exact names of a checkpoint (`execution/tool-surface.ts:30-42`). A hidden tool stays in `activeTools`, and the surface builder drops it (`surface-adapter.ts:77`). Thus a stored run does not fail. But a run pins its prompt and its read path on the first turn, and "the pin rules the run" (plan, owner decision 4). If the hide rule keys on `readPath: "code_run"`, a pinned run whose prompt says "use system.search_tools" loses that tool. The hide rule needs a new pinned value, for example a new `ToolReadPath` member (`contracts/src/tools.ts:38`) or a surface version in `ChatRunState` (C6).
- **The search fold.** The fold effect (`system.ts:170-180`) and saved `search_tools` results in old threads stay valid data. A replay of an old step returns the saved result. No migration is needed. (Inference.)
- **The surface memo key** serializes each `ToolRunContext` field (`surface-adapter.ts:58-66`). A new field compiles only when the key holds it. That is a guard.

## 7. How to prove "better" before shipping

Run `packages/assistant/evals/code-mode-paired.eval.ts`. It runs the production chat loop with `startChatTurn` and `runOnce`, a fake GitHub MCP server at the protocol client, and the real catalog, broker, policy, and evidence record (plan, "The paired evaluation"). (Fact.)

Changes to the eval:

1. **A third mode, `code_mode_sandbox_discovery`.** It needs a switch in production code (a flag value or a pinned surface version, C6), because the eval sets the mode through settings (`code-mode-paired.eval.ts:298`). Run it against the current `code_mode`, not against `direct`.
2. **Three new case kinds.**
   - A **write**: "comment on issue #N with X". Score the planted text in the `mcp.call` arguments, and count the cards. This is the case that the move can make worse.
   - A **direct-route read**: a read on a tool with no read authority, which reproduces the live run. Count the refused calls.
   - A **name-free read**: a prompt that names no tool and no connection, so discovery must run.
3. **Measures.** Keep the current measures: quality, latency, total tokens, cost, largest call input, steps, cards, and first-step schema tokens (`code-mode-paired.eval.ts:627`). Add:
   - **refused calls**: script refusals (`needs_approval`, `not_a_read`, `undeclared_output`, `binary_output`) and refused direct calls;
   - **discovery-only scripts**: `system.code_run` calls whose host calls are all `tools.search`, `tools.describe`, `mcp.list_tools`, or `mcp.inspect_tool`;
   - **cache-read share**: the sum of `api_call_log.cached_input_tokens` divided by the input tokens of the run. The column exists (`packages/db/src/migrations/0004_premium_big_bertha.sql:9`).
4. **The rule.** Use the owner's rule "quality, then cost" (plan, owner decision 1), plus two limits for this change: refused calls not more, and median steps not more, on every case kind.
5. **The model.** Haiku 5.5 at `medium`, three repeats, because both chat tiers run on it (ADR-0124 amendment 2026-11-19). Haiku spent $0.23 for 30 runs in the second receipt, so the run is cheap. (Fact.)

A cheaper first check: `code-mode-read.eval.ts` runs the model with fake host functions and no database (its header comment). Add `tools.search` to its fixtures and count the discovery-only scripts and the steps against its ceiling of 4. Its receipt on Luna showed six one-read discovery scripts. A repeat on Haiku 5.5 shows if that pattern still occurs. (Fact for the eval; inference for the use.)

## What this research does not settle

- Whether Haiku 5.5 calls a curated tool that is absent from the tool list (the #407 path). This decides if `system.load_tool` can leave the surface.
- The real size of the cache loss for each load step. The eval measure in section 7 gives it.
- Whether the index should shrink to hints and `describe()`. That is a separate decision with a larger token effect (about 2,000 of 3,617 tokens) than the place of search.
