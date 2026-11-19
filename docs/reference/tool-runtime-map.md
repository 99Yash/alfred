# Tool-runtime map

This doc draws one picture of the tool-runtime seams. A reader who opens a seam
file sees an interface and a forwarder, but not which user surface it serves. This
map gives that orientation. Every seam header points here with a `See:` line.

## The one picture

Two user surfaces reach tools, and they reach them in opposite directions:

- The **chat** side executes tools. The boss proposes a tool call, and the
  runtime resolves the surface, dispatches the call, and routes the result.
- The **workflows** side reads the tool catalog. A readiness, author, or revision
  decision confirms that a tool is integrated. It never executes a tool.

The `tool-runtime` module owns the tool definitions, dispatch, catalog,
discovery, schema budgeting, and the shared seams. The catalog lives in
`tool-runtime/internal/registry.ts`. Built-in registration and dispatch use the
narrow `tool-runtime/builtin-tools` and `tool-runtime/dispatch` leaves so the
eager main barrel does not load provider or database graphs. Neither user
surface imports the other, and neither reaches the catalog itself. Each crossing
from chat or workflows goes through one boot seam.

Tool declarations follow the same rule in miniature: a tool module never imports
a provider or database graph. `system.corpus_search`
(`tool-runtime/internal/tools/corpus.ts`) reads the ingested corpus through
`ctx.corpus.search`, a bind built beside the provider bind in
`tool-runtime/context.ts`, so the tool graph stays free of the static
`@alfred/db`/`@alfred/corpus` edge.

A provider with a working MCP server has no curated tool. GitHub is the example
(ADR-0125). The model finds a GitHub tool through the MCP line of the connected
summary, `system.search_tools`, or `mcp.list_tools`. The registry entry
`INTEGRATIONS.github` has `actions: []` and `passthrough: null`. How the model
calls the tool depends on the read path that the chat run pinned at its start
(ADR-0124, `ToolRunContext.readPath`):

- **Direct (flag off, and every background run and sub-agent).** The model calls
  each GitHub tool, read or write, with `mcp.call`.
- **`code_run` (flag on when the chat run started).** The model calls a GitHub
  read inside `system.code_run` as `mcp.read(ref, args)`. A write stays a direct
  `mcp.call`. A read that waits for an approval card (GitHub set to Gated, with
  no full autonomy on the thread) also stays a direct `mcp.call`, because a script
  cannot show a card. One decision (`decideReadRoute` in
  `tool-runtime/read-route.ts`) sets the route of each call. Dispatch refuses a direct
  `mcp.call` whose route is the script. `system.search_tools`, `mcp.list_tools`, and
  `mcp.inspect_tool` give each hit its current `route` (`script` or `direct`, with
  `directReason`) and its `approval` (`none` or `card`). One module
  (`tool-runtime/route-quote.ts`) makes each quote from the inputs that dispatch uses
  (ADR-0130 C1). A script hit of `system.search_tools` is a `system.code_run` hit with
  `hostFunction: "mcp.read"`. Binary reads stay direct too (ADR-0124 amendment
  2026-11-18).

The pin rules the run. A flag change applies only to the next chat run.

Each script keeps an evidence record (ADR-0124 amendment 2026-11-18): one
`code_run_host_calls` row for each host call, linked to the `system.code_run`
staging row and to the nested staging row. Dispatch owns the host-call ledger and
writes it in the transaction of the guarded parent commit, so the tool module has no
database import. Each script read declares `readEvidence`: a reference and a hash
for each delivered item (`itemEvidence`), and the coverage. A replay keeps the
references of its saved result. The sources strip reads `scriptSources`, a field
outside the pruned preview.

Google follows the same rule (ADR-0126, amended 2026-11-15: Alfred makes Gmail drafts
only). The six Google Workspace MCP servers are the Google tool surface, and their rows
borrow the Google credential's token. Three REST tools stay, because no server covers
them: `sheets.append_values` and the three `contacts.*` tools. Reply drafting writes its
Gmail draft through the integration client, not a tool. A pinned read tool of a
Google server runs at `low` with the `read` effect class
(`connections/mcp/built-in-tool-pins.ts`). Each Google MCP write waits for
approval, and `mcp.call` refuses it where Gmail mailbox writes are off.

## The four players

| Player              | Role                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| chat / agent        | proposes and runs tool calls; spawns sub-agents; reads chat history                                                 |
| workflows           | reads tool facts to decide readiness, authoring, and revision                                                       |
| tool-runtime        | owns definitions, dispatch, catalog, discovery, schema projection, and boot seams; imports no user surface directly |
| runtime composition | installs product adapters without adding reverse owner dependencies                                                 |

Runtime composition follows the same rule for trigger consumers. A consumer
lives beside the state it drives, and `runtime/adapters/trigger-consumers.ts`
holds only the registration line. The object-state fold is the example:
`packages/assistant/src/connections/object-state/activity-consumer.ts` sits
beside the ADR-0062 reducers and store it calls (#986), and it builds one
consumer per inbound source rather than one file per provider (#1090).

## The twelve seams

Each seam is a `bootPort<T>` slot. The composition root installs one concrete
value at boot, and a peer reads it. The `src/boot-port.ts` file defines the
factory (`@alfred/assistant/boot-port`); it is not itself a seam.

| Seam interface                   | Surface   | Install → read                                                           |
| -------------------------------- | --------- | ------------------------------------------------------------------------ |
| `ToolRuntimeAdapter`             | chat      | `surface-adapter.ts` installs → the runtime forwarders read              |
| `ToolCallRoundAdapter`           | chat      | dispatch installs → `executeToolCallRound` reads                         |
| `SystemToolAgentAdapter`         | chat      | agent installs → the system tools read                                   |
| `DispatchLeaseAdapter`           | chat      | execution installs → the dispatch staging store reads                    |
| `SystemToolChatHistoryAdapter`   | chat      | chat installs → the system tools read                                    |
| `SystemToolWorkflowAdapter`      | chat      | workflows installs → the system tools read                               |
| `SystemToolKnowledgeAdapter`     | chat      | runtime composition installs → the system tools read                     |
| `SystemToolInstructionAdapter`   | chat      | runtime composition installs → the system tools read                     |
| `SystemToolWebSearchAdapter`     | chat      | runtime composition installs → the system tools read                     |
| `SystemToolTaskAdapter`          | chat      | runtime composition installs → the system tools read                     |
| `SystemToolContextSearchAdapter` | chat      | runtime composition installs → the `system.search_context` tool reads    |
| `WorkflowToolCatalogSource`      | workflows | `workflow-tool-catalog-source.ts` installs → `workflowToolCatalog` reads |

The first eleven seams live in `tool-runtime/index.ts`. The twelfth lives in
`tool-runtime/workflow-tool-catalog.ts`. Each of the twelve seams carries a fixed four-field
header (`Surface:`, `Owns/hides:`, `Why the seam:`, `Wiring:`), and
`scripts/check-module-architecture.mjs` fails when a `bootPort` file inside
`tool-runtime/` lacks it. A `bootPort` slot outside `tool-runtime/` is not one of
the twelve seams and carries no header check.

## Why the seams exist

ADR-0089 sets the rule: the runtime composes tools, and the tools module does not
import a user surface back. Each seam keeps one implementation graph behind a
small boot-time interface:

- `ToolRuntimeAdapter` keeps discovery and availability, including their
  `connections` -> `@alfred/db` reach, out of the eager `tool-runtime` barrel.
- `ToolCallRoundAdapter` keeps the dispatch value graph out of the eager barrel.
- `SystemToolAgentAdapter` inverts `tool-runtime -> execution`.
- `DispatchLeaseAdapter` inverts `tool-runtime -> execution` for the dispatch
  claim, so the claim runs the step commit's own lease check (`withStepLease`)
  and does not copy it.
- `SystemToolChatHistoryAdapter` inverts `tool-runtime -> chat`.
- `SystemToolWorkflowAdapter` inverts `tool-runtime -> workflows`.
- `SystemToolKnowledgeAdapter`, `SystemToolInstructionAdapter`,
  `SystemToolWebSearchAdapter`, and `SystemToolTaskAdapter` invert the product
  operations. Runtime composition owns the suppression-write then todo-dismiss
  sequence because neither product owner can import the other.
- `WorkflowToolCatalogSource` keeps workflow readers on a facts projection and
  out of the private registry.

See the per-seam headers for the exact install and read file pointers, and
ADR-0089 for the full reason.
