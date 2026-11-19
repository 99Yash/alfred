# Code Mode prior art: Cloudflare

Status: research, 2026-11-19. This file changes no ADR and no runtime rule. It records what Cloudflare does for four Code Mode problems that Alfred has. It ends with a map to Alfred.

Labels:

- **Fact** — a Cloudflare source states it. The URL follows the claim.
- **Inference** — my conclusion from the facts. No source states it.

Source code was read at these commits: `cloudflare/mcp` at `19f7601ed` (2026-11-18) and `cloudflare/agents` at `1a450e713` (2026-11-18, the last commit that touches `packages/codemode`).

## The sources

| Source | Date | What it is |
| --- | --- | --- |
| [Connect 2026 talk page](https://www.cloudflare.com/connect/2026/session/giving-an-agent-10-000-tools-with-code-mode/) | 2026 | "Giving an agent 10,000 tools with Code Mode". The page has a full transcript. |
| [Code Mode: the better way to use MCP](https://blog.cloudflare.com/code-mode/) | 2025-09-26 | The first Code Mode post (Kenton Varda, Sunil Pai). |
| [Code Mode: give agents an entire API in 1,000 tokens](https://blog.cloudflare.com/code-mode-mcp/) | 2026-02-20 | The Cloudflare API MCP server (Matt Carey). |
| [Sandboxing AI agents, 100x faster](https://blog.cloudflare.com/dynamic-workers/) | 2026-03-24 | Dynamic Workers, the sandbox (Kenton Varda, Sunil Pai). |
| [Scaling MCP adoption](https://blog.cloudflare.com/enterprise-mcp/) | 2026-04-14 | MCP server portals with Code Mode (Sharon Goldberg, Matt Carey). |
| [`cloudflare/mcp`](https://github.com/cloudflare/mcp/tree/19f7601ed3a7a9ad41d2637f2f9509e732600cf7) | 2026-11-18 | Source of the Cloudflare API MCP server at `mcp.cloudflare.com`. |
| [`@cloudflare/codemode`](https://github.com/cloudflare/agents/tree/1a450e71325c25ca1ec8b0013d756fe0c733b6f3/packages/codemode) | 2026-11-18 | The Code Mode SDK in the Agents repo. |
| [Code Mode docs](https://developers.cloudflare.com/agents/tools/codemode/how-it-works/) | 2026-10-12 | Agents SDK developer docs. |

**Caution about the talk.** The speaker is Rhys Sullivan, the founder of Executor. He is not a Cloudflare employee. The talk describes Executor, a third-party "personal cloud" that runs on Cloudflare ([talk](https://www.cloudflare.com/connect/2026/session/giving-an-agent-10-000-tools-with-code-mode/)). Thus the talk gives the speaker's claims, not Cloudflare product facts. The talk shows no slides as text and gives few mechanism details. For mechanisms, this file uses the Cloudflare blog posts, docs, and source code.

**A link between the talk and Cloudflare code.** The Cloudflare Code Mode SDK names its search "Executor-style ranked search over connector methods and saved snippets" ([search.ts](https://github.com/cloudflare/agents/blob/1a450e71325c25ca1ec8b0013d756fe0c733b6f3/packages/codemode/src/connectors/search.ts#L2)). (Fact.)

## Three Cloudflare shapes

Cloudflare uses three different shapes. Each problem below refers to them.

1. **One tool with the full API (2025).** The model gets "just one tool, which simply executes some TypeScript code". The SDK converts each MCP server schema into a TypeScript API with doc comments and loads it into context. "Currently, the entire API is loaded." ([blog](https://blog.cloudflare.com/code-mode/)) (Fact.)
2. **Two tools: `search` and `execute` (2026).** The Cloudflare API MCP server and the MCP server portals use this shape. The model writes code against the spec in `search`, and writes code that calls the API in `execute` ([blog](https://blog.cloudflare.com/code-mode-mcp/), [portals](https://blog.cloudflare.com/enterprise-mcp/)). (Fact.)
3. **One tool with search inside the sandbox (2026, durable runtime).** The model gets one outer tool, `codemode`. Inside the sandbox, `codemode.search()` and `codemode.describe()` find and document connector methods ([docs](https://developers.cloudflare.com/agents/tools/codemode/how-it-works/)). (Fact.)

## Problem 1: approval of reads

### Cloudflare facts

- **The durable runtime runs a method with no annotation at once.** The type comment says: "Requires user approval before executing. Unannotated methods execute immediately." ([types.ts](https://github.com/cloudflare/agents/blob/1a450e71325c25ca1ec8b0013d756fe0c733b6f3/packages/codemode/src/connectors/types.ts#L8))
- **Approval is a flag on one method, not on a connector.** "`requiresApproval: true` is the entire surface. Mark only what needs a human — everything else executes immediately and is still recorded in the durable log for replay and audit." ([approvals.md](https://github.com/cloudflare/agents/blob/1a450e71325c25ca1ec8b0013d756fe0c733b6f3/docs/codemode/approvals.md))
- **The developer marks MCP methods by name.** The `McpConnector` has a `tool(name, t)` hook. The example marks `create_issue` and `merge_pull_request` only. All other GitHub MCP tools run without approval ([approvals.md](https://github.com/cloudflare/agents/blob/1a450e71325c25ca1ec8b0013d756fe0c733b6f3/docs/codemode/approvals.md), [MCP docs](https://developers.cloudflare.com/agents/tools/codemode/mcp/)).
- **A gated call pauses the script. It does not refuse the script.** The run aborts, the call is logged as pending, and the user approves. Then the runtime replays the log and continues. "The model writes code as if the call returns normally." ([approvals.md](https://github.com/cloudflare/agents/blob/1a450e71325c25ca1ec8b0013d756fe0c733b6f3/docs/codemode/approvals.md))
- **The comparison table in the same doc names reads as "unannotated (default)"** and writes as `{ requiresApproval: true }` ([approvals.md](https://github.com/cloudflare/agents/blob/1a450e71325c25ca1ec8b0013d756fe0c733b6f3/docs/codemode/approvals.md)).
- **Rollback skips reads.** "Tools without a `revert` are skipped, as are reads." ([approvals.md](https://github.com/cloudflare/agents/blob/1a450e71325c25ca1ec8b0013d756fe0c733b6f3/docs/codemode/approvals.md))
- **The older `createCodeTool` API removes gated tools from the sandbox.** "Legacy `createCodeTool` still excludes tools with `needsApproval: true` instead of pausing execution." ([README](https://github.com/cloudflare/agents/blob/1a450e71325c25ca1ec8b0013d756fe0c733b6f3/packages/codemode/README.md))
- **The Cloudflare API MCP server has no approval for each call.** The user selects permissions one time, at OAuth connect. The server downscopes the token to them. "The agent only gets the capabilities the user explicitly granted." ([blog](https://blog.cloudflare.com/code-mode-mcp/))
- **The server refuses some writes by policy. It never refuses a read.** `policyRefusalHint` returns early for `GET` and `HEAD`. It refuses only writes that spend money and some AI model runs. The comment says "Reads never are." ([policy-guards.ts](https://github.com/cloudflare/mcp/blob/19f7601ed3a7a9ad41d2637f2f9509e732600cf7/src/policy-guards.ts#L45-L67))
- **The server marks the whole `execute` tool as destructive** in its MCP annotations: `readOnlyHint: false`, `destructiveHint: true` ([execute.ts](https://github.com/cloudflare/mcp/blob/19f7601ed3a7a9ad41d2637f2f9509e732600cf7/src/tools/execute.ts#L672-L680)).
- **MCP portals control which tools a group sees.** The example gives the finance group "just the read-only tools" of a code repository server. The post does not describe approval for each call ([portals](https://blog.cloudflare.com/enterprise-mcp/)).
- **The talk shows approval rules as code.** The speaker's example: "if the argument to that function is under $20, let it run." He also says Code Mode lets you move "your permission handling outside of the harness" into a gateway ([talk](https://www.cloudflare.com/connect/2026/session/giving-an-agent-10-000-tools-with-code-mode/)). (Speaker claim about Executor.)

### Inferences

- In all three shapes, the default for a read is "run". Approval is the exception, and it applies to a named write method.
- The permission boundary is the credential scope plus the method flag. It is not the integration or the connector.
- Because `execute` carries `destructiveHint: true`, an MCP client can still ask the user before each `execute` call. That is a client decision, outside the server.

## Problem 2: capability teaching

### Cloudflare facts

- **The tool description names every global and forbids guesses.** The default description of the durable `codemode` tool says: "The ONLY globals are ... and `codemode`". It also says: "Never guess method names. If you have not used a connector in this conversation, run a discovery pass first". It lists each connector by name ([proxy-tool.ts](https://github.com/cloudflare/agents/blob/1a450e71325c25ca1ec8b0013d756fe0c733b6f3/packages/codemode/src/proxy-tool.ts#L553-L601)).
- **The description tells the model about approval before it calls.** "Some methods require approval. The run pauses until the user approves, then resumes automatically. Write code as if the call returns normally." ([proxy-tool.ts](https://github.com/cloudflare/agents/blob/1a450e71325c25ca1ec8b0013d756fe0c733b6f3/packages/codemode/src/proxy-tool.ts#L553-L601))
- **Search and describe show the approval flag.** "Search and describe results include `requiresApproval: true` for protected connector methods." ([README](https://github.com/cloudflare/agents/blob/1a450e71325c25ca1ec8b0013d756fe0c733b6f3/packages/codemode/README.md)). `SearchResult` and `DescribeOutput` both carry `requiresApproval` ([types.ts](https://github.com/cloudflare/agents/blob/1a450e71325c25ca1ec8b0013d756fe0c733b6f3/packages/codemode/src/connectors/types.ts)).
- **Search returns paths, not schemas.** "`codemode.search()` ... returns ranked paths, not complete schemas." `describe()` gives the TypeScript types of one path ([docs](https://developers.cloudflare.com/agents/tools/codemode/how-it-works/)). Search returns at most 50 results and a `truncated` flag ([search.ts](https://github.com/cloudflare/agents/blob/1a450e71325c25ca1ec8b0013d756fe0c733b6f3/packages/codemode/src/connectors/search.ts#L11)).
- **Connector hints remove a discovery pass.** `connectorHints` puts one line next to each connector in the description. The purpose is to tell "the model what a namespace is for ... without it having to run a `codemode.search` discovery pass first" ([proxy-tool.ts](https://github.com/cloudflare/agents/blob/1a450e71325c25ca1ec8b0013d756fe0c733b6f3/packages/codemode/src/proxy-tool.ts#L148-L156)).
- **Each MCP tool becomes a typed method.** "`McpConnector` creates one typed sandbox method for each discovered MCP tool." ([MCP docs](https://developers.cloudflare.com/agents/tools/codemode/mcp/))
- **The Cloudflare API server lets search read the full spec in code.** The `search` tool gives the code a `spec` object with all `$refs` resolved. "The full OpenAPI spec never enters the model context." ([blog](https://blog.cloudflare.com/code-mode-mcp/))
- **A refusal names the missing permission.** The `execute` description says: "For HTTP 401/403 it also says which permission the endpoint needs and whether reconnecting will help." ([execute.ts](https://github.com/cloudflare/mcp/blob/19f7601ed3a7a9ad41d2637f2f9509e732600cf7/src/tools/execute.ts#L613-L630)). The server then asks the client to re-authorize with that scope added ([README](https://github.com/cloudflare/mcp/blob/19f7601ed3a7a9ad41d2637f2f9509e732600cf7/README.md#missing-permissions)).
- **The server does not retry a script that wrote.** A step-up retry is offered only when each request in the script was a read or was refused (`replaySafe`). Otherwise the error says to "run only the steps that did not complete" ([execute.ts](https://github.com/cloudflare/mcp/blob/19f7601ed3a7a9ad41d2637f2f9509e732600cf7/src/tools/execute.ts#L539)).
- **The talk:** TypeScript gives "an index catalog of tools that you can search over", and "You also know what's returned" ([talk](https://www.cloudflare.com/connect/2026/session/giving-an-agent-10-000-tools-with-code-mode/)). (Speaker claim.)

### Inferences

- Cloudflare has no class of tool that a script can find but cannot call. The set that search shows is the set that the sandbox binds. A gated method is in that set; it pauses, and it does not refuse. In the legacy API, a gated tool is absent from both the types and the sandbox.
- Thus a model in Cloudflare's design does not learn the boundary from a failed call. It learns it from the description, from search, and from describe, before the first call.

## Problem 3: response size

### Cloudflare facts

- **The cap applies to the result that goes to the model.** The Cloudflare API server caps each `search` and `execute` result at about 6,000 tokens ([README](https://github.com/cloudflare/mcp/blob/19f7601ed3a7a9ad41d2637f2f9509e732600cf7/README.md#tool-result-truncation)). The code uses 4 characters for each token, so the cap is 24,000 characters ([truncate.ts](https://github.com/cloudflare/mcp/blob/19f7601ed3a7a9ad41d2637f2f9509e732600cf7/src/truncate.ts#L19-L22)).
- **The cut keeps the JSON valid and keeps whole records.** "Oversized JSON stays valid JSON: long lists keep their first items whole, long strings are clipped, and every cut is marked with `--- TRUNCATED ---`." ([README](https://github.com/cloudflare/mcp/blob/19f7601ed3a7a9ad41d2637f2f9509e732600cf7/README.md#tool-result-truncation)). The largest values shrink first. A clipped array ends with a "`<n> more items`" marker. An object that lost keys names them ([truncate.ts](https://github.com/cloudflare/mcp/blob/19f7601ed3a7a9ad41d2637f2f9509e732600cf7/src/truncate.ts#L1-L17)).
- **The server keeps every key of a list item.** Its version differs from the SDK in one way: "an array keeps each item at a floor that preserves every object key (`keyFloor`), so a list of records keeps whole records instead of cutting every record down to a few fields." ([truncate.ts](https://github.com/cloudflare/mcp/blob/19f7601ed3a7a9ad41d2637f2f9509e732600cf7/src/truncate.ts#L12-L17))
- **Plain text gets a notice with the size.** The notice says: "Use more specific queries to reduce response size." ([truncate.ts](https://github.com/cloudflare/mcp/blob/19f7601ed3a7a9ad41d2637f2f9509e732600cf7/src/truncate.ts))
- **The caller can turn the cap off for one call.** `truncate: false` gives the whole result. Use it "only when the result doesn't go to the model" ([README](https://github.com/cloudflare/mcp/blob/19f7601ed3a7a9ad41d2637f2f9509e732600cf7/README.md#tool-result-truncation)).
- **Direct tools return whole results.** With `?codemode=false`, the server registers about 3,000 direct tools, and "the direct tools return whole results". The reason: the clients that use direct tools "call the direct tools from their own code and parse each result, so a capped result would lose data." ([README](https://github.com/cloudflare/mcp/blob/19f7601ed3a7a9ad41d2637f2f9509e732600cf7/README.md#tool-result-truncation))
- **Inside the script, the code sees the full API response.** The cap runs on `execution.result`, after the script returns ([execute.ts](https://github.com/cloudflare/mcp/blob/19f7601ed3a7a9ad41d2637f2f9509e732600cf7/src/tools/execute.ts#L690-L700)). The model's code can "handle pagination, check responses" and chain calls ([blog](https://blog.cloudflare.com/code-mode-mcp/)).
- **The SDK uses the same budget.** `truncateResult` defaults to 6,000 tokens ([SDK truncate.ts](https://github.com/cloudflare/agents/blob/1a450e71325c25ca1ec8b0013d756fe0c733b6f3/packages/codemode/src/truncate.ts#L18-L21)). `codeMcpServer` and `openApiMcpServer` use a 24,000-character budget for each response ([mcp.ts](https://github.com/cloudflare/agents/blob/1a450e71325c25ca1ec8b0013d756fe0c733b6f3/packages/codemode/src/mcp.ts#L24-L39)).
- **The durable runtime does not cap by default.** `transformResult` is optional. It can "reshape the model-facing result of a completed run" with `truncateResult`. "The raw result is still recorded on the execution." ([runtime-handle.ts](https://github.com/cloudflare/agents/blob/1a450e71325c25ca1ec8b0013d756fe0c733b6f3/packages/codemode/src/runtime-handle.ts#L45-L53))
- **The durable log never truncates.** Truncation "would corrupt replay", so an oversized value fails the run with a "model-actionable error" ([runtime.ts](https://github.com/cloudflare/agents/blob/1a450e71325c25ca1ec8b0013d756fe0c733b6f3/packages/codemode/src/runtime.ts#L40-L50)). Each stored value has a limit of 1,000,000 characters ([docs](https://developers.cloudflare.com/agents/tools/codemode/how-it-works/)). A read can use `replay: "reexecute"` to keep large results out of the log ([types.ts](https://github.com/cloudflare/agents/blob/1a450e71325c25ca1ec8b0013d756fe0c733b6f3/packages/codemode/src/connectors/types.ts#L10-L17)).
- **The first post returns output through logs.** The script calls `console.log()`, and "all the output logs are passed back to the agent" ([blog](https://blog.cloudflare.com/code-mode/)). "only the output, and not every intermediate step, ends up in the context window" ([Dynamic Workers](https://blog.cloudflare.com/dynamic-workers/)).
- **The talk:** an execution environment lets the agent "filter the results to preserve their context window" ([talk](https://www.cloudflare.com/connect/2026/session/giving-an-agent-10-000-tools-with-code-mode/)). (Speaker claim.)

### Inferences

- Cloudflare never cuts data between a tool and the script. It cuts only at the model.
- A 9 KB JSON list is below the 24,000-character cap. Cloudflare would return it whole.
- Cloudflare clips whole items from the end of a list. It does not clip each string to a fixed length. Thus a cut list has fewer issues, and each issue is complete. The marker gives the count of dropped items.

## Problem 4: tool surface

### Cloudflare facts

- **The Cloudflare API server has four tools.** `search`, `execute`, `docs`, and `whoami`. The token table counts 3 tools at about 1,100 tokens, against 2,594 tools at 1,170,523 tokens with full schemas ([README](https://github.com/cloudflare/mcp/blob/19f7601ed3a7a9ad41d2637f2f9509e732600cf7/README.md)).
- **The size stays fixed.** "The footprint stays fixed, no matter how many API endpoints exist." Code Mode cuts input tokens by 99.9% ([blog](https://blog.cloudflare.com/code-mode-mcp/)).
- **MCP portals collapse all servers into two tools.** "those 52 tools collapse into 2 portal tools consuming roughly 600 tokens", against about 9,400 tokens before ([portals](https://blog.cloudflare.com/enterprise-mcp/)).
- **The durable runtime gives the model one tool.** "In the standard setup, the model receives one outer tool named `codemode`." The description "does not include every connector method and schema" ([docs](https://developers.cloudflare.com/agents/tools/codemode/how-it-works/)). Discovery (`search`, `describe`), saved scripts (`run`), and durable steps (`step`) are functions inside the sandbox, not model tools ([proxy-tool.ts](https://github.com/cloudflare/agents/blob/1a450e71325c25ca1ec8b0013d756fe0c733b6f3/packages/codemode/src/proxy-tool.ts#L553-L601)).
- **Saved scripts replace authored tools.** "Snippets are durable, addressable saved scripts." The developer promotes a run with `saveSnippet`, and the model calls it with `codemode.run`. Snippets appear in search results ([README](https://github.com/cloudflare/agents/blob/1a450e71325c25ca1ec8b0013d756fe0c733b6f3/packages/codemode/README.md)).
- **Many providers share one sandbox.** Each provider is a namespace (`codemode.*`, `workspace.*`, `db.*`) in the same code block ([README](https://github.com/cloudflare/agents/blob/1a450e71325c25ca1ec8b0013d756fe0c733b6f3/packages/codemode/README.md)).
- **The talk:** at 100 tools, "about half your context window is dedicated to tool names, input output schemas"; at 1,000 tools "it doesn't even work". A bash tool does not reduce tools; "you're just shifting the execution environment" ([talk](https://www.cloudflare.com/connect/2026/session/giving-an-agent-10-000-tools-with-code-mode/)). (Speaker claims, not measured in the talk.)

### Inferences

- Cloudflare moves discovery into the sandbox, not into top-level tools. The model sees one or two tools. All other capability is a namespace that search can find.
- Cloudflare keeps a direct tool at the top level only when it has a different job, for example `docs` and `whoami`.

## The sandbox and the binding model

Facts:

- The code runs in a Dynamic Worker, a V8 isolate. "An isolate takes a few milliseconds to start and uses a few megabytes of memory." ([Dynamic Workers](https://blog.cloudflare.com/dynamic-workers/))
- The sandbox has "no file system, no environment variables", and external fetches are off by default ([blog](https://blog.cloudflare.com/code-mode-mcp/)). The SDK sets `globalOutbound: null` by default, so `fetch()` and `connect()` throw ([README](https://github.com/cloudflare/agents/blob/1a450e71325c25ca1ec8b0013d756fe0c733b6f3/packages/codemode/README.md)).
- The sandbox reaches tools only through bindings. Calls go "via Workers RPC directly to the host-side connector binding" ([README](https://github.com/cloudflare/agents/blob/1a450e71325c25ca1ec8b0013d756fe0c733b6f3/packages/codemode/README.md)). "The binding itself provides an already-authorized client interface", so the code cannot leak keys ([blog](https://blog.cloudflare.com/code-mode/)).
- The Cloudflare API server uses an outbound proxy, not a binding. `GlobalOutbound` refuses any host other than the API host, applies the policy guard, and injects the token. The token "never enters user code isolate" ([execute.ts](https://github.com/cloudflare/mcp/blob/19f7601ed3a7a9ad41d2637f2f9509e732600cf7/src/tools/execute.ts#L69-L123)).
- The server makes a fresh isolate for each call ([execute.ts](https://github.com/cloudflare/mcp/blob/19f7601ed3a7a9ad41d2637f2f9509e732600cf7/src/tools/execute.ts#L124-L130)). The SDK default timeout is 60,000 ms ([README](https://github.com/cloudflare/agents/blob/1a450e71325c25ca1ec8b0013d756fe0c733b6f3/packages/codemode/README.md)).
- The durable runtime logs each connector call with a sequence number in SQLite. It replays the log on resume. It keeps 50 terminal runs by default ([docs](https://developers.cloudflare.com/agents/tools/codemode/how-it-works/)).
- The talk compares three runtimes: an interpreter (OpenCode), Dynamic Workers, and QuickJS. Executor uses the interpreter for ad hoc scripts and Dynamic Workers for saved apps ([talk](https://www.cloudflare.com/connect/2026/session/giving-an-agent-10-000-tools-with-code-mode/)). (Speaker claims.)

## What this means for Alfred

All items in this section are inferences. They are options for the owner. They are not decisions.

### The settings differ

| Item | Cloudflare | Alfred |
| --- | --- | --- |
| Users | Many tenants and third-party MCP clients. The server cannot trust or know the client. | One owner. Alfred owns the harness, the model, and the approval UI. |
| Permission boundary | The OAuth scope that the user selects at connect. Cloudflare enforces it server-side. | The integration policy (`gated` or `autonomy`) and the risk tier of each tool. |
| Tool metadata | Must be the same for every session, because "MCP clients cache tool metadata and may serve one user's tool list to another" ([execute.ts](https://github.com/cloudflare/mcp/blob/19f7601ed3a7a9ad41d2637f2f9509e732600cf7/src/tools/execute.ts#L605-L612)). | Can depend on the owner's state, because one owner uses it. |
| API knowledge | One vendor API with a full OpenAPI spec and a permission name for each endpoint. | Many MCP servers. Each server supplies its own schemas and hints. |
| Approval | The SDK pauses a script mid-run and replays it. The API server has no approval for each call. | A gated call needs an approval card and runs on the direct path. |

### Problem 1: approval of reads

- Cloudflare: a read has no flag and runs at once. Approval is a flag on one named write method. The API server refuses no read by policy.
- For Alfred: the `gated` policy applies to a whole integration, so it also gates reads. Cloudflare's model puts the approval decision on the method effect, not on the integration. This supports a rule like "a non-destructive, non-secret read runs without a card under `gated`".
- Difference: Cloudflare limits the damage of a read with an OAuth scope that the user chose. Alfred must supply that limit in a different way, for example with a per-tool read class that the owner can see and change. A secret read (for example a token or a credential list) needs its own flag. Cloudflare does not show this case.
- Cloudflare's pause-and-replay design also gives a path for a gated write inside a script. Alfred does not need it to solve problem 1.

### Problem 2: capability teaching

- Cloudflare: the description names all globals and says "Never guess method names". Search and describe return `requiresApproval` before the call. The set that search shows is the set that the sandbox can call.
- For Alfred: the model tried a script read that the runtime refused, because the tool had no read authority. In Cloudflare's design, this cannot happen. A method is either callable from the script, or it is absent from the script's catalog, or it pauses for approval.
- Option: make the script catalog and the script authority one set. Show the read class (or "pauses for approval") in each search and describe result. Put one hint line for each connected integration in the `system.code_run` description.
- Difference: Cloudflare knows the read or write effect from the HTTP method and the spec. Alfred depends on MCP server annotations, which a third-party server writes. Alfred needs its own owner of that classification.

### Problem 3: response size

- Cloudflare: the cap is about 6,000 tokens (24,000 characters), and it applies only to what the model receives. The cut keeps JSON valid, keeps whole list items from the start, and marks each cut with a count. Direct tools return whole results. The script sees the full response.
- For Alfred: the direct path cuts each string at 8,000 characters. This damaged a 9 KB list, and the answer used about 8 issues. Cloudflare would return that list whole, because it is below 24,000 characters. If the list were larger, Cloudflare would drop whole items from the end and say how many it dropped.
- Option: replace the fixed cut for each string with a structural cut on the whole result, at the model boundary. Keep whole records first. Report the count of dropped items so that the model can page or narrow the query.
- On the script path, the model trimmed bodies itself. Cloudflare does not prevent that. The cap and the marker only tell the model that data is missing. This agrees with the 2026-11-18 note that code cannot judge semantic relevance ([problems note](./code-mode-problems-and-boundaries-2026-11-18.md)).
- Difference: Cloudflare's cap protects shared clients with unknown context windows. Alfred knows its own model and context budget, so it can choose its own number. It should measure that number, not copy 6,000.

### Problem 4: tool surface

- Cloudflare: the API server has four tools, the portal has two, and the durable runtime has one. Search, describe, saved scripts, and steps are sandbox functions, not model tools.
- For Alfred: `system.search_tools` and `system.load_tool` do the job that `codemode.search` and `codemode.describe` do inside Cloudflare's sandbox. If a script can call every read, these two tools can move into the sandbox. Other `system.*` reads (for example `list_todos`, `read_user_context`, `read_chat_history`, `current_time`) can become sandbox methods behind one `system` namespace.
- Keep at the top level only the tools with a different job: the code tool, `ask_user`, and the writes that need a live card. Cloudflare keeps `docs` and `whoami` at the top level for the same reason.
- Difference: Cloudflare's model reaches a remote API, so a round trip through code costs little. Some Alfred tools change the chat UI (for example `ask_user` and artifacts). Those need a direct call, and Cloudflare has no equal case.

### What Cloudflare does not answer

- How to classify a third-party MCP tool as a read or a secret read. Cloudflare's API server uses the HTTP method. Cloudflare's SDK leaves the flag to the developer.
- What number to use for the model cap in a single-user product. Cloudflare's 6,000 tokens protects unknown clients. No source gives a quality measurement for it.
- Whether a single-user assistant needs a gateway policy outside the harness. The talk argues for it, but for a product with many harnesses.
