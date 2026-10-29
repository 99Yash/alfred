# ADR-0116 — Code Mode can write: each write is a host call that goes through dispatch, carries the ADR-0115 record, and is planned before it is applied

**Status.** Proposed; not built. Records the owner decision of 2026-10-22 that Code Mode can write (`docs/theory/product-direction.md` §3). Amends ADR-0087, which scopes `code.run` to reads and to context virtualization. Depends on ADR-0115 slices 1 and 2. Uses Armin Ronacher, "What is Codemode" (2026-10-06, <https://lucumr.pocoo.org/2026/10/6/codemode/>) as the outside reference.

**Decision.** A `code.run` program can change state only through **write host functions**. Each write host function is a facade over one tool, and it goes through the same dispatch pipeline as that tool: the same `action_stagings` row, the same request-hash barrier, and the same executor. The approval gate is the Code Mode gate below, not the per-tool policy mode. Each call carries the ADR-0115 attribution record, with `toolCallId = <code.run tool call id>#<requestIndex>`. A program runs two times. The **plan pass** runs the reads and records each write without applying it. The **apply pass** replays the program after approval and applies only the writes in the approved plan. The user turns on each write capability in settings, and each capability is off by default.

## Why

**The owner's goal is wider than ADR-0087.** ADR-0087 gives Code Mode one job: keep a large result out of the transcript. The owner's product direction is "the agent has the API … and can do anything that the API allows. Permissions come from memory or instructions" (`product-direction.md:14`). The example is per record: "the agent may delete the action items that it created when it closes the loop".

**ADR-0115 makes the per-record rule possible.** The per-tool policy cannot express "the agent created this record". The provenance columns exist (`todos.created_by`, `todos.agent_run_id`, `packages/db/src/schema/todos.ts:39,49`), and `todo_events` keeps the history, but no rule reads them. ADR-0115 adds the actor, the authority, and the run and tool-call ids to each change. With that record, "the agent created this, and the user did not touch it after" is a query, not a guess.

**The article confirms the shape, and adds four ideas.** Ronacher's Codemode runs model-written JavaScript in QuickJS in WebAssembly with "no network, no filesystem, no timers". "The only way is to call more tools." That is the ADR-0087 substrate (`run`, QuickJS in WebAssembly, host functions only). The article adds these points, and each one has a place below:

1. **Probe, then script.** The agent tries a few items by hand, then writes a program for the rest. This is the plan pass: a probe whose writes do not apply.
2. **Non-tool APIs.** A program calls a classifier model as a function, without a tool for each use. In Alfred this is a `models.classify` host function over `route("cheap")`.
3. **Structured output.** A program needs the whole structured result, not the text that the model sees. Alfred already has the `result: "structured"` MCP call option (#1579, `connections/mcp/client.ts`).
4. **Durability is open.** The article names "snapshotting invocations" as future work. Alfred already has a durable executor and the `run` stored continuation (ADR-0087 amendment of 2026-08-19), so a parked program survives a deploy.

**The evidence gate of ADR-0087 has not fired.** The rung-(a) truncation thermometer (`tool-runtime/internal/tools/passthrough/telemetry.ts`) has not shown a need for handles. This ADR does not claim that it has. The driver here is the owner's product decision, not the thermometer. The instrumentation below starts with the first slice, so the need is measured from day one.

## The product flow

### Chat: "dismiss the todos from the Polylane alerts"

1. **The user asks.** The user writes the message in a thread. Admission writes the message and the run (`chat/turn-admission.ts`). The message id is the `authorityRef` for every write in this turn.
2. **The boss writes a program.** The boss loads `code.run` with `load_tool` and writes one program. The field names of `todos.list` are an example; its output shape is decided when the tool is built.

   ```js
   const open = await todos.list({ status: "open" });
   const alerts = open.filter((t) => t.source?.senderEmail?.endsWith("@polylane.dev"));
   for (const t of alerts) await todos.dismiss(t.id, { cause: "user_request" });
   return { dismissed: alerts.length };
   ```

3. **The plan pass runs.** `todos.list` runs as a real read. Each `todos.dismiss` does not change the row. It returns `{ planned: true }` and adds one entry to the plan: the tool, the target id, the request hash, and the attribution record. The program returns `{ dismissed: 9 }`.
4. **Code decides the gate for each planned write.** The order is in "The gate" below. For example, 6 todos were created by an agent and the user did not change them, so rule 4 makes them autonomous. 3 todos were created by the user, so rule 5 gives them a card. The 6 autonomous writes also go on the card, because one card shows the whole plan.
5. **The user sees one card.** If one write needs approval, the run shows one approval card for the whole plan: "Alfred wants to run a program that dismisses 9 to-dos", with the list and the gate of each item. The run parks. The stored continuation and the plan are on the staging row, so a deploy does not lose them. The card expires after 24 hours, as other approvals do.
6. **The user approves or rejects.** A reject ends the program with no writes, and the boss gets the rejection as the `code.run` result. An approval starts the apply pass. Partial approval is not in v1.
7. **The apply pass runs.** The program runs again. Completed reads come from the replay ledger. Each write must match an entry in the approved plan by request hash. A write that is not in the plan stops the program before that write runs. Then the boss reports what applied and what did not.
8. **The history is written.** Each dismissal writes a `todo_events` row through the ADR-0115 trigger: `actor = 'agent'`, `authority = 'user_request'`, `authorityRef` = the message id, `runId`, `toolCallId = <id>#<requestIndex>`, `cause = 'user_request'`, and the status before and after.
9. **The user sees the result.** The reply says "Dismissed 9 to-dos". The rail shows each dismissed todo with "Alfred dismissed this. You asked in chat." and an Undo control. An undo is a new event (ADR-0115, "Uses of the history").

If nothing needs approval, steps 5 and 6 do not occur, and the apply pass starts at once.

### Background: the agent closes a loop that it opened

A workflow run or the background boss has no user message. It cannot use `user_request`. It can write only under `instruction` (a standing instruction at a stated revision) or `policy` (a closed code). The owner's example is a `policy` write: `policy.close_own_loop` lets the agent dismiss a todo that an agent created, when the user did not change it. Content that the run read (an email, a web page, a tool result) cannot supply an authority, so an instruction inside an email cannot start a write.

### What can go wrong, and what the user sees

| Case | Result |
| --- | --- |
| A todo changes between the plan and the apply (the user completes one). | The apply write has a new request hash or the drift guard sees a new `row_version`. The program stops before that write. The boss reports which writes applied. |
| The program writes something that is not in the plan (its reads returned new data). | The program stops before the first write that is not in the plan. No new approval is implied. |
| The approval expires. | The `staging-expire` worker rejects it. No write applies. |
| A capability is off in settings. | The plan pass returns a `capability_off` rejection for that write at once, so the boss can tell the user which setting to turn on. |
| The plan pass hits a `run` limit (30 s, 256 bridge requests). | `RunError` maps to an honest outcome (plan, "Errors"). No write has applied, because the plan pass never writes. |
| The program plans more autonomous writes than the cap. | The whole plan needs approval. See "The gate", rule 4. |

## The design

### Write host functions

- Each write host function names one tool, for example `todos.dismiss` → `system.resolve_todo`. The function builds the tool input and calls the dispatch pipeline (`tool-runtime/internal/dispatch/pipeline.ts`). It does not call the store directly. So staging, idempotency, the request-hash barrier, and the effect outcome are the same as for a tool call.
- The staging row uses `toolCallId = <code.run tool call id>#<requestIndex>`. The unique index `action_stagings_run_tool_call_idx` on `(run_id, tool_call_id)` then gives each host write one row, and the replay reuses the same row.
- A program cannot call a tool by name. The set of write host functions is a closed table in code, keyed by tool name, with `satisfies` so that a new entry is a code change.
- Write host functions do not exist in the guest unless the capability is on. A read host function never writes.

### The plan pass and the apply pass

- **Plan pass.** Reads run. Each write host function validates its input, computes the request hash, decides its gate, adds a plan entry, and returns `{ planned: true, id }`. It does no other work. The plan is stored as one JSON value on the `code.run` staging row.
- **Apply pass.** The program replays from the stored continuation. Each write must find its plan entry by request hash, and each entry can match one time. A write host function calls `interrupt()` before any non-idempotent work and uses `resume.interruptionId` as its idempotency key (ADR-0087 obligation iii).
- **Why two passes, not one interrupt per write.** A sequential program that interrupts at each write shows the user one card for each write. The plan pass shows the whole effect one time, before any write. This is the "probe, then script" idea of the article, applied to approval.
- **Accepted cost.** The apply pass runs the reads again unless the replay ledger has them. A read that returns new data can change the write set, and then the program stops. That is the correct result, because the user approved a different plan.

### The gate

For each planned write, code decides in this order. The first rule that decides wins.

1. **Capability.** The capability must be on in settings. If it is off, the write is rejected.
2. **Authority (ADR-0115 rule 1).** The write must carry a valid `authority` and `authorityRef`. If not, the write is rejected.
3. **High-tier floor (ADR-0069).** A `high` write needs approval. Provenance does not waive it.
4. **Provenance autonomy.** The write is autonomous if all of these are true: the target was created by `actor = 'agent'`; no event on the target has `actor = 'user'`; the target has a complete history (a record from before its ADR-0115 slice is "not recorded" and fails this rule); and the plan has at most 5 autonomous writes. If the plan has more, all of its writes need approval.
5. **Otherwise, approval.** The thread full-autonomy flag (`chat_threads.full_autonomy`) waives this card, as it waives a card in dispatch today (`dispatch/pipeline.ts:708-712`).

**Code Mode does not inherit the per-tool policy mode.** `resolvePolicyMode` returns `autonomy` for every `system.*` tool before it reads a row (`action-policies/resolve.ts:104`, ADR-0040 D5), and `system.resolve_todo` is `no_risk`. With rule 3 of dispatch alone, every todo write in a program would be autonomous, and rule 4 would never apply. That rule was made for one tool call that touches the records the boss named. A program can touch every record that a read returns, so for a program the per-record rule replaces the per-tool mode. This makes one `code.run` stricter than the same writes as single tool calls. That asymmetry is intended. Whether rule 4 also applies to a single `system.resolve_todo` call is a separate decision.

**In the apply pass, the plan decides.** Each write host function calls dispatch with the gate result of its plan entry. Dispatch writes a child staging row with `requires_approval` from that result and with the id of the approved `code.run` staging row, and it does not show a second card. The child row still runs the request-hash barrier and the effect outcome.

The cap in rule 4 limits the case that ADR-0115 names as its honest limit: a program written after the agent read hostile content can still cite the user's message. A cap of 5 and the Undo control limit what such a program can hide without a card.

### Read host functions that this ADR adds

- `models.classify(items, schema)` calls `route("cheap")` one time for each batch and returns typed results. A program has a model-call cap, and each call is metered like a tool call (`packages/db/src/schema/metering.ts`). This is the "non-tool API" idea of the article.
- `mcp.read(server, tool, args)` uses the `result: "structured"` option, so a program gets the whole `structuredContent`. This is a facade over the same broker read that `mcp.call` uses, with the same gate.
- **One prepared catalog for each server in a program** (owner decision of 2026-10-29). The first `mcp.read` on a connection prepares its catalog, and each later `mcp.read` on that connection in the same pass uses that prepared catalog. The broker read prepares the catalog before each call, and a server that sends `ttlMs: 0` made each call list the catalog again (GitHub: 9-17 s for each call). The 5-minute catalog TTL floor in `connections/mcp/protocol.ts` removes most of that cost, but a program must not pay it N times when the floor expires or a list-change event arrives. One catalog also gives one tool revision to the whole pass. If the server rejects a stale descriptor, the read fails with `descriptor_mismatch`, and the program gets a `RunError`. The program does not prepare the catalog again in the same pass.

### What this ADR does not adopt from the article

- **MCP tools only through Code Mode.** The article does not show MCP tools to the model directly. Alfred keeps `mcp.call` and the lazy tool surface (#405) for v1. Code Mode must first prove itself on Alfred's own entities.
- **Nested Code Mode.** A remote MCP server that runs its own code mode (the article names Cloudflare) is one host call to Alfred. Alfred does not expose a code tool inside a code tool. The article calls nesting "pretty bad", and the inner code cannot reach Alfred's host functions.
- **Starlark.** The article suggests a deterministic language. Alfred stays on JavaScript, because `run` replay already makes `Date`, `Date.now()`, and `Math.random()` deterministic (ADR-0087 amendment of 2026-08-19), and models write JavaScript well.
- **Images.** Artifacts (ADR-0075) stay the path for visual output. A program does not return an image in v1.

## v1 capabilities

v1 includes only writes on Alfred entities that have an ADR-0115 event table, because only those have provenance and undo.

| Capability | Host functions | Tool | Needs |
| --- | --- | --- | --- |
| (read, always on with `code.run`) | `todos.list` | a new `system.list_todos` read | a new tool |
| `code.todos` | `todos.dismiss` | `system.resolve_todo` with a new `kind: "todo_ids"` input arm | ADR-0115 slice 1, a new input arm |
| `code.todos` | `todos.suggest` | `system.suggest_todo` | ADR-0115 slice 1 |

Two tool changes come first, and both are useful without Code Mode. **`system.list_todos`** does not exist: no chat tool reads the user's todos today (`docs/theory/product-flow.md` §5, "Gaps"). **`system.resolve_todo` takes no todo id**: its input has one arm, `kind: "gmail_sender"`, which matches by sender, thread, or account (`contracts/src/tool-schemas.ts:1545`). A program that filters todos by a field needs to name the ids it chose.

External writes (Gmail labels, send, MCP writes) come after ADR-0115 slice 4 puts the record on the ledgers, and each needs its own capability row. Triage tags and standing instructions come after their event tables (ADR-0115 slices 3 and 2).

## Instrumentation

These start with the first slice, not after it:

- One span for each `code.run`, with the program hash, the pass (`plan` or `apply`), the read and write counts, the model-call count, and the `RunError` code if any.
- One counter for each gate result (`capability_off`, `no_authority`, `high_tier`, `provenance_autonomous`, `cap_exceeded`, `approval`, `full_autonomy`).
- One counter for each apply stop (`not_in_plan`, `drift`), and one counter for undo events on a Code Mode write. A high undo rate is the signal that the gate is too loose.

## Rollout

1. ADR-0087 slice 1: the handle substrate and a read-only `code.run`. In parallel: `system.list_todos` and the `todo_ids` arm of `system.resolve_todo`.
2. ADR-0115 slices 1 and 2: the contract, todo events, and authority enforcement.
3. The plan pass and the apply pass, with no write capability on. The plan card shows the writes, and every apply is rejected. This proves the plan and the replay on real runs.
4. `code.todos`, off by default, with the gate and the instrumentation.
5. `models.classify` and `mcp.read`.

## Alternatives

- **(a) One interrupt for each write.** Rejected. A sequential program shows one card for each write, and the user approves a plan that they cannot see whole.
- **(b) Writes call the stores directly, not dispatch.** Rejected. It skips the policy, the staging row, the idempotency key, and the effect outcome, and it makes a second write path.
- **(c) A free `tools.call(name, args)` host function.** Rejected. It turns every tool into a Code Mode write, and the settings toggle loses its meaning.
- **(d) Provenance autonomy with no cap.** Rejected. It lets a program that read hostile content hide any number of agent-created records without a card.
- **(e) Keep Code Mode read-only (ADR-0087 as written).** Rejected by the owner on 2026-10-22.

## Cross-ref

Amends ADR-0087 (read-only scope and point 5 `broker.write`, which this ADR defines). Depends on ADR-0115 (record, rule 1, event tables, undo). Uses ADR-0034 and ADR-0069 (approval taxonomy and the high-tier floor), ADR-0050 D4 (a saved program can later become a workflow step of kind `code`; not in this ADR), and ADR-0075 (artifacts). Product direction: `docs/theory/product-direction.md` §3 and §9.
