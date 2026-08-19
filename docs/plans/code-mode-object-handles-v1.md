# Code Mode / Object Handles — rung-(b) v1

**Status:** Designed (grilled 2026-07-21). **Substrate amended 2026-08-19** — see [Substrate](#substrate-amended-2026-08-19). Decision record: ADR-0087 (extends ADR-0074 rung-(b)). Epic: #271. Issue: #535.

## One-line

Keep large tool results out of the transcript by **parking them as object handles**, and let the boss compute derived results over a handle by writing **JS/TS run in a network-less, credential-less self-hosted sandbox** whose only capabilities are host functions.

## Framing (what this is NOT)

This is *not* the "do anything in the API" / composition / BYO-MCP tier the ADR-0074 title imagines. The grill established (with receipts) that those drivers are dead or unproven:

- **Token cost of many tool defs** — already solved by the lazy tool surface (#405/#411/#412/#414; kernel = 8 tools, ratchet-guarded by `packages/assistant/test/tool-runtime/schema-budget.test.ts`).
- **Multi-step composition latency** — unmeasured/speculative; the one profiled case (`docs/plans/chat-latency-and-github-tools.md`) was a DB-orchestration bug, and the real fan-out need was fixed by *curation* (`github.search`).
- **BYO-MCP** — owner instinct, zero user demand at n=1.

The **only** live justification is **context virtualization** (the L0 sketch in `docs/plans/context-working-set-considered.md`), and its evidence gate — the rung-(a) truncation thermometer — **has not fired**. So v1 is a deliberate **experiment built ahead of proven need**. If the isolate cost outruns the need, the honest off-ramp is a bounded `read_object(handle, jsonpath, page)` peek path with no isolate at all (rejected by the owner for v1, kept on record).

## Locked decisions (from the grill)

| Axis | Decision |
|---|---|
| Driver | Context virtualization only |
| Park trigger | **Auto** at the existing rung-(a) bound (>32 KiB / >50 items / >8 000-char string) |
| Handle payload | `{ handle, preview, schema, rowCount, provenance }` in the transcript |
| Storage | R2 blob + Postgres metadata row, **thread-scoped + TTL** |
| Query interface | **`code.run(source)` only** (no DSL, no non-code peek) |
| Language | JS/TS |
| Substrate | ~~Self-hosted `isolated-vm` V8 isolate in a forked worker, IPC bridge to main process~~ → **`experimental_runCodeMode` from `@ai-sdk/code-mode`, over an embedded QuickJS WebAssembly module in a `node:worker_threads` worker** (2026-08-19) |
| Network | **Sandbox has zero network** — now structural: the guest owns no network API at all |
| Capabilities | **Host functions only**: `load(handle)` (paged cursor), `broker.read` (facade over rung-a), `broker.write`. This is `run`'s native `hostFunctions` model, and async host functions are supported. |
| Credentials | Never in the isolate; main API process is the only holder |
| Sandbox host | ~~Forked worker process~~ → **worker thread in the API process** (2026-08-19). Guest JS runs in QuickJS *inside* WebAssembly, so an escape needs a QuickJS bug **and** a WASM-sandbox escape. A `child_process.fork()` wrapper stays available as cheap hardening. |
| Writes | **Plan-then-apply** (dry-run → approve → apply) |
| Replay | ~~Hash code + inputs~~ → **`run` signed continuations with a replay ledger** (2026-08-19): replay verifies transformed source, host-function-name manifest, and the complete serialized argument list, and rejects divergence before a mismatched host function runs |
| Write TOCTOU | **Drift-guard write targets** — re-read only mutated entities at apply, abort on drift |
| Honesty | **Forced provenance** on returns (which reads fed it / errored / emptied); behavioral eval |
| Return bound | Over-bound return **re-parks recursively** as a new handle |
| Gating | **On-by-default** for the single user (data stays in-house); graduation gated on code-run telemetry + thermometer |

## Residual risk (accepted, not covered by the isolate)

The no-network / no-credential isolate closes exfil **by the injected code itself** — it has nothing to send and nowhere to send it. It does **not** close the loop that code feeds: a `code.run` return re-enters the transcript, and the boss orchestrator retains egress through its **legitimate** tools (`gmail.send`, etc.). So `injection → broker.read private data → boss-steered send via a real tool` stays open. That is the **general agent-exfil problem**, unchanged by this rung — the isolate boundary is not what addresses it, and the forced-provenance return contract targets a *different* failure mode (laundering a structural confident-zero). Named here so "designed out rather than mitigated" is not misread as covering it.

## Superseded during the grill (do not carry forward)

- RPC-to-broker over the network → **host-injected capabilities over IPC**.
- Public broker + mTLS + per-run token → **internal host functions** (no public surface).
- Freestyle.sh SaaS substrate → **rejected on data custody** (third-party cloud, no VPC/self-host, would force a public cred-broker + route private reads through a V8 boundary with undocumented SOC 2/residency). Its pre-adoption verification to-dos are moot.
- Egress allowlist → **moot** (no network in the isolate at all).

## Superseded by the 2026-08-19 substrate amendment (do not carry forward)

- Hand-built **`isolated-vm`** isolate → `@ai-sdk/code-mode` over the embedded QuickJS WebAssembly module. The native build, the `tsdown` externalization, and `--no-node-snapshot` all go away with it.
- **Forked worker process + IPC bridge** → one worker thread that the package owns. Alfred writes no bridge protocol.
- **Hash code + inputs** for replay → signed continuations with a replay ledger.
- **Operating-system egress-denial proof** → moot. The guest has no network API, no timers, no `crypto`, no environment variables, no modules, no filesystem, and no dynamic evaluation; built-in prototypes are frozen.

## Substrate (amended 2026-08-19)

### What runs the code

`experimental_runCodeMode` from `@ai-sdk/code-mode`, which wraps `run@2.0.0` (`vercel-labs`, Apache-2.0, **zero runtime dependencies**). `run` embeds a **1,027,523-byte QuickJS WebAssembly module** (built by `quickjs-emscripten` 0.32.0; the decoded bytes start with the WASM magic `00 61 73 6d`) and starts it in a `node:worker_threads` `Worker` created from a `data:text/javascript` URL with `execArgv: []`. Receipts from the published tarball:

```
run@2.0.0  dist/runtime/manager.js:4      import { Worker } from "node:worker_threads";
run@2.0.0  dist/runtime/manager.js:1009   return new Worker(getInlineWorkerUrl(), { execArgv: [] });
run@2.0.0  dist/runtime/worker-source.js  globalThis.__RUN_QUICKJS_WASM_BASE64__ = "AGFzbQEAAAA…"
```

**This is a library, not a hosted service.** A probe of both tarballs found no `node:vm`, no `isolated-vm`, and no HTTP, socket, or DNS client in the host code. Nothing leaves the Alfred process, so the Freestyle.sh data-custody rejection does not extend to it.

### Integration shape

Call `experimental_runCodeMode` from **inside Alfred's own `system.code_run` tool**. Alfred keeps the dispatcher, the read gate, the tool cards, the schema budget, and the honest envelope.

Do **not** use `experimental_codeModeTool()` with the SDK's `experimental_toolCallers` option. That hands tool routing to the AI SDK, bypasses Alfred's gate and card surface, and the AI SDK documents that approval flows do not work through nested tool calls.

### Limits (documented, overridable per run through `executionPolicy`)

| Limit | Default |
|---|---|
| Timeout | 30 s |
| QuickJS memory | 64 MiB |
| QuickJS stack | 2 MiB |
| Source | 256 KiB |
| Result | 1 MiB |
| Console output | 64 KiB |
| Host-function arguments | 1 MiB |
| Host-function output or interrupt payload | 4 MiB |
| Bridge requests | 256 |
| Concurrent bridge requests | 32 |

The worker pool cap is process-wide, shared with any other `run` user in the process, and set through `experimental_setMaxWorkers`; excess invocations reject with `RunConcurrencyError` rather than queue without bound. Every run gets a fresh QuickJS context, and a worker that cannot reach a verified clean state after an abort, a timeout, or a protocol failure is retired.

### Version pinning rule

`@ai-sdk/code-mode` declares an **exact** `ai` peer, and the pair moves one-for-one per release: `1.0.22`↔`7.0.65`, `1.0.23`↔`7.0.66`, `1.0.24`↔`7.0.67`, `1.0.25`↔`7.0.68`. The AI SDK publishes several releases a day, so the newest pair is normally younger than pnpm's 24-hour release-age floor. **The floor wins.** The catalog now pins `ai: 7.0.66`, the newest pin that cleared the floor on the bump date and the exact peer of `@ai-sdk/code-mode@1.0.23`.

One trap, measured: `minimumReleaseAgeExclude` is honored while pnpm **resolves**, but not while it **verifies an existing lockfile**. A too-new transitive package therefore blocks every later `pnpm install` even with an exclude entry present. Bumping straight to `ai@7.0.68` pulled `@ai-sdk/gateway@4.0.54` (published the same hour) and wedged install; `7.0.66` pulls `@ai-sdk/gateway@4.0.52` and installs clean.

## Build order

1. **Handle substrate** — auto-park at the bound; R2 blob + PG metadata row (thread-scoped, TTL); `{handle,preview,schema,rowCount,provenance}` in the transcript; schema inferred by sampling parked rows.
2. **Read-only `code.run`** — `experimental_runCodeMode` behind `system.code_run`, with host functions `load(handle)` (paged cursor) + `broker.read` (facade over `packages/assistant/src/tool-runtime/internal/tools/passthrough/`); `executionPolicy` caps from the table above; over-bound return re-parks; forced provenance from the **host-side load ledger** (guest code cannot forge it) + behavioral eval.
3. **Plan-then-apply writes** — `broker.write` calls `getHostFunctionContext().interrupt(payload)` **before** any non-idempotent work, and uses `resume.interruptionId` as its idempotency key, because an interrupted host function is reinvoked on resume. Use `createStoredContinuationCodec()` (at-most-once, storage-claimed), not the signed codec: a signed continuation is a replayable bearer token whose payload is base64-encoded but **not encrypted**. Bind `continuationContext` to user, thread, and policy version. Keep the drift-guard on write targets; the ledger detects code divergence, not entity change. Authorize the actor who submits each resolution; a valid continuation proves integrity and scope, and grants no approval.
4. **Telemetry + graduation** — code-run runs/aborts/escape-attempt counters alongside the truncation thermometer.

## Open verification (before build)

Two checks remain. The rest of the old Phase 0 died with `isolated-vm`.

- **Production-image smoke test.** Run one `runCodeMode` call on the Railway image and confirm the worker thread starts, the WebAssembly module instantiates, and a timeout, an out-of-memory run, an output flood, and a crash each terminate the run and leave the API healthy.
- **Fork-or-not decision.** The worker thread shares the credential-holding process. Decide from the owner experiment whether to wrap `runCodeMode` in a `child_process.fork()`. Record the answer either way.

**Unchanged:** the evidence gate. The rung-(a) truncation thermometer has still not fired. A cheaper sandbox lowers the cost of this experiment; it does not create the need.
