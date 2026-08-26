# Code Mode — Phase 0 sandbox proof (issue #535 / ADR-0087)

> **SUPERSEDED 2026-08-19. Do not run this spike, and do not build on it.**
>
> Everything below describes a **Vercel Sandbox** (remote Firecracker microVM) substrate that
> ADR-0087 no longer uses. The substrate is now **`run` from `vercel-labs`**, called directly
> (dependency narrowed 2026-08-26): an embedded QuickJS WebAssembly module in a
> `node:worker_threads` worker, **inside** the Alfred process. Read
> [ADR-0087](../../../docs/decisions/ADR-0087-code-mode-rung-b-v1-is-context-virtualization.md)
> and [the plan](../../../docs/plans/code-mode-object-handles-v1.md) instead.
>
> **Why it died.** The pivot below accepted a data-custody reversal — private Gmail and GitHub
> reads leaving Alfred's infrastructure for Vercel/AWS `iad1`. It did so to buy
> operating-system-enforced egress denial, which an unprivileged Railway container cannot give.
> `run` makes that purchase unnecessary: the guest owns **no network API at all**, so "zero
> network" became structural instead of configured, and nothing leaves the process. This is
> verdict #4 of `docs/research/code-mode-sandbox-feasibility.md` (quickjs-emscripten is a
> stronger isolation story by construction) winning over the pivot to verdict #5, which that
> same document had already marked **NO-GO on custody**.
>
> **What replaced this acceptance matrix.** Two checks, both listed under "Open verification" in
> the plan: a production-image smoke test on Railway, and the fork-or-not decision. The probes
> below that still matter (timeout, out-of-memory, output flood, crash) are folded into that
> smoke test; `egress-denied` is moot, because there is no egress path to deny.
>
> The text below is kept as the record of a decision that was made and reversed. Every claim in
> it about the chosen substrate is **false as of 2026-08-19.**

---

This is the **blocking Phase 0 spike**: prove the execution substrate before any
product code. It is deliberately **outside the pnpm workspace** (`scripts/spikes/**`
is not matched by `pnpm-workspace.yaml`), so it never enters `pnpm check-types` on
a fresh tree and does not pull `@vercel/sandbox` into the monorepo install while
this is still an experiment.

## What changed from the original ADR (grilled 2026-07-23)

ADR-0087 locked a **local `isolated-vm` isolate on Railway** whose containment
rested on **OS/container-enforced outbound-network denial**. Primary-source
research (`docs/research/code-mode-sandbox-feasibility.md`) proved that claim is
**unattainable in an unprivileged Railway container** (no `CAP_NET_ADMIN`/
`CAP_SYS_ADMIN`, no privileged mode, no custom seccomp knob).

Decision: **move execution off Railway to Vercel Sandbox** (Firecracker microVM),
accepting the data-custody reversal that entails (private reads leave Alfred's
infra for Vercel/AWS `iad1`; SOC 2 Type II, ephemeral, region-pinned). Data-flow
model = **Option A**:

1. Sanitize + park the oversized result.
2. `writeFiles` it INTO the sandbox at creation.
3. Weld the door shut with `networkPolicy: 'deny-all'` (blocks **all** egress,
   including DNS — Vercel's own SDK docs describe this exact "gather data, then
   run untrusted code without exfiltration" pattern).
4. Run the model-authored JS over the local file; read a **bounded** result back.

Consequence worth noting: the **microVM itself is the isolation boundary**, so
model code runs as ordinary Node inside it — **no nested `isolated-vm`/quickjs,
no IPC host-function bridge, no paging cursor**. This is materially simpler than
the original design.

## Run it

Access-token auth (we are a non-Vercel host). Mint a Vercel access token with
team access, and grab your team + project IDs:

```bash
cd scripts/spikes/code-mode-sandbox
npm install
VERCEL_TOKEN=xxx VERCEL_TEAM_ID=team_xxx VERCEL_PROJECT_ID=prj_xxx npm run spike
```

## What it proves (Phase 0 acceptance matrix)

| Probe                       | Asserts                                                                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseline-compute`          | Option A works: 2,000-row parked handle written in, model JS derives a result, bounded stdout read back, `exit=0`. Records vCPU/memory/timeout. |
| `egress-denied`             | Under `deny-all`, both DNS resolution and `fetch()` **fail closed** — the welded door holds.                                                    |
| `crash-clean-exit`          | A throwing command surfaces a clean nonzero exit + stderr; parent unaffected.                                                                   |
| `output-flood-bounded`      | ~50 MB of stdout is capped at the parent read (64 KiB) — a flood can't OOM the API.                                                             |
| `memory-pressure-contained` | A memory hog (capped heap) returns control to the parent cleanly.                                                                               |
| `infinite-loop-terminates`  | `while(true){}` is force-stopped by the session `timeout`; the harness stays responsive (a parent-side guard proves no hang).                   |

Exit code `0` + all-`PASS` = **GO**. Any `FAIL` = **REVIEW** before building the
handle substrate (Phase 1).

## Not covered here (by design — later phases)

Auto-park at the truncation bound, the R2/Postgres handle store + TTL/GC, the
`system.code_run` tool + dispatch/approval wiring, forced provenance, and the
production-image (Railway → Vercel) integration are Phase 1+, gated on this
spike's GO.
