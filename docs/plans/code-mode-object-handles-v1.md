# Code Mode / Object Handles — rung-(b) v1

**Status:** Designed (grilled 2026-07-21). Decision record: ADR-0087 (extends ADR-0074 rung-(b)). Epic: #271.

## One-line

Keep large tool results out of the transcript by **parking them as object handles**, and let the boss compute derived results over a handle by writing **JS/TS run in a network-less, credential-less self-hosted isolate** whose only capabilities are host functions.

## Framing (what this is NOT)

This is *not* the "do anything in the API" / composition / BYO-MCP tier the ADR-0074 title imagines. The grill established (with receipts) that those drivers are dead or unproven:

- **Token cost of many tool defs** — already solved by the lazy tool surface (#405/#411/#412/#414; kernel = 8 tools, ratchet-guarded by `packages/api/test/agent/schema-budget.test.ts`).
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
| Substrate | Self-hosted **`isolated-vm`** V8 isolate in a **forked worker**, IPC bridge to main process |
| Network | **Isolate has zero network** |
| Capabilities | **Host functions only**: `load(handle)` (paged cursor), `broker.read` (facade over rung-a), `broker.write` |
| Credentials | Never in the isolate; main API process is the only holder |
| Isolate host | **Forked worker process** (V8 escape ≠ cred-process compromise) |
| Writes | **Plan-then-apply** (dry-run → approve → apply) |
| Replay | **Hash code + inputs** (approved plan cached under hash) |
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

## Build order

1. **Handle substrate** — auto-park at the bound; R2 blob + PG metadata row (thread-scoped, TTL); `{handle,preview,schema,rowCount,provenance}` in the transcript; schema inferred by sampling parked rows.
2. **Read-only `code.run`** — forked-worker `isolated-vm`, IPC bridge, host functions `load(handle)` (paged cursor) + `broker.read` (facade over `packages/api/src/modules/tools/passthrough/`); isolate memory cap + wall-clock timeout; over-bound return re-parks; forced provenance + behavioral eval.
3. **Plan-then-apply writes** — `broker.write` dry-run/apply; hash code+inputs; drift-guard on write targets.
4. **Telemetry + graduation** — code-run runs/aborts/escape-attempt counters alongside the truncation thermometer.

## Open verification (before build)

- Confirm `isolated-vm` async host-function bridging pattern (`Reference` / `applySyncPromise`) against a paged `load` that awaits R2 + vendor I/O in the trusted process.
- Confirm the forked-worker lifecycle + IPC bridge shape fits the existing agent runtime (Vercel AI SDK tool execution, durable-resume checkpoints).
- Decide isolate resource caps (memory / timeout) empirically against a realistic parked payload.
