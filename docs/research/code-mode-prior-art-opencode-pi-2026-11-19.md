# Code Mode prior art: opencode, pi, Cloudflare, and Anthropic

Status: Research, 2026-11-19. This is not settled theory. It changes no ADR or runtime rule. It is input for the Code Mode rethink in [code-mode-problems-and-boundaries-2026-11-18.md](./code-mode-problems-and-boundaries-2026-11-18.md).

Sources are primary only: official docs, source code, and the authors' own posts. Source code was read at these commits:

- opencode: [`anomalyco/opencode@56dc95b`](https://github.com/anomalyco/opencode/tree/56dc95bff5f002321a12de5bbbe2783cd0c87e2a) (2026-11-19). `github.com/sst/opencode` redirects to this repo.
- pi: [`earendil-works/pi@5a14e69`](https://github.com/earendil-works/pi/tree/5a14e69c067d40dfbff4f2fff7d3b34c897e2dc9) (2026-11-18). `github.com/badlogic/pi-mono` redirects to this repo.

The tag **[unverified]** marks a claim that no primary source confirms. The tag **[from source]** marks a claim from source code that the docs do not state.

## Summary

Both opencode and pi now ship a Code Mode tool. Both moved MCP tools behind it by default. Both keep a small set of core tools direct. Both give the program the full tool result and bound only what the model sees. Both run every call inside a script through the same permission pipeline as a direct call. Neither asks for approval on ordinary reads by default.

The owner's picture of pi (four tools, no MCP) is correct for 2025. In pi 0.99.0 (2026-09-29), pi added built-in MCP, `codemode`, and `tool_search`. The default declared tools are still `read`, `bash`, `edit`, and `write`.

## 1. opencode

opencode is an open-source coding agent. Its current core (V2) has a Code Mode tool named `execute`.

### (a) Tool count and core tools

The [tools page](https://opencode.ai/docs/tools/) lists 14 built-in tools: `read`, `glob`, `grep`, `edit`, `write`, `patch`, `shell`, `webfetch`, `websearch`, `experimental_image_generate`, `question`, `skill`, `subagent`, and `execute`. Only supported GPT models get `patch`. For those models, `edit` and `write` are hidden ([`tool/model-policy.ts`](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/core/src/tool/model-policy.ts)).

Each tool registration has a `codemode` option. The default is `true`, so a tool goes into the Code Mode catalog unless it opts out ([`tool/AGENTS.md`](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/core/src/tool/AGENTS.md)). The core tools (`read`, `edit`, `write`, `shell`, `glob`, `grep`, `question`, `skill`, `todo`) set `codemode: false` and stay direct. MCP tools and the `opencode.*` management tools (sessions, worktrees, automations, artifacts) go into the catalog. **[from source]**

An experimental flag, `full_codemode`, moves `read`, `write`, `edit`, `patch`, and `shell` into Code Mode too. For Claude and GPT models it then hides `glob`, `grep`, and `webfetch`, because the program gets Bun file APIs and `fetch` ([`model-policy.ts`](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/core/src/tool/model-policy.ts), [`codemode/tool.ts` L94](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/core/src/codemode/tool.ts#L94)). **[from source]**

### (b) Output-size limits

- The session runner applies one generic bound to every direct tool result: 2,000 lines or 50 KiB, whichever comes first ([`tool-output.ts`](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/core/src/tool-output.ts), applied at [`session/runner/step.ts` L152](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/core/src/session/runner/step.ts#L152)). The user can change both numbers with the `tool_output` config.
- When a result is over the bound, opencode writes the full text to a file. The model gets the head and a marker: `[showing lines 1-N of M; full output saved to <path>]`. Files are kept for 7 days. The model can then read the file with `read`, `grep`, or `shell`.
- `shell` keeps the tail, not the head: `[showing lines X-Y of M; full output saved to <file>]` ([`shell.ts`](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/core/src/shell.ts)).
- `read` pages at 2,000 lines and 50 KiB, and cuts a line after 2,000 characters. `glob` and `grep` default to 100 results ([tools page](https://opencode.ai/docs/tools/)).
- Inside `execute`, an inner tool call returns its full value to the program. For MCP tools, that value is `structuredContent`, or the text parsed as JSON when it starts with `{` or `[` ([`tool/mcp.ts`](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/core/src/tool/mcp.ts)). No per-string cut applies. **[from source]**
- Only the `execute` result goes through the generic 2,000-line / 50 KiB bound. The program value is sent as compact JSON, because "indentation adds tokens on every later step" ([`codemode/tool.ts` L479](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/core/src/codemode/tool.ts#L479)).
- Binary MCP content that the model cannot take is saved to a file. The model gets `[Binary resource <label> (<mime>, N bytes) saved to <path>]`.
- The Code Mode library has `timeoutMs`, `maxToolCalls`, and `maxOutputBytes` limits. All three have no default ([codemode README](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/codemode/README.md)). I found no limit passed when the core builds the `execute` runtime. **[from source; not run]**

### (c) Permission model

From the [permissions page](https://opencode.ai/docs/permissions/):

- Each rule has an `action` (for example `read`, `edit`, `shell`, `webfetch`, `<server>_<tool>`, or `execute`), a `resource` pattern, and an `effect` (`allow`, `ask`, or `deny`).
- The resource is the thing that the call touches: a path for `read` and `edit`, each parsed subcommand for `shell`, a URL for `webfetch`, and `*` for an MCP tool.
- Rules match in order. The last matching rule wins. If no rule matches, the effect is `ask`.
- The base policy for every agent is "allow all", except reads of `*.env` and `*.env.*` ask. `.env.example` is allowed.
- `edit`, `write`, and `patch` share one `edit` action. Reads and edits are separate actions.
- An `ask` gives three replies: `once`, `always` (save a project-scoped pattern), or `reject`. A saved approval never overrides a configured `deny`.
- Managed policies can only narrow access. They can turn `allow` or `ask` into `deny`, but never grant.

Inside Code Mode, each inner call runs the same leaf permission check as a direct call. The MCP tool executor calls `permission.assert` with action `<server>_<tool>` ([`tool/mcp.ts` L63](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/core/src/tool/mcp.ts#L63)). An `ask` from an inner call shows on the `execute` call's row while the program waits ([`codemode/tool.ts` L161](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/core/src/codemode/tool.ts#L161), [`permission.ts`](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/core/src/permission.ts)). **[from source]**

A tool that the rules deny completely is removed from the catalog. If `execute` is denied completely, Code Mode tools become direct tools ([`tool.ts` L309–L322](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/core/src/tool.ts#L309)). The tool architecture note says "Tool filtering is catalog visibility, not execution authorization."

### (d) How capabilities are taught

- The `execute` description is fixed text. It states the runtime rules: raw JavaScript, `fetch` only, no imports or timers, exact paths only, `Promise.allSettled` for independent calls ([`codemode/tool.ts` L94](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/core/src/codemode/tool.ts#L94)).
- The catalog itself goes in a separate system instruction. It opens with the placement rule: "The tools listed below … cannot be called directly: they only work as JavaScript inside the `execute` tool. Every other tool you have is a normal tool call: call it directly, never inside `execute`." ([`codemode/instructions.ts` L9](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/core/src/codemode/instructions.ts#L9)).
- Each listed tool gets one line: its generated TypeScript signature and the first line of its description, cut at 500 characters.
- The inline catalog has a budget of about 2,000 tokens. Every namespace always shows, with a count such as `(12 tools, 4 shown)`. Signatures fill the budget one per namespace per round. Tools can be "pinned" so they always show ([`codemode/catalog.ts` L52](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/core/src/codemode/catalog.ts#L52)).
- When the catalog is partial, the model uses a `search(...)` global inside the program. The instruction says "Do not guess tool names."
- When tools change, opencode sends a delta instruction (added, changed, removed) instead of a new catalog, if the delta is shorter.
- MCP server instructions go into the system prompt in an `<mcp_instructions>` block. They are left out when the agent cannot call any tool of that server ([MCP page](https://opencode.ai/docs/mcp-servers/)).

### (e) Code execution approach

opencode wrote its own interpreter for a JavaScript subset, `@opencode/codemode`. It does not sandbox full JavaScript. It "only runs the language features we implement." Programs reach the outside world only through host tools ([codemode README](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/codemode/README.md)).

Notable features:

- `tool.before` hooks can deny a call. The program then catches a thrown error.
- A program can be suspended and resumed from a snapshot. Tools declare if they are plain, `Tool.idempotent` (safe to rerun on resume), or `Tool.durable` (start/wait/cancel). A suspend is refused while a plain tool call runs.
- Results report `truncated` when `maxOutputBytes` cut them. An oversized value becomes a string with an in-band marker.

## 2. pi

pi is a coding agent by Mario Zechner. It now lives at `earendil-works/pi`.

### (a) Tool count and core tools

The default declared tools are `read`, `bash`, `edit`, and `write` ([`docs/cli.md`](https://github.com/earendil-works/pi/blob/5a14e69c067d40dfbff4f2fff7d3b34c897e2dc9/packages/coding-agent/docs/cli.md)). Optional built-ins are `grep`, `find`, `ls`, and `powershell`. Two built-in extensions add `codemode` and `tool_search`. They are off by default. The MCP extension turns them on when a server needs them.

The stated reasons for the small set, from the author's post ["What I learned building an opinionated and minimal coding agent"](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/) (2025-11-30):

- "these four tools are all you need for an effective coding agent."
- Models "have been trained on the read, write, and edit tools with similar input schemas."
- "pi's system prompt and tool definitions together come in below 1000 tokens."
- He ran Terminal-Bench 2.0 as evidence. The placements are in images that I could not read. **[unverified: exact ranking]**

From ["What if you don't need MCP at all?"](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/) (2025-11-02):

- "Playwright MCP has 21 tools using 13.7k tokens (6.8% of Claude's context)."
- His alternative is a CLI tool with a README of about 225 tokens. The agent reads the README only when it needs the tool.
- Scripts compose, and the agent can write output to a file instead of reading it into context.

Then pi 0.99.0 (2026-09-29) "Added codemode, tool search, and MCP support as built-in extensions" ([CHANGELOG](https://github.com/earendil-works/pi/blob/5a14e69c067d40dfbff4f2fff7d3b34c897e2dc9/packages/coding-agent/CHANGELOG.md)). The declared surface stays small. MCP tools default to `codemode` exposure: callable from scripts, not declared, and not listed ([`docs/mcp.md`](https://github.com/earendil-works/pi/blob/5a14e69c067d40dfbff4f2fff7d3b34c897e2dc9/packages/coding-agent/docs/mcp.md)).

### (b) Output-size limits

- `read` and `bash`: 2,000 lines or 50 KB, whichever comes first ([`tools/truncate.ts`](https://github.com/earendil-works/pi/blob/5a14e69c067d40dfbff4f2fff7d3b34c897e2dc9/packages/coding-agent/src/core/tools/truncate.ts)). The limit is in the tool description, so the model knows it before the call.
- `read` keeps the head and tells the model how to continue: `[Showing lines 1-2000 of N. Use offset=2001 to continue.]`.
- `bash` keeps the tail and saves the full output: `[Showing lines X-Y of N. Full output: <path>]`.
- `grep` cuts each match line at 500 characters.
- Direct MCP text results over 20 KB lose their middle around a `…N chars truncated…` marker. The full text goes to a temp file named in the result ([`docs/mcp.md`](https://github.com/earendil-works/pi/blob/5a14e69c067d40dfbff4f2fff7d3b34c897e2dc9/packages/coding-agent/docs/mcp.md), [`mcp/src/output-limit.ts`](https://github.com/earendil-works/pi/blob/5a14e69c067d40dfbff4f2fff7d3b34c897e2dc9/packages/mcp/src/output-limit.ts)).
- Inside `codemode`, scripts get the complete MCP `CallToolResult`, including `structuredContent`. `bash` inside a script returns up to 1 MiB, much more than the 50 KB the model sees ([`docs/codemode.md`](https://github.com/earendil-works/pi/blob/5a14e69c067d40dfbff4f2fff7d3b34c897e2dc9/packages/coding-agent/docs/codemode.md)).
- Script output defaults to 10,000 tokens. A script can change it on its first line: `// @options: {"max_output_tokens": 2000}`. Longer output keeps its start and end, and the full text goes to a temp file named in the result.
- The VM has 256 MB of memory. The docs tell the model to "filter or aggregate large data instead of accumulating it."

### (c) Permission model

pi has no built-in permission system. The README says it "does not include a built-in permission system for restricting filesystem, process, network, or credential access" ([README](https://github.com/earendil-works/pi/blob/5a14e69c067d40dfbff4f2fff7d3b34c897e2dc9/README.md)). The author calls per-call prompts "mostly security theater" and says pi "runs in full YOLO mode" ([post](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)). The security doc points to containers and VMs as the real boundary ([`docs/security.md`](https://github.com/earendil-works/pi/blob/5a14e69c067d40dfbff4f2fff7d3b34c897e2dc9/packages/coding-agent/docs/security.md)).

Approval is an extension concern. A `tool_call` handler can block a call or ask the user. The shipped example `permission-gate.ts` asks only for dangerous `bash` patterns (`rm -rf`, `sudo`, `chmod 777`) ([example](https://github.com/earendil-works/pi/blob/5a14e69c067d40dfbff4f2fff7d3b34c897e2dc9/packages/coding-agent/examples/extensions/permission-gate.ts)).

Calls from a script go through the same pipeline. "Every MCP call passes through Pi's tool pipeline … Calls made from codemode scripts carry the codemode call ID as `parentToolCallId`" ([`docs/mcp.md`](https://github.com/earendil-works/pi/blob/5a14e69c067d40dfbff4f2fff7d3b34c897e2dc9/packages/coding-agent/docs/mcp.md)). pi exposes the MCP annotations `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`, so a permission extension can separate reads from writes. The nested-call record on a result keeps at most 256 calls ([`nested-tool-calls.ts`](https://github.com/earendil-works/pi/blob/5a14e69c067d40dfbff4f2fff7d3b34c897e2dc9/packages/coding-agent/src/core/nested-tool-calls.ts)).

For sensitive data, pi uses access control, not approval: run in a container and give "narrowly scoped, short-lived credentials."

### (d) How capabilities are taught

- The default system prompt lists each declared tool with a one-line snippet and adds "Additional tools may be available." ([`system-prompt.ts`](https://github.com/earendil-works/pi/blob/5a14e69c067d40dfbff4f2fff7d3b34c897e2dc9/packages/coding-agent/src/core/system-prompt.ts)).
- The `codemode` guideline in the system prompt: "Use codemode to batch independent tool calls (Promise.allSettled), chain them, or filter large output, instead of many separate calls." ([`extensions/codemode/tool.ts` L113](https://github.com/earendil-works/pi/blob/5a14e69c067d40dfbff4f2fff7d3b34c897e2dc9/packages/coding-agent/src/extensions/codemode/tool.ts#L113)).
- Each declared tool's description ends with a line that says how a script calls it and what the call returns, for example "Codemode: `tools.bash(args)` resolves to `{ output, truncated, full_output_path?, exit_code, … }`" ([`tool.ts` L354](https://github.com/earendil-works/pi/blob/5a14e69c067d40dfbff4f2fff7d3b34c897e2dc9/packages/coding-agent/src/extensions/codemode/tool.ts#L354)).
- The `codemode` description lists non-deferred tools with TypeScript declarations, grouped by namespace, in a 3,000-token budget (`codemode.inlineBudget`). It marks a namespace "(some tools not listed)" when the budget cuts it.
- Scripts find other tools with `searchTools()` (BM25), `describeTool()`, `describeNamespace()`, and `ALL_TOOLS`.
- MCP servers appear in an `mcp_servers` system-prompt section with one line each. When the section changes, pi appends the new section to the conversation, so the cached prefix stays the same.
- `codemode.mode: "only"` hides the other tools from the model and lists them only in the `codemode` description.
- Per-tool exposure: `direct`, `codemode` (default for MCP), `deferred` (loaded by `tool_search`), or `hidden`. `toolExposure` sets it per tool with patterns, for example `"get_*": "codemode"` and `"delete_*": "hidden"`.

### (e) Code execution approach

pi runs model-written JavaScript in QuickJS compiled to WebAssembly, one worker thread for each run ([`packages/codemode/README.md`](https://github.com/earendil-works/pi/blob/5a14e69c067d40dfbff4f2fff7d3b34c897e2dc9/packages/codemode/README.md)). The script has no timers, `fetch`, `process`, modules, or file system. The globals are `tools.*`, `text()`, `image()`, `exit()`, and `store()`/`load()`. The store keeps small JSON values (256 Ki characters per value, 1 Mi total) across scripts in one session. A failed script keeps its partial output, and calls made before the failure are not undone.

## 3. Comparison targets

### Cloudflare Code Mode

- [Code Mode: the better way to use MCP](https://blog.cloudflare.com/code-mode/) (2025-09-26, Kenton Varda and Sunil Pai). The model gets "just one tool" that runs TypeScript. MCP tools become a TypeScript API with doc comments, and that API goes into context. The sandbox has no Internet. Bindings carry calls to the supervisor, which adds tokens, so "the AI cannot possibly write code that leaks any keys." Output reaches the model through console logs.
- [Code Mode: give agents an entire API in 1,000 tokens](https://blog.cloudflare.com/code-mode-mcp/) (2026-02-20, Matt Carey). Two tools, `search` and `execute`, cover the Cloudflare API. `search` runs code against the OpenAPI spec, so "the full OpenAPI spec never enters the model context." The post gives about 1,000 tokens against 1.17 million without Code Mode. The page metadata says "over 2 million". **[numbers differ inside the source]** Scope comes from OAuth downscoping at connect time. The post shows no approval step for writes.
- [Code Mode docs](https://developers.cloudflare.com/agents/model-context-protocol/codemode/): `codeMcpServer()` exposes one `code` tool whose description holds generated TypeScript for every upstream tool. It "does not provide durable approval for each upstream tool call." Upstream handlers must enforce authorization and approval. Final MCP responses are cut at about 6,000 estimated tokens with a `--- TRUNCATED ---` marker.

### Anthropic: Code execution with MCP

[Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) (2025-11-04, Adam Jones and Conor Kelly):

- Two costs: tool definitions in context, and intermediate results that pass through the model.
- Tools appear as files under `./servers/`, so the agent loads only the definitions it needs. An alternative is a `search_tools` tool with a detail-level parameter.
- The example goes "from 150,000 tokens to 2,000 tokens" (98.7%).
- Filtering in code: "The agent sees five rows instead of 10,000."
- The harness can tokenize personal data (emails, phone numbers) before the model sees it.
- Caveat: code execution "requires a secure execution environment."

### Anthropic: programmatic tool calling and tool search

[Programmatic tool calling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling):

- A tool opts in with `allowed_callers: ["code_execution_20260120"]`. The docs advise one placement per tool: "Choose either `["direct"]` or `["code_execution_20260120"]` for each tool rather than enabling both."
- `allowed_callers` "is not a hard API-level block on direct calls … Do not rely on `allowed_callers` as a security boundary."
- "Tool results from programmatic calls are not added to Claude's context: Only the final code output is."
- Best practice: "Provide detailed output descriptions" and "Return structured data."
- Weak fit: "Tools that require immediate user feedback between calls" and strictly sequential workflows. On τ²-bench, it "left scores unchanged and cost roughly 8 percent more."
- Measured gains: a 75-tool benchmark used about 38% fewer billed input tokens with no accuracy change.
- Tools from the MCP connector cannot be called programmatically.

[Tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool):

- "Claude's ability to pick the right tool degrades once you exceed 30–50 available tools."
- Deferred tools (`defer_loading: true`) enter context only when a search finds them. A search returns 5 tools by default.
- "Keep your 3–5 most frequently used tools non-deferred."
- "Add a system prompt section describing available tool categories."
- Use it at 10 or more tools or more than 10k tokens of definitions.

## 4. Comparison table

| Item | opencode | pi | Cloudflare Code Mode | Anthropic PTC + tool search |
| --- | --- | --- | --- | --- |
| Declared tools | 14 built-ins in docs; MCP and management tools go behind `execute` | 4 by default (`read`, `bash`, `edit`, `write`); `codemode` and `tool_search` on when MCP needs them | 1 (`code`) or 2 (`search`, `execute`) | Keep 3–5 direct; defer the rest |
| Code runtime | Own JS-subset interpreter | QuickJS in WASM, worker per run | V8 isolate, no Internet | Anthropic container (Python) |
| Model-facing bound | 2,000 lines / 50 KiB, head kept, full text to file | 2,000 lines / 50 KB; MCP 20 KB middle cut; script 10k tokens, start and end kept | About 6,000 tokens, `--- TRUNCATED ---` | Only final code output enters context |
| Bound inside the program | None per string; full structured MCP result | Full `CallToolResult`; `bash` up to 1 MiB | Not stated | Tool result is a string to the code |
| What the model gets when over | Marker with line range and saved file path | Marker with path, or `offset=` to continue | Marker only | Not applicable |
| Read approval default | Allow; ask only for `.env` files | None built in | None in the SDK; upstream enforces | Not addressed |
| Write approval | Rule per action and resource; `ask` inside a script waits on the `execute` row | Extension `tool_call` hook; MCP hints available | Upstream handler must enforce | Weak fit for calls that need user feedback |
| Teaching placement | Catalog says "only inside `execute`"; every other tool is direct | Each direct tool says how a script calls it and what it returns | Typed API in description | `allowed_callers` per tool; one placement each |
| Discovery past budget | 2,000-token inline catalog, `search()` | 3,000-token inline budget, `searchTools()`, `describeTool()` | `search` over the spec | Server-side regex or BM25 search |

## 5. Lessons for Alfred

These lessons map the sources to the problems that the brief names. They are inputs for the owner's theory work. They are not decisions.

### L1. Tell the model each tool's placement in one rule, and on the tool

Problem: the model does not know which reads can run in a script.

- opencode puts one rule at the top of the catalog: listed tools "only work as JavaScript inside the `execute` tool. Every other tool you have is a normal tool call" ([instructions.ts](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/core/src/codemode/instructions.ts#L9)).
- pi adds a line to each direct tool's description that gives its script call and its return shape ([tool.ts L354](https://github.com/earendil-works/pi/blob/5a14e69c067d40dfbff4f2fff7d3b34c897e2dc9/packages/coding-agent/src/extensions/codemode/tool.ts#L354)).
- Anthropic advises one placement per tool, not both ([PTC docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling)).

Possible move: derive the `system.code_run` catalog and the placement sentence from the same registry flag. Do not write a prompt rule by hand.

### L2. Bound the model-facing total, not each string

Problem: direct MCP reads cut each string at 8,000 characters, so list results lose most items.

- No source cuts individual strings inside a structured result. opencode and pi bound the joined text of the whole result (2,000 lines / 50 KB) ([opencode tool-output.ts](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/core/src/tool-output.ts), [pi truncate.ts](https://github.com/earendil-works/pi/blob/5a14e69c067d40dfbff4f2fff7d3b34c897e2dc9/packages/coding-agent/src/core/tools/truncate.ts)).
- pi cuts the middle of a direct MCP result at 20 KB, so the first and last items survive ([docs/mcp.md](https://github.com/earendil-works/pi/blob/5a14e69c067d40dfbff4f2fff7d3b34c897e2dc9/packages/coding-agent/docs/mcp.md)).

Possible move: drop the per-string cut. Apply one total budget, and keep whole list items where possible.

### L3. Save what you cut, and tell the model how to get it

- opencode writes the full output to a file and says `[showing lines 1-N of M; full output saved to <path>]` ([tool-output.ts](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/core/src/tool-output.ts)).
- pi `read` says `Use offset=N to continue` ([read.ts](https://github.com/earendil-works/pi/blob/5a14e69c067d40dfbff4f2fff7d3b34c897e2dc9/packages/coding-agent/src/core/tools/read.ts)).
- Both state the limit in the tool description before the call.

Alfred has no file system for the model. The equivalent is a stored result handle that a later script can read or page. The marker must give the count shown, the total, and the handle.

### L4. Give the program the full result; bound only the program's output

Problem: scripts trim content too hard.

- opencode passes the full structured MCP result into the program, and bounds only the `execute` result ([tool/mcp.ts](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/core/src/tool/mcp.ts), [step.ts L152](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/core/src/session/runner/step.ts#L152)).
- pi gives scripts the full `CallToolResult` and `bash` output up to 1 MiB. The script output budget is 10,000 tokens by default, and the script can set its own `max_output_tokens` ([docs/codemode.md](https://github.com/earendil-works/pi/blob/5a14e69c067d40dfbff4f2fff7d3b34c897e2dc9/packages/coding-agent/docs/codemode.md)).
- Anthropic: "Provide detailed output descriptions" and "Return structured data" ([PTC docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling)).

Possible move: show the return shape of each host function. Pass `structuredContent` through. Let the script ask for a larger output budget up to a ceiling. A model trims less when it knows the shape and the budget. **[inference, not measured]**

### L5. Run every in-script call through the direct-call permission check

- opencode: the MCP executor calls `permission.assert` for each call, inside or outside `execute`. An `ask` shows on the `execute` row ([tool/mcp.ts L63](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/core/src/tool/mcp.ts#L63), [codemode/tool.ts L161](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/core/src/codemode/tool.ts#L161)).
- pi: script calls go through the same `tool_call` hooks with `parentToolCallId` ([docs/mcp.md](https://github.com/earendil-works/pi/blob/5a14e69c067d40dfbff4f2fff7d3b34c897e2dc9/packages/coding-agent/docs/mcp.md)).
- Cloudflare's SDK has no per-call approval. Upstream handlers must enforce it ([docs](https://developers.cloudflare.com/agents/model-context-protocol/codemode/)).

Alfred already uses shared dispatch checks. The sources confirm this choice.

### L6. Do not ask for approval on ordinary reads

Problem: approval mode "gated" makes every read wait for a card.

- opencode allows all actions by default and asks only for `.env` reads ([permissions page](https://opencode.ai/docs/permissions/)).
- pi asks for nothing by default and relies on isolation ([security.md](https://github.com/earendil-works/pi/blob/5a14e69c067d40dfbff4f2fff7d3b34c897e2dc9/packages/coding-agent/docs/security.md)).
- Anthropic names calls that need user feedback between calls as a weak fit for code ([PTC docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling)).

No source asks for approval on each read. opencode's model is a rule keyed by action and resource, with the last match winning. With that model, a sensitive read can ask while all other reads are allowed. Possible move: key approval by action class and resource, not by one global mode.

### L7. Hide what the policy forbids, but still check at execution

opencode removes completely denied tools from the catalog. It still runs the leaf check on each call, because "Tool filtering is catalog visibility, not execution authorization" ([tool/AGENTS.md](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/core/src/tool/AGENTS.md), [tool.ts L322](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/core/src/tool.ts#L322)). Anthropic says the same about `allowed_callers`: it is not a security boundary.

### L8. Shrink the declared surface; list the rest by namespace with a budget

Problem: many `system.*` tools are on the surface.

- Anthropic: selection accuracy "degrades once you exceed 30–50 available tools", and keep "3–5 most frequently used tools non-deferred" ([tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)).
- pi declares 4 tools by default, and its prompt plus tool definitions were under 1,000 tokens ([post](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)).
- opencode shows every namespace with a tool count, and fills a 2,000-token budget with signatures. `search()` finds the rest ([catalog.ts](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/core/src/codemode/catalog.ts)). pi uses a 3,000-token budget.

Possible move: move read-only `system.*` tools into the script catalog under one namespace. Keep direct only the writes, `ask_user`, and the few most used tools.

### L9. Keep the cached prefix stable when tools change

pi does not list deferred tools in the `codemode` description, "so the description stays the same while MCP servers connect." It appends a changed section to the conversation instead ([docs/mcp.md](https://github.com/earendil-works/pi/blob/5a14e69c067d40dfbff4f2fff7d3b34c897e2dc9/packages/coding-agent/docs/mcp.md)). opencode sends a catalog delta when it is shorter than the full catalog ([instructions.ts](https://github.com/anomalyco/opencode/blob/56dc95bff5f002321a12de5bbbe2783cd0c87e2a/packages/core/src/codemode/instructions.ts)). This matters for Alfred if MCP catalogs change during a chat.

### L10. Few tools and code mode are compatible

pi's author argued against MCP in 2025 ([post](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/)). pi later added MCP behind `codemode`, with MCP tools not declared by default ([CHANGELOG 0.99.0](https://github.com/earendil-works/pi/blob/5a14e69c067d40dfbff4f2fff7d3b34c897e2dc9/packages/coding-agent/CHANGELOG.md)). His objection was context cost and composability. Code Mode answers both. The lesson is "few declared tools plus one composition tool", not "no integrations".

## Open points that this research does not settle

- No source measures per-read approval cost in a chat assistant. L6 is an argument from defaults, not from data.
- opencode lets an `ask` pause a running program. Alfred keeps writes direct instead. The sources show both designs. Neither source compares them.
- I did not run either agent. Claims tagged **[from source]** come from reading code at the commits above.
