# Code Mode / Object Handles — rung-(b) v1

**Status:** Designed (grilled 2026-07-21). **Substrate amended 2026-08-19, and again 2026-08-26** — see [Substrate](#substrate-amended-2026-08-19-dependency-narrowed-2026-08-26). Decision record: ADR-0087 (extends ADR-0074 rung-(b)). Epic: #271. Issues: #535 (build), #898 (trajectory scorers).

## One-line

Keep large tool results out of the transcript by **parking them as object handles**, and let the boss compute derived results over a handle by writing **JS/TS run in a network-less, credential-less self-hosted sandbox** whose only capabilities are host functions.

## Framing (what this is NOT)

This is _not_ the "do anything in the API" / composition / BYO-MCP tier the ADR-0074 title imagines. The grill established (with receipts) that those drivers are dead or unproven:

- **Token cost of many tool defs** — already solved by the lazy tool surface (#405/#411/#412/#414; kernel = 8 tools, ratchet-guarded by `packages/assistant/test/tool-runtime/schema-budget.test.ts`).
- **Multi-step composition latency** — unmeasured/speculative; the one profiled case (`docs/plans/chat-latency-and-github-tools.md`) was a DB-orchestration bug, and the real fan-out need was fixed by _curation_ (`github.search`).
- **BYO-MCP** — owner instinct, zero user demand at n=1.

The **only** live justification is **context virtualization** (the L0 sketch in `docs/plans/context-working-set-considered.md`), and its evidence gate — the rung-(a) truncation thermometer — **has not fired**. So v1 is a deliberate **experiment built ahead of proven need**. If the isolate cost outruns the need, the honest off-ramp is a bounded `read_object(handle, jsonpath, page)` peek path with no isolate at all (rejected by the owner for v1, kept on record).

## Locked decisions (from the grill)

| Axis            | Decision                                                                                                                                                                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Driver          | Context virtualization only                                                                                                                                                                                                                                                                                               |
| Park trigger    | **Auto** at the existing rung-(a) bound (>32 KiB / >50 items / >8 000-char string)                                                                                                                                                                                                                                        |
| Handle payload  | `{ handle, preview, schema, rowCount, provenance }` in the transcript                                                                                                                                                                                                                                                     |
| Storage         | R2 blob + Postgres metadata row, **thread-scoped + TTL**                                                                                                                                                                                                                                                                  |
| Query interface | **`code.run(source)` only** (no DSL, no non-code peek)                                                                                                                                                                                                                                                                    |
| Language        | JS/TS                                                                                                                                                                                                                                                                                                                     |
| Substrate       | ~~Self-hosted `isolated-vm` V8 isolate in a forked worker, IPC bridge to main process~~ → ~~`experimental_runCodeMode` from `@ai-sdk/code-mode`~~ → **`run` from `vercel-labs`, called directly** — an embedded QuickJS WebAssembly module in a `node:worker_threads` worker (2026-08-19; dependency narrowed 2026-08-26) |
| Network         | **Sandbox has zero network** — now structural: the guest owns no network API at all                                                                                                                                                                                                                                       |
| Capabilities    | **Host functions only**: `load(handle)` (paged cursor), `broker.read` (facade over rung-a), `broker.write`. This is `run`'s native `hostFunctions` model, and async host functions are supported.                                                                                                                         |
| Credentials     | Never in the isolate; main API process is the only holder                                                                                                                                                                                                                                                                 |
| Sandbox host    | ~~Forked worker process~~ → **worker thread in the API process** (2026-08-19). Guest JS runs in QuickJS _inside_ WebAssembly, so an escape needs a QuickJS bug **and** a WASM-sandbox escape. A `child_process.fork()` wrapper stays available as cheap hardening.                                                        |
| Writes          | **Plan-then-apply** (dry-run → approve → apply)                                                                                                                                                                                                                                                                           |
| Replay          | ~~Hash code + inputs~~ → **`run` signed continuations with a replay ledger** (2026-08-19): replay verifies transformed source, host-function-name manifest, and the complete serialized argument list, and rejects divergence before a mismatched host function runs                                                      |
| Write TOCTOU    | **Drift-guard write targets** — re-read only mutated entities at apply, abort on drift                                                                                                                                                                                                                                    |
| Honesty         | **Forced provenance** on returns (which reads fed it / errored / emptied); behavioral eval **plus four deterministic trajectory scorers** (#898, added 2026-08-26)                                                                                                                                                        |
| Return bound    | Over-bound return **re-parks recursively** as a new handle                                                                                                                                                                                                                                                                |
| Gating          | **On-by-default** for the single user (data stays in-house); graduation gated on code-run telemetry + thermometer                                                                                                                                                                                                         |

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

`run` from `vercel-labs` (Apache-2.0, **zero runtime dependencies, zero peer dependencies**, `engines: node >= 22.13.0`), called directly. Pin it **exactly**; `2.0.1` at the time of writing. `run` embeds a **1,027,523-byte QuickJS WebAssembly module** (built by `quickjs-emscripten` 0.32.0 / `@jitl/quickjs-wasmfile-release-asyncify`; the decoded bytes start with the WASM magic `00 61 73 6d`) and starts it in a `node:worker_threads` `Worker` created from a `data:text/javascript` URL with `execArgv: []`. Receipts from the published `2.0.1` tarball:

```
run@2.0.1  dist/runtime/manager.js:4     import { Worker } from "node:worker_threads";
run@2.0.1  dist/runtime/worker-source.js const INLINE_RUN_WORKER_SOURCE = "globalThis.__RUN_QUICKJS_WASM_BASE64__ = \"AGFzbQEAAAA…"
run@2.0.1  node: builtins, whole dist    buffer, crypto, worker_threads, async_hooks, util, os, module, fs, events
```

**This is a library, not a hosted service.** A probe of the tarball found no `node:vm`, no `isolated-vm`, and no `node:http` / `node:net` / `node:dns` / `node:tls` client anywhere in the distributed JavaScript. Nothing leaves the Alfred process, so the Freestyle.sh data-custody rejection does not extend to it.

`github.com/vercel-labs/run` is **public** since the 2026-08-25 announcement, so review the source in the repository rather than in the published sourcemaps.

### Integration shape

Call `run()` (or `createRunner().run()` to share limits) from **inside Alfred's own `system.code_run` tool**. Alfred keeps the dispatcher, the read gate, the tool cards, the schema budget, and the honest envelope.

Do **not** add `@ai-sdk/code-mode`. Its `experimental_codeModeTool()` + `experimental_toolCallers` path hands tool routing to the AI SDK, bypasses Alfred's gate and card surface, and the AI SDK documents that approval flows do not work through nested tool calls. Its `experimental_runCodeMode` path only converts AI SDK tools into host functions, which Alfred does not need — and it drags in an **exact** `ai` peer pin (`1.0.36` ↔ `7.0.79`) for that indirection.

The public surface is stable: a probe found **zero** `experimental_` identifiers in `run@2.0.1`. The exports are `run`, `createRunner`, `getHostFunctionContext`, `isRunInterruptedResult`, `setMaxWorkers`, `createSignedContinuationCodec`, `createStoredContinuationCodec`, and nine `RunError` subclasses.

### Limits (documented, overridable per run or per `createRunner()` through `limits`)

| Limit                                     | Default |
| ----------------------------------------- | ------- |
| Timeout                                   | 30 s    |
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

Failures **throw** rather than returning a status. `RunResult` is only `{ status: 'completed', value }` or `{ status: 'interrupted', interruptions, continuation }`; everything else raises a `RunError` subclass with a stable `code` (`RUN_TIMEOUT`, `RUN_ABORTED`, `RUN_CONCURRENCY_LIMIT`, `RUN_PROTOCOL_ERROR`, `RUN_HOST_FUNCTION_ERROR`, `RUN_BRIDGE_LIMIT`, `RUN_SOURCE_TOO_LARGE`, `RUN_DETACHED_BRIDGE_REQUEST`). Alfred's honest envelope maps each of those to a user-visible outcome; do not let one fall through to a generic message.

Values cross the boundary in `run`'s versioned `run-js-v1` format, which carries primitives, plain objects, arrays, cycles, `Date`, `RegExp`, `Map`, `Set`, typed arrays, and `Error`. Functions, symbols, promises, and class instances **cannot** cross, so a parked page must reach the guest as plain data — which it already does.

### Version pinning rule

Pin `run` **exactly** and re-review the source on each bump; it is a `vercel-labs` package at major version 2 with a young changelog. It declares no peer dependencies, so it constrains no other catalog entry.

Two facts kept from the superseded `@ai-sdk/code-mode` rule, because they still describe this workspace. The `ai` catalog pin is `7.0.66` and is now a **free** choice — nothing in this plan requires a specific `ai` release. And one measured pnpm trap remains true for any deliberate bump: `minimumReleaseAgeExclude` is honored while pnpm **resolves**, but not while it **verifies an existing lockfile**, so a too-new transitive package blocks every later `pnpm install` even with an exclude entry present. Bumping straight to `ai@7.0.68` pulled `@ai-sdk/gateway@4.0.54` (published the same hour) and wedged install; `7.0.66` pulls `@ai-sdk/gateway@4.0.52` and installs clean.

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

- **Production-image smoke test.** Run one `run()` call on the Railway image and confirm the worker thread starts, the WebAssembly module instantiates, and a timeout, an out-of-memory run, an output flood, and a crash each terminate the run and leave the API healthy.
- **Fork-or-not decision.** The worker thread shares the credential-holding process. Decide from the owner experiment whether to wrap the `run()` call in a `child_process.fork()`. Record the answer either way.

**Unchanged:** the evidence gate. The rung-(a) truncation thermometer has still not fired. A cheaper sandbox lowers the cost of this experiment; it does not create the need.
