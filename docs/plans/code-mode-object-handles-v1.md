---
status: proposed
evidence: "#535, #898 and epic #271 open. Only docs PRs merged (#536, #869); no handle or sandbox code."
---

# Code Mode / Object Handles — rung-(b) v1

**Status:** Designed (grilled 2026-07-21). **Substrate amended 2026-08-19, and again 2026-08-26** — see [Substrate](#substrate-amended-2026-08-19-dependency-narrowed-2026-08-26). Decision record: ADR-0087 (extends ADR-0074 rung-(b)). Epic: #271. Issues: #535 (build), #898 (trajectory scorers).

**Re-scoped 2026-11-11 by [ADR-0124](../decisions/ADR-0124-code-mode-is-the-chat-read-path.md).** Code Mode is the chat read path, and handles wait. Of the build order below, step 1 (the handle substrate) is deferred until a script-trimmed result still does not fit; the build starts at step 2, with the curated read tools — not `broker.read` — as the host functions, the index generated from the TypeScript return types, and no plan-then-apply writes (ADR-0116 waits for its bulk-write trigger). The substrate, limits, honest envelope, and eval obligations carry over unchanged. Forced provenance on the return is dropped (owner, 2026-11-17): the host-side call ledger is the only record.

## One-line

Keep large tool results out of the transcript by **parking them as object handles**, and let the boss compute derived results over a handle by writing **JS/TS run in a network-less, credential-less self-hosted sandbox** whose only capabilities are host functions.

## Framing (what this is NOT)

This is _not_ the "do anything in the API" / composition / BYO-MCP tier the ADR-0074 title imagines. The grill established (with receipts) that those drivers are dead or unproven:

- **Token cost of many tool defs** — already solved by the lazy tool surface (#405/#411/#412/#414; kernel = 8 tools, ratchet-guarded by `packages/assistant/test/tool-runtime/schema-budget.test.ts`).
- **Multi-step composition latency** — unmeasured/speculative; the one profiled case (`docs/plans/chat-latency-and-github-tools.md`) was a DB-orchestration bug, and the real fan-out need was fixed by _curation_ (`github.search`).
- **BYO-MCP** — owner instinct, zero user demand at n=1.

The **only** live justification is **context virtualization** (the L0 sketch in `docs/plans/context-working-set-considered.md`), and its evidence gate — the rung-(a) truncation thermometer — **has not fired**. So v1 is a deliberate **experiment built ahead of proven need**. If the isolate cost outruns the need, the honest off-ramp is a bounded `read_object(handle, jsonpath, page)` peek path with no isolate at all (rejected by the owner for v1, kept on record).

## Locked decisions (from the grill)

| Axis            | Decision                                                                                                                                                                                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Driver          | Context virtualization only                                                                                                                                                                                                                                                                                                                                        |
| Park trigger    | **Auto** at the existing rung-(a) bound (>32 KiB / >50 items / >8 000-char string)                                                                                                                                                                                                                                                                                 |
| Handle payload  | `{ handle, preview, schema, rowCount, provenance }` in the transcript                                                                                                                                                                                                                                                                                              |
| Storage         | R2 blob + Postgres metadata row, **thread-scoped + TTL**                                                                                                                                                                                                                                                                                                           |
| Query interface | **`code.run(source)` only** (no DSL, no non-code peek)                                                                                                                                                                                                                                                                                                             |
| Language        | JS/TS                                                                                                                                                                                                                                                                                                                                                              |
| Substrate       | ~~Self-hosted `isolated-vm` V8 isolate in a forked worker, IPC bridge to main process~~ → ~~`experimental_runCodeMode` from `@ai-sdk/code-mode`~~ → **`run` from `vercel-labs`, called directly** — an embedded QuickJS WebAssembly module in a `node:worker_threads` worker (2026-08-19; dependency narrowed 2026-08-26)                                          |
| Network         | **Sandbox has zero network** — now structural: the guest owns no network API at all                                                                                                                                                                                                                                                                                |
| Capabilities    | **Host functions only**: `load(handle)` (paged cursor), `broker.read` (facade over rung-a), `broker.write`. This is `run`'s native `hostFunctions` model, and async host functions are supported. ADR-0116 adds `models.classify` and the `mcp` group: `mcp.servers`, `mcp.search`, `mcp.describe` (catalog discovery in the sandbox, 2026-11-02), and `mcp.read`. |
| Credentials     | Never in the isolate; main API process is the only holder                                                                                                                                                                                                                                                                                                          |
| Sandbox host    | ~~Forked worker process~~ → **worker thread in the API process** (2026-08-19). Guest JS runs in QuickJS _inside_ WebAssembly, so an escape needs a QuickJS bug **and** a WASM-sandbox escape. A `child_process.fork()` wrapper stays available as cheap hardening.                                                                                                 |
| Writes          | **Plan-then-apply** (dry-run → approve → apply)                                                                                                                                                                                                                                                                                                                    |
| Replay          | ~~Hash code + inputs~~ → **`run` signed continuations with a replay ledger** (2026-08-19): replay verifies transformed source, host-function-name manifest, and the complete serialized argument list, and rejects divergence before a mismatched host function runs                                                                                               |
| Write TOCTOU    | **Drift-guard write targets** — re-read only mutated entities at apply, abort on drift                                                                                                                                                                                                                                                                             |
| Honesty         | **Forced provenance** on returns (which reads fed it / errored / emptied); behavioral eval **plus four deterministic trajectory scorers** (#898, added 2026-08-26)                                                                                                                                                                                                 |
| Return bound    | Over-bound return **re-parks recursively** as a new handle                                                                                                                                                                                                                                                                                                         |
| Gating          | **On-by-default** for the single user (data stays in-house); graduation gated on code-run telemetry + thermometer                                                                                                                                                                                                                                                  |

## Residual risk (accepted, not covered by the isolate)

The no-network / no-credential isolate closes exfil **by the injected code itself** — it has nothing to send and nowhere to send it. It does **not** close the loop that code feeds: a `code.run` return re-enters the transcript, and the boss orchestrator retains egress through its **legitimate** tools (`gmail.send`, etc.). So `injection → broker.read private data → boss-steered send via a real tool` stays open. That is the **general agent-exfil problem**, unchanged by this rung — the isolate boundary is not what addresses it, and the forced-provenance return contract targets a _different_ failure mode (laundering a structural confident-zero). Named here so "designed out rather than mitigated" is not misread as covering it.

## Superseded during the grill (do not carry forward)

- RPC-to-broker over the network → **host-injected capabilities over IPC**.
- Public broker + mTLS + per-run token → **internal host functions** (no public surface).
- Freestyle.sh SaaS substrate → **rejected on data custody** (third-party cloud, no VPC/self-host, would force a public cred-broker + route private reads through a V8 boundary with undocumented SOC 2/residency). Its pre-adoption verification to-dos are moot.
- Egress allowlist → **moot** (no network in the isolate at all).

## Superseded by the 2026-08-19 substrate amendment (do not carry forward)

- Hand-built **`isolated-vm`** isolate → the embedded QuickJS WebAssembly module. The native build, the `tsdown` externalization, and `--no-node-snapshot` all go away with it.
- **Forked worker process + IPC bridge** → one worker thread that the package owns. Alfred writes no bridge protocol.
- **Hash code + inputs** for replay → signed continuations with a replay ledger.
- **Operating-system egress-denial proof** → moot. The guest has no network API, no timers, no `crypto`, no environment variables, no modules, no filesystem, and no dynamic evaluation; built-in prototypes are frozen.

## Superseded by the 2026-08-26 dependency narrowing (do not carry forward)

- **`@ai-sdk/code-mode`** → `run` called directly. The wrapper's only remaining job was to convert AI SDK `tool()` definitions into `hostFunctions`, and Alfred's three capabilities are not AI SDK tools.
- **The exact `ai` peer lockstep** → gone. `run` declares no peer dependencies, so the `ai` catalog pin is a free choice again. Keep the `minimumReleaseAgeExclude` trap on record; it no longer applies to this decision.
- **Every `experimental_` name** → the stable `run` name. `executionPolicy` → `limits`; `experimental_setMaxWorkers` → `setMaxWorkers`; `experimental_continueCodeModeApproval` → a `run()` call carrying `continuation` + `resolutions`.

## Substrate (amended 2026-08-19; dependency narrowed 2026-08-26)

### What runs the code

`run` from `vercel-labs` (Apache-2.0, **zero runtime dependencies**), called directly. Pin it **exactly**. The pin is **`2.1.13`** (published 2026-11-12; source re-reviewed 2026-11-17 — see the receipts below). It embeds a QuickJS WebAssembly module (built by `quickjs-wasi` 3.6.3; the decoded bytes start with the WASM magic `00 61 73 6d`) and starts it in a `node:worker_threads` `Worker` created from a `data:text/javascript` URL with `execArgv: []`. Receipts from the published `2.1.13` tarball:

```
run@2.1.13  dist/runtime/manager.js         import { Worker } from "node:worker_threads";
run@2.1.13  dist/runtime/worker-source.js  export const INLINE_RUN_WORKER_SOURCE = "globalThis.__RUN_QUICKJS_WASM_BASE64__ = \"AGFzbQ…"
run@2.1.13  worker builtins (grep of the embedded worker): buffer, fs (writeSync only, WASI stdio), util, worker_threads
run@2.1.13  no node:http / node:net / node:dns / node:tls / node:child_process / node:vm anywhere in dist
```

**This is a library, not a hosted service.** The grep above is the whole audit: no request leaves Alfred's own process, so the Freestyle.sh data-custody rejection does not extend to it.

Changes between the `2.0.1` pin of 2026-08-26 and `2.1.13`, each verified in the published `dist`:

- **`limits.cpuTimeoutMs` (2.1.8, default 10 s).** Bounds the guest JavaScript of one invocation separately from the wall clock; awaiting async host functions does not count. Exceeding it fails with the new `RUN_CPU_TIMEOUT`. It replaces a hidden interrupt cap that stopped long loops after about a second regardless of `timeoutMs`.
- **`RUN_USER_SOURCE_ERROR` (2.1.4).** An uncaught guest error surfaces with this code, so source failures are distinguishable from infrastructure failures. **A memory-limit kill also surfaces as `RUN_USER_SOURCE_ERROR`** — the honest envelope cannot tell a script bug from an OOM by code alone.
- **Synchronous host functions and native ES module loaders (2.1.0).** Not used by the read path: Alfred's host functions stay async, and the guest gets no module loader.
- **Guest TypeScript type stripping runs through Node's `stripTypeScriptTypes` first.** The `typescript` peer dependency (declared `>=5.1.6 <7` from 2.1.x, **optional**) is loaded only when Node's own stripper is missing — Node < 22.6. Alfred runs Node 26 (`.nvmrc`), so the peer never binds and the workspace's `typescript: ^7.0.2` pin is unaffected. `engines` relaxed to `node >=20.19.0`.
- **Fail-closed banned-pattern check in the package's own CI (2.1.1) and bounded guest-error conversion (2.1.13)** — hardening releases, no API change.

`github.com/vercel-labs/run` is **public** since the 2026-08-25 announcement, so review the source in the repository rather than in the published sourcemaps.

### Integration shape

Call `run()` (or `createRunner().run()` to share limits) from **inside Alfred's own `system.code_run` tool**. Alfred keeps the dispatcher, the read gate, the tool cards, the schema budget, and the honest envelope.

Do **not** add `@ai-sdk/code-mode`. Its `experimental_codeModeTool()` + `experimental_toolCallers` path hands tool routing to the AI SDK, bypasses Alfred's gate and card surface, and the AI SDK documents that approval flows do not work through nested tool calls. Its `experimental_runCodeMode` path only converts AI SDK tools into host functions, which Alfred does not need — and it drags in an **exact** `ai` peer pin (`1.0.36` ↔ `7.0.79`) for that indirection.

The public surface is stable: a probe found **zero** `experimental_` identifiers in `run@2.0.1`. The exports are `run`, `createRunner`, `getHostFunctionContext`, `isRunInterruptedResult`, `setMaxWorkers`, `createSignedContinuationCodec`, `createStoredContinuationCodec`, and nine `RunError` subclasses.

### Limits (documented, overridable per run or per `createRunner()` through `limits`)

| Limit                                     | Default |
| ----------------------------------------- | ------- |
| Wall-clock timeout                        | 30 s    |
| CPU timeout (`cpuTimeoutMs`, 2.1.8+)      | 10 s    |
| QuickJS memory                            | 64 MiB  |
| QuickJS stack                             | 2 MiB   |
| Source                                    | 256 KiB |
| Result                                    | 1 MiB   |
| Console output                            | 64 KiB  |
| Host-function arguments                   | 1 MiB   |
| Host-function output or interrupt payload | 4 MiB   |
| Bridge requests                           | 256     |
| Concurrent bridge requests                | 32      |

The worker pool cap is process-wide, shared with any other `run` user in the process, and set through `setMaxWorkers`; excess invocations reject with `RunConcurrencyError` rather than queue without bound. Every run gets a fresh QuickJS context, and a worker that cannot reach a verified clean state after an abort, a timeout, or a protocol failure is retired.

Failures **throw** rather than returning a status. `RunResult` is only `{ status: 'completed', value }` or `{ status: 'interrupted', interruptions, continuation }`; everything else raises a `RunError` subclass with a stable `code` (`RUN_TIMEOUT`, `RUN_CPU_TIMEOUT`, `RUN_ABORTED`, `RUN_CONCURRENCY_LIMIT`, `RUN_PROTOCOL_ERROR`, `RUN_HOST_FUNCTION_ERROR`, `RUN_BRIDGE_LIMIT`, `RUN_SOURCE_TOO_LARGE`, `RUN_DETACHED_BRIDGE_REQUEST`, and `RUN_USER_SOURCE_ERROR` for an uncaught guest error). Alfred's honest envelope maps each of those to a user-visible outcome; do not let one fall through to a generic message. Two nuances measured by the probe: a wall-clock or CPU overrun surfaces as `RUN_TIMEOUT` or `RUN_CPU_TIMEOUT`, but a memory-limit kill surfaces as `RUN_USER_SOURCE_ERROR` — the envelope cannot tell a script bug from an OOM by code alone.

Values cross the boundary in `run`'s versioned `run-js-v1` format, which carries primitives, plain objects, arrays, cycles, `Date`, `RegExp`, `Map`, `Set`, typed arrays, and `Error`. Functions, symbols, promises, and class instances **cannot** cross, so a parked page must reach the guest as plain data — which it already does.

### Version pinning rule

Pin `run` **exactly** and re-review the source on each bump; it is a `vercel-labs` package at major version 2 with a young changelog. It declares no peer dependencies, so it constrains no other catalog entry.

Two facts kept from the superseded `@ai-sdk/code-mode` rule, because they still describe this workspace. The `ai` catalog pin is `7.0.66` and is now a **free** choice — nothing in this plan requires a specific `ai` release. And one measured pnpm trap remains true for any deliberate bump: `minimumReleaseAgeExclude` is honored while pnpm **resolves**, but not while it **verifies an existing lockfile**, so a too-new transitive package blocks every later `pnpm install` even with an exclude entry present. Bumping straight to `ai@7.0.68` pulled `@ai-sdk/gateway@4.0.54` (published the same hour) and wedged install; `7.0.66` pulls `@ai-sdk/gateway@4.0.52` and installs clean.

## Slice 2 — the read path (settled 2026-11-17)

ADR-0124 build. The owner made three decisions on 2026-11-17. The agent made the other decisions in this section from the code. Each decision gives its reason.

### Owner decisions

1. **The MCP reads are in this slice.** Gmail, Calendar, and GitHub have no curated actions. All their reads go through `mcp.call`, and so does the 41-call driver run. A slice with only the curated reads cannot reach them.
2. **A read that the user's policy gates fails in the script, with a named error.** The script gets no card, and the read does not run. The host function throws `needs_approval`, and the script's `catch` gets the error. The interrupt and resume of build-order step 3 wait for their own trigger. **Amended 2026-11-17 (review of #1776):** the same read keeps its direct route with its card. See decision 5.
3. **A default-off flag does the flip.** When the flag is on, `system.code_run` is on the boss surface. A read that cannot wait for a card is not on it. When the flag is off, the surface is the same as today. Decision 5 amends ADR-0124 decision 1 for the reads that wait for a card.
4. **The pin rules the run (2026-11-17, review of #1776).** The flag decides the read path only when a chat run starts. A pinned `code_run` run keeps `system.code_run` until it ends. No gate reads the live flag, so a flag that goes off cannot strand a parked run.
5. **A read that waits for a card is a direct call (2026-11-17, review of #1776).** A script cannot show a card, so in a `code_run` run a read that the gate holds for a card runs as a direct call with its card. Each other read runs in a script, and dispatch refuses its direct call. Full autonomy of the thread reaches a script read, so under it every read runs in a script. Before this decision, a GitHub read under Gated could not run at all with the flag on (ADR-0125 decision 2, ADR-0069 amendment of 2026-10-24). The rule covers each gateable read, the curated `contacts.*` and `vercel.*` reads too, not only MCP.

### The seam: a host call is a nested dispatch, not the `fast_path` arm

The 2026-11-17 handoff said that host functions use the `fast_path` arm. The code shows that this is not possible. Only 7 tools use that arm. The reads that matter use the staged arm, and `mcp.call` needs its staging row, because the MCP broker keys its ledger on that row. Thus each host call goes through the full dispatch pipeline:

- `toolCallId = <code.run toolCallId>#<hash of tool and input>.<occurrence>`. Each read gets its own `action_stagings` row, tool span, gate, and replay. If a crash causes `code.run` to run again, each read that has a saved row replays and does not run again. The id does not use `run`'s request order, because a restart can give one position to a different read. **Amended 2026-11-17:** the first version used `#<requestIndex>`.
- **Dispatch uses the `deferIfGated` mode.** Dispatch returns `deferred` before it writes a row, if the gate would show a card. The host function then throws `needs_approval`, and the message tells the model to make the same read as a direct call with its card (owner decisions 2 and 5).
- **The nested dispatch keeps the parent's approval thread.** Thus full autonomy of the thread waives the card for a script read, the same as for a direct call (owner decision 5). **Amended 2026-11-17:** the first version did not send the thread.
- **`mcp.read(ref, args)` also refuses a tool that is not read-only before it dispatches.** It uses the selected descriptor's `readOnlyHint`, with the check that `mcp.call` already uses. This is a second barrier. A high-tier `mcp.call` also stops at the gate.

### What is a read

`riskTier: "no_risk"` does not mean that a tool is a read. For example, `system.resolve_todo` and `system.write_scratch` are `no_risk`, and both write. Thus a curated tool states `codeModeRead: true`. `registerTool` refuses the flag on a tool that has one of these properties: it is not `replay: "safe"`, it is `high` tier, it uses the `artifact_mutation` lane, or its staging is `join`, `question`, or `confirm`. The v1 read set:

- `contacts.search`, `contacts.list`, and `contacts.get`.
- `vercel.list_projects`, `vercel.list_deployments`, and `vercel.request`. The `request` tool permits GET and HEAD only.
- `system.web_search`, `system.fetch_url`, `system.search_context`, `system.corpus_search`, `system.read_chat_history`, `system.read_user_context`, `system.list_instructions`, `system.list_todos`, and `system.read_scratch`.
- `mcp.list_tools` and `mcp.inspect_tool`. They do the job of ADR-0116's `mcp.search` and `mcp.describe`, so the script uses their names and there are no new names.
- `mcp.read`. This is the only new host function. It is a facade over `mcp.call`.

In the script, each host function has its tool name, for example `contacts.search(input)` or `mcp.read(ref, args)`. `fetch_url` returns text and only reports binary resources, so it is a read (ADR-0124 decision 4).

### The index: guest types that the compiler checks

TypeScript 7 has no JavaScript compiler API, so a build step cannot ask the checker for a return type. The index uses this method:

- Each read tool annotates its `execute` with a named output type. `packages/assistant/codegen/code-mode-guest-index.ts` maps each host path to `guest<ThatType>()`, where `Guest<T>` is the JSON form of `T`. Dispatch sanitizes each result to JSON, so a `Date` becomes a string.
- The generator `scripts/generate-code-mode-index.mjs` compiles that file with declaration emit. The compiler prints each `guest<T>()` call as the expanded type, and the generator copies the text into `guest-index.generated.ts`. The printer reuses an alias name for any type with the same structure as a declared one, so `Guest<T>` adds markers that the generator removes. The generator fails if `import(`, `any`, or an elided type is left. `pnpm check:code-mode-index` generates the file again and fails if the file is stale.
- The index is checked at boot. If a `codeModeRead` tool and the index do not agree, registration throws. The input of each host function comes from the tool's model-facing JSON Schema, which is what the model sees today. The 2a description is about 3.4k tokens.
- The `code.run` description holds the curated index and the `mcp.*` functions. An MCP tool's type comes from its descriptor at run time: the script calls `mcp.inspect_tool`. If the tool has no output schema, the script first returns a short sample (ADR-0124 decision 2). Each user's MCP tools are different, so the description stays static, and the memo key of `resolve` stays the same.

### The flag

**Superseded in 2b.** The items below are the design before the build. "As built in 2b" and owner decision 4 replace them: no gate reads the flag, and the gate reads the run context, not the snapshot.

- `feature.internal.code_mode_read_path` is a hidden key, as `feature.internal.triage_sender_kind_projection` is. A missing row means off. It goes in the availability snapshot, as `passthroughEnabled` does, and dispatch checks it again.
- When the flag is on, chat adds `system.code_run` to the active tools at the start of the run. The kernel does not change, so the schema-budget ratchet does not change. The prompt is pinned for each run, so code.run guidance is added at run start (ADR-0124 decision 7).
- One gate removes the read tools from the boss surface: `evaluateToolAvailability`. Preload, carryover, `search_tools`, `load_tool`, the inactive-tool reissue, and dispatch all use that evaluator. When the flag is on, a `codeModeRead` tool is not available to the boss outside a script. A direct `mcp.call` from the boss to a read-only tool is refused with "use system.code_run". `search_tools` returns a read-only MCP hit as a ref for `mcp.read`. A host dispatch runs with a `code_run` run context, so the same gate lets the read through.

**As built in 2b (2026-11-17).** The gate reads the run context, not the snapshot. `ToolRunContext.readPath` is absent (direct reads), `code_run`, or `code_run_host`. The gate is in `evaluateToolRunContext`, which `evaluateToolAvailability` calls first. These facts from the code made the choice:

- The model surface (`resolveToolSurface`) checks only the run-context gates. Four read tools are on the kernel: `read_chat_history`, `read_user_context`, `web_search`, and `search_context`. A snapshot gate does not remove them from the surface.
- ADR-0124 decision 1 is for chat. A background workflow and a sub-agent never get `system.code_run`. A snapshot gate removes their reads, so they have no read path. Only chat sets `readPath: "code_run"`. Each other run keeps its direct reads, and `system.code_run` is `not_allowed` there.
- Chat pins the read path in run state on the first turn (`ChatRunState.readPath`), with the prompt. A run that pinned its prompt before this change stays direct. No gate reads the live flag (owner decision 4).
- The connected summary computes its tool lines through the same gate. In a `code_run` run it uses the direct view of the run, so the read tools stay on the list. Its header and the MCP lines then say where a read runs, and an MCP line says when each call of the server waits for approval.
- `dispatchHostRead` sets `readPath: "code_run_host"`.
- The surface memo key serializes the context object. A `satisfies Record<keyof ToolRunContext, string>` makes a new field fail to compile until the object holds it, and the key serializes the object, so the key holds each field of the object. The first version wrote the key by hand, and a probe showed that a new field could compile and still be absent from the key.

**Changes from the review of #1776 (2026-11-17).** The flag stays off. Each change below closes one finding:

- **The read route (owner decision 5).** The static gate (`evaluateReadPath`) hides only a read that can never wait for approval (`toolCanWaitForApproval`: a `fast_path` or `join` tool, or a `system` tool with no `high` or dynamic tier). Dispatch decides each other read: `refuseScriptableDirectRead` runs after the call's own `requiresApproval`, so the route and the gate cannot disagree. A bound call says whether it reads (`BoundToolCall.isRead`: `codeModeRead`, or the `selectsRead` hook, which only `mcp.call` declares). Discovery routes each read hit with the same rule, from one identity read for each MCP hit (`resolveMcpCallRiskAndRead`). Preload skips the Code Mode reads in a `code_run` run.
- **Replay binds the exact request.** A nested read's id is `<toolCallId>#<hash of tool and input>.<occurrence>`, not `run`'s request order. A restart can give one position to a different read, so the order is not stable. A saved row of a script read must also hold the same input hash, or dispatch throws.
- **The broker enforces the read.** A script read reaches the broker with `requireRead`. The broker refuses it unless the live descriptor and review still make it a read (`isReadOnlyMcpToolIdentity`), the same rule as the host check. The approval tier stays a separate decision.
- **The finalize guard.** A refused direct read carries `verifiedRead` to the chat tool log, so the guard does not count it as a failed write.
- **The chat trail.** A script that did not complete logs as `failed`. The host collects the citations of each `system.web_search` and `system.fetch_url` read into `CodeRunResult.citations`, so the sources strip shows them.
- **Parallel reads.** `run` ends the whole script at its in-flight limit, and a guest `catch` cannot stop it. So `run`'s in-flight limit equals the total, and the host queues reads, 8 at a time. Each `RUN_BRIDGE_LIMIT` maps to the limit that its `details` names.

**Before owner enablement (follow-up PR).** These findings of the review stay open, and the flag stays off until they close:

- The eval must run the production surface resolution and dispatch with fake provider responses (ADR-0055 decision 2). Today it copies the summary and the envelope and supplies its own surface.
- The benchmark must compare both modes on the same captured descriptor and representative results. GitHub's `list_issues` includes bodies by default, so the 41-read fixture is not fair. Score the substance of each gist, and measure end-to-end latency.
- Budget the effective first-turn surface. The full read index ships on each flagged turn (about 3,149 to 5,096 schema tokens). The 3,300-token check measures only the static kernel.
- The two checks of #535: the sandbox smoke on Railway's own container, and the fork-or-not decision.
- A browsing card for each web read of a script. The trail shows one `system.code_run` card.

**The second review of #1776 (2026-11-17).** It hit the rethink trigger: this is the third patch of the read route, and each round opened more work than it closed. Three findings are fixed in #1776:

- When `run` returns, the host queue closes. A read that waits in the queue does not start, and the outcome keeps a copy of the ledger.
- The input check of a script-read replay normalizes the keys first, the same as a fresh call.
- The plan no longer gives the pre-2b instructions for the id, the approval thread, the flag gate, or the script-read share.

**Open: the read-route theory.** These findings wait for the owner. No more route code is written until the theory is settled:

- One route decision for each read call, in the tool runtime. Its inputs are the effect authority, the output kind, and the approval. Discovery quotes it, dispatch and the broker enforce it, and the connected summary does not state a live policy. Today discovery, the registry, and dispatch each hold a copy, and they disagree on `fast_path` reads (`mcp.list_tools`, `mcp.inspect_tool`).
- The read authority of an MCP tool. Today a `readOnlyHint` with no review that says otherwise is enough. A custom server can set the hint on a write. A pinned built-in, or an exact read policy, is independent authority.
- The binary route (ADR-0124 decision 4). No route input says that a result is binary. Drive's pinned `download_file_content` returns base64 bytes, and it now goes to a script.
- The sources of a script: a bounded field with whole URLs, kept for a failed script too.
- The evidence record of each host read (function, arguments, and the ids read), for the memory check job (memory.md).
- The default: every chat read in a script, or only fan-out. The single-read and Gated costs are not measured. The eval of the follow-up PR measures them.

### The honest envelope and the ledger

`runReadProgram` is the deep module: it receives the source, the host functions, and the limits, and it returns the outcome and the ledger. It catches each `RunError` and maps its code to one outcome. The model sees this:

- `completed`: the value, plus `calls: { total, failed }`.
- `script_error` for `RUN_USER_SOURCE_ERROR`. The message says "an uncaught error, or the 64 MiB memory limit", because the code cannot show which of the two occurred.
- `timeout` and `cpu_timeout`, each with its limit.
- `too_many_calls` for `RUN_BRIDGE_LIMIT`, and `source_too_large`.
- `busy` for `RUN_CONCURRENCY_LIMIT`, with the instruction to try again one time.
- `unawaited_call` for `RUN_DETACHED_BRIDGE_REQUEST`.
- `internal` for `RUN_PROTOCOL_ERROR`, `RUN_HOST_FUNCTION_ERROR`, and `RUN_ABORTED`. These are logged with the run id.

A host call that does not execute throws a guest error. Its `code` is the refusal, for example `needs_approval`, `failed`, or `invalid_input`, and its message is the public message. The ledger is kept on the host side: `{ index, path, kind, ms }`. The script cannot change it.

Facts measured on `run@2.1.13` while building 2a (2026-11-17):

- **Only a thrown `RunError` reaches the guest with its message and `code`.** A plain `Error` arrives as "Host function failed.". Thus a refused read throws `RunError(message, refusal)`.
- **A refused read that the script does not catch fails the run with the host's own code.** It does not fail with `RUN_HOST_FUNCTION_ERROR`. `run` mints only `RUN_*` codes, so any other code maps to `uncaught_read_failure`.
- **A result that is too large or is not serializable fails with `RUN_SERIALIZATION_ERROR`.** That code is not in the list above. It maps to `result_too_large_or_not_json`.
- **The read path has its own limits.** The result cap is 64 KiB, not 1 MiB, because only the return value reaches the model, and `boundToolResult` clips strings but not the total size. The wall clock is 90 s, under the 180 s turn ceiling, and at most 8 reads run at the same time.

### Instrumentation (ADR-0124's three rows)

- **The share of chat reads that ran in a script.** Each host call already gets its own `tool:<name>` span. A host call's `toolCallId` has the `#` form. Count only the reads that can run in a script: the reads that did not wait for a card. A Langfuse query divides their host-call spans by all their spans. When the flag is on, dispatch refuses a direct call of such a read, so this share must be 100%. A lower share shows a leak. A direct read that showed a card is correct (owner decision 5), and it is not in the count.
- **The script success rate and the failed calls in scripts that returned.** These are metadata on the `tool:system.code_run` span: `outcome`, `hostCalls`, `hostCallsFailed`, and counts for each tool.
- **The model steps and the context tokens of each turn.** These are recorded already. `runtime.turn.phases.turns` holds the steps. The `api_call_log.input_tokens` of each row, grouped by `run_id`, holds the context of each step. Nothing new is built.

### Split into PRs

- **2a.** `runReadProgram`, the honest envelope, the ledger, the nested-dispatch seam, `codeModeRead`, `mcp.read`, `system.code_run`, the guest types, and the index generator with its gate. The flag and the span metadata are in 2a too, but the boss surface does not change yet.
- **2b.** The flip: chat adds `code_run`, the availability gate, the `search_tools` refs, and the prompt guidance. Also the eval case for `run_s7yi1ymxakcj`, with fake host functions (#898).

**2b eval receipt (2026-11-17).** `packages/assistant/evals/code-mode-read.eval.ts` runs the chat model with the `code_run` prompt and the real `system.code_run` description. Its scripts run in `run` against fake host functions. No trace of the 2026-11-08 run is captured, so the fixtures are synthetic: 41 open issues, a list with no bodies, and one `issue_read` for each body. One run on `gpt-6-luna` gave these results:

| Scorer                      | Result              | Prod run        |
| --------------------------- | ------------------- | --------------- |
| Every read runs in a script | pass (8 of 8 calls) | —               |
| At most 4 model steps       | fail: 9 steps       | 43 steps        |
| Peak context under 20k      | fail: 23,000 tokens | about 48k       |
| Bodies read in scripts      | 41 of 41            | 41 direct calls |
| The answer names each issue | 41 of 41            | —               |

The misses come from the scripts, not the path. Discovery used six scripts with one read each (`list_tools`, `inspect_tool`, `search_context`, `read_user_context`, `list_issues`, `inspect_tool`). One script returned the full bodies and failed on the 64 KiB cap. The next script returned the bodies under the cap, and that step held the peak. The prompt was not tuned to this run.

## Build order

1. **Handle substrate** — auto-park at the bound; R2 blob + PG metadata row (thread-scoped, TTL); `{handle,preview,schema,rowCount,provenance}` in the transcript; schema inferred by sampling parked rows.
2. **Read-only `code.run`** — `run()` behind `system.code_run`, with host functions `load(handle)` (paged cursor) + `broker.read` (facade over `packages/assistant/src/tool-runtime/internal/tools/passthrough/`); `limits` caps from the table above; over-bound return re-parks; forced provenance from the **host-side load ledger** (guest code cannot forge it) + the eval bundle below (#898), written in the same slice as the host functions.
3. **Plan-then-apply writes** — `broker.write` calls `getHostFunctionContext().interrupt(payload)` **before** any non-idempotent work, and uses `resume.interruptionId` as its idempotency key, because an interrupted host function is reinvoked on resume. Use `createStoredContinuationCodec()` (at-most-once, storage-claimed), not the signed codec: a signed continuation is a replayable bearer token whose payload is base64-encoded but **not encrypted**. Bind `continuationContext` to user, thread, and policy version. Keep the drift-guard on write targets; the ledger detects code divergence, not entity change. Authorize the actor who submits each resolution; a valid continuation proves integrity and scope, and grants no approval.
4. **Telemetry + graduation** — code-run runs/aborts/escape-attempt counters alongside the truncation thermometer.

## Evals — deterministic trajectory scorers (added 2026-08-26, #898)

**Why this rung changes the eval lane.** All nine `evalite` suites in `packages/assistant/evals/` expose the real tool with **no `execute`**, halt on the first tool call, and assert the argument shape (`calendar-grounding.eval.ts` is the clearest case). They grade **one step**. Every multi-step question therefore goes to an LLM judge — `boss-judgment.eval.ts` pays a stronger model to decide whether the boss over-searched — against the lane's own deterministic-scorer-first rule in `packages/assistant/evals/README.md`.

`code.run` removes the cost that forced that trade. A multi-step plan becomes **one program**, and every capability it can reach is a host function Alfred wrote. So a suite supplies fake host functions and executes the whole trajectory offline: no network, no test database, no HTTP mock, and the same fixtures serve the eval and the unit test. Guest `Date`, `Date.now()`, and `Math.random()` stay deterministic across replay, so a case is reproducible.

Four scorers, all exact:

| Scorer            | Asserts                                                                                                                                                                                                                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Return value      | The program's returned value against a gold value. The lane's **first** end-state assertion; every suite today asserts an argument shape instead.                                                                                                                                                         |
| Call ledger       | Required call present; forbidden call absent (`gmail.send` on a read-only task); call count under a ceiling (the deterministic replacement for the judged over-search question); call order. `getHostFunctionContext()` supplies `hostFunctionName` and `requestIndex`, so the recorder needs no wrapper. |
| Approval + replay | `interrupt()` then resume shows `broker.write` paused **before** it mutated, and that resume read completed reads from the ledger instead of calling them again. First test of build-order step 3's obligations.                                                                                          |
| Provenance        | Forced provenance on the return against the host-side load ledger. Exact, because Alfred owns the ledger and guest code cannot forge it.                                                                                                                                                                  |

**Honest limit.** These scorers grade the code tier. The production boss calls tools directly, so **no suite that runs today gets better.** They are a reason to build the eval bundle in the same slice as the host functions, and not a reason to build them before the tier exists. They do not move the evidence gate below.

## Open verification (before build)

Two checks remain. The rest of the old Phase 0 died with `isolated-vm`.

- **Production-image smoke test.** The probe matrix now lives in `apps/server/src/scripts/probes/probe-code-mode-sandbox.ts` (a tsdown bundle entry, no DB, no network). The local half ran 2026-11-17 on `run@2.1.13` with **10/10 PASS** (baseline, async host functions, guest catch, guest TS, wall/CPU timeout, memory limit, console flood, guest crash, bridge cap, concurrency). The image half ran the same day as a **local railpack replica** — `node:26.13.1`, pnpm 11.26.0, the exact build command `pnpm install --frozen-lockfile && pnpm turbo run build --filter=server`, the bundled `dist/scripts/probes/probe-code-mode-sandbox.js`, under a 1 GiB memory cap — with **10/10 PASS**. The Railway container itself was not used: `railway ssh` failed server-side ("Your application is not running or in an unexpected state") while the deployed app answered `/health` 200, so the image check is a replica, not Railway's own container. The real-image run rides on the next `railway ssh` that works.
- **Fork-or-not decision.** The worker thread shares the credential-holding process. Decide from the owner experiment whether to wrap the `run()` call in a `child_process.fork()`. Record the answer either way.

**Unchanged:** the evidence gate. The rung-(a) truncation thermometer has still not fired. A cheaper sandbox lowers the cost of this experiment; it does not create the need.
