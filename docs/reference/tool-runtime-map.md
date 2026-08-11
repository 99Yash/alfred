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

The `tool-runtime` module owns the tool catalog and holds the shared seams. The
`tools` module owns the tool definitions. The catalog lives in
`tool-runtime/internal/registry.ts`, and `tool-runtime/index.ts` publishes a
named door over it: a registration group, plus a transitional reader group the
`tools` and `dispatch` modules import directly while the definitions still sit in
`@alfred/api` (campaign item 97 closes that group). Neither user surface imports
the other, and neither reaches the catalog itself — for chat and workflows, each
crossing goes through one boot-seam.

## The four players

| Player                | Role                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------- |
| chat / agent          | proposes and runs tool calls; spawns sub-agents; reads chat history                       |
| workflows             | reads tool facts to decide readiness, authoring, and revision                            |
| tools                 | owns the tool definitions: each tool's schema, credential gate, staging, and `execute`   |
| tool-runtime          | owns the catalog and holds the boot-seams that invert every crossing above; imports no user surface directly |

## The five seams

Each seam is a `bootPort<T>` slot. The composition root installs one concrete
value at boot, and a peer reads it. The `boot-port.ts` file defines the factory;
it is not itself a seam.

| Seam interface                 | Surface   | Install → read                                        |
| ------------------------------ | --------- | ----------------------------------------------------- |
| `ToolRuntimeAdapter`           | chat      | tools installs → the runtime forwarders read          |
| `ToolCallRoundAdapter`         | chat      | dispatch installs → `executeToolCallRound` reads      |
| `SystemToolAgentAdapter`       | chat      | agent installs → the system tools read                |
| `SystemToolChatHistoryAdapter` | chat      | conversations installs → the system tools read        |
| `SystemToolWorkflowAdapter`    | chat      | workflows installs → the system tools read            |
| `WorkflowToolCatalogSource`    | workflows | tools installs → `workflowToolCatalog` reads          |

The first five seams live in `tool-runtime/index.ts`. The sixth lives in
`tool-runtime/workflow-tool-catalog.ts`. Each seam carries a fixed four-field
header (`Surface:`, `Owns/hides:`, `Why the seam:`, `Wiring:`), and
`scripts/check-module-architecture.mjs` fails when a `bootPort` file lacks it.

## Why the seams exist

ADR-0089 sets the rule: the runtime composes tools, and the tools module does not
import a user surface back. Each seam inverts one import edge so the graph stays
acyclic:

- `ToolRuntimeAdapter` inverts `tool-runtime -> tools`.
- `ToolCallRoundAdapter` inverts `tool-runtime -> dispatch`.
- `SystemToolAgentAdapter` inverts `tools -> agent`.
- `SystemToolChatHistoryAdapter` inverts `tools -> conversations`.
- `SystemToolWorkflowAdapter` inverts `tools -> workflows`.
- `WorkflowToolCatalogSource` inverts `workflows -> tools`.

See the per-seam headers for the exact install and read file pointers, and
ADR-0089 for the full reason.
