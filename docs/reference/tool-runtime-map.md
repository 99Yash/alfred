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

## The four players

| Player                | Role                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------- |
| chat / agent          | proposes and runs tool calls; spawns sub-agents; reads chat history                       |
| workflows             | reads tool facts to decide readiness, authoring, and revision                            |
| tool-runtime          | owns definitions, dispatch, catalog, discovery, schema projection, and boot seams; imports no user surface directly |
| runtime composition   | installs product adapters without adding reverse owner dependencies                       |

## The eight seams

Each seam is a `bootPort<T>` slot. The composition root installs one concrete
value at boot, and a peer reads it. The `boot-port.ts` file defines the factory;
it is not itself a seam.

| Seam interface                 | Surface   | Install → read                                        |
| ------------------------------ | --------- | ----------------------------------------------------- |
| `ToolRuntimeAdapter`           | chat      | `surface-adapter.ts` installs → the runtime forwarders read |
| `ToolCallRoundAdapter`         | chat      | dispatch installs → `executeToolCallRound` reads      |
| `SystemToolAgentAdapter`       | chat      | agent installs → the system tools read                |
| `SystemToolChatHistoryAdapter` | chat      | chat installs → the system tools read        |
| `SystemToolWorkflowAdapter`    | chat      | workflows installs → the system tools read            |
| `SystemToolKnowledgeAdapter`   | chat      | runtime composition installs → the system tools read   |
| `SystemToolTaskAdapter`        | chat      | runtime composition installs → the system tools read   |
| `WorkflowToolCatalogSource`    | workflows | `workflow-tool-catalog-source.ts` installs → `workflowToolCatalog` reads |

The first seven seams live in `tool-runtime/index.ts`. The eighth lives in
`tool-runtime/workflow-tool-catalog.ts`. Each seam carries a fixed four-field
header (`Surface:`, `Owns/hides:`, `Why the seam:`, `Wiring:`), and
`scripts/check-module-architecture.mjs` fails when a `bootPort` file lacks it.

## Why the seams exist

ADR-0089 sets the rule: the runtime composes tools, and the tools module does not
import a user surface back. Each seam keeps one implementation graph behind a
small boot-time interface:

- `ToolRuntimeAdapter` keeps discovery and availability, including their
  `connections` -> `@alfred/db` reach, out of the eager `tool-runtime` barrel.
- `ToolCallRoundAdapter` keeps the dispatch value graph out of the eager barrel.
- `SystemToolAgentAdapter` inverts `tool-runtime -> execution`.
- `SystemToolChatHistoryAdapter` inverts `tool-runtime -> chat`.
- `SystemToolWorkflowAdapter` inverts `tool-runtime -> workflows`.
- `SystemToolKnowledgeAdapter` and `SystemToolTaskAdapter` invert the product
  operations. Runtime composition owns the suppression-write then todo-dismiss
  sequence because neither product owner can import the other.
- `WorkflowToolCatalogSource` keeps workflow readers on a facts projection and
  out of the private registry.

See the per-seam headers for the exact install and read file pointers, and
ADR-0089 for the full reason.
