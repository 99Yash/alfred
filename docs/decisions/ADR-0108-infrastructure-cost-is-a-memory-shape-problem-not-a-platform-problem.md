# ADR-0108 — Infrastructure cost is a memory-shape problem, not a platform problem

**Status.** Accepted. Amends [ADR-0007](./ADR-0007-hosting-railway.md) (Hosting: Railway) and [ADR-0008](./ADR-0008-database-railway-managed-postgres-with-pgvector.md) (Database).

**Decision.** Keep Railway. Do **not** migrate to Cloudflare Workers, Containers, or a VPS for cost reasons. Reduce spend by shaping the server's resident memory, and treat the Railway Hobby $5 floor — not the per-resource rate — as the number to get under.

**Supersedes.** ADR-0007's pricing rationale, which predicted "~$10–20/mo total at personal scale". Measured spend is **$5.16–$9.01/mo** across the last three invoices (`in_1U7eAkCJ…` $5.16, `in_1UIswVCJ…` $6.17, `in_1TwPPGCJ…` $9.01). The prediction was pessimistic by roughly 2×, and the reason it was wrong is the point of this ADR: Hobby's $5 included-usage credit absorbs almost all of it.

---

## Why the Cloudflare migration was repeatedly deferred, and why that was correct

Migration to Cloudflare has come up at least five times. Each time it stalled on BullMQ and cron, and each deferral was recorded as unfinished work. It was not unfinished work. The deferral was the correct answer, reached for the wrong reason.

The stated blockers were real:

- **Cron.** Ten `upsertJobScheduler` repeatables (ADR-0007's "cron jobs" is five words hiding ten schedules). Cloudflare Workers Free allows **5 cron triggers per account**; Workers Paid allows 250.
- **BullMQ.** No Redis with blocking-read semantics. Cloudflare Queues is the substitute: 10k ops/day on Free, 1M ops/month on Paid.
- **Runtime.** `packages/extraction/src/extract-pdf.ts:147` calls `spawn(process.execPath, …)`, reached from a BullMQ worker (`gmail.media_ingest`, `media.enrich`) *and* from inside an agent run (`fetch_url`). Plus three native binaries already forced `external` in the prod bundle with a comment recording the crash each caused: `sharp`, `@firecrawl/pdf-inspector` (NAPI, disk-resolved `.node`), and jsdom-via-`isomorphic-dompurify`. Plus `pg` with a blocking `LISTEN` (`realtime/outbox-relay.ts:156`), and `@sentry/node` + OTel `context-async-hooks` that must initialize before every other import (`apps/server/src/index.ts:9`).

But those were not the binding constraint. **The binding constraint is that Cloudflare Workers Paid has a $5/month minimum, exactly like Railway Hobby.** You cannot spend less than $5 on either. A migration that moved the server to Workers and left Postgres and Redis in place would land at $5 + a database host, which is at or above today. The blockers were real; they were not what made the migration wrong.

## Measured cost, not estimated

Railway meters memory **by the second** ($0.00000386/GB-s), CPU by vCPU-second, volume by GB-second. Alfred's CPU sits at `<0.01 vCPU` on every service — effectively free. **Memory is the entire bill.**

`railway metrics --all --since 30d`, with rates applied:

| Resource        | Resident | $/mo  |
| --------------- | -------: | ----: |
| `server`        |  551 MB  | $5.51 |
| `web`           |   64 MB  | $0.64 |
| `Postgres`      |  231 MB  | $2.31 |
| `Redis-E37o`    |   17 MB  | $0.17 |
| Postgres volume | 1.17 GB  | $0.18 |
| Redis volume    | 151 MB   | $0.02 |
| **Usage total** |          | **$8.84** |

Billed: `max($5 Hobby minimum, usage)`. The last invoice was **$6.17**, with line items showing a single $5.00 subscription charge and all six metered lines at $0.00. Alfred was **$1.17 over the floor** on a quiet month, and daily server means ranged **$2.80–$13.48** across the same 30 days.

### The floor is the target, not zero

The optimization goal is **not** "$0 infrastructure". It is **total < $5**, because below $5 Railway bills the flat $5 and further reduction is invisible. Postgres ($2.31) + web ($0.64) + Redis ($0.17) = $3.12 of non-server spend, so the server must hold below ~$1.90/mo to reach the floor. That is roughly 0.19 GB resident — **probably not reachable while Postgres alone is $2.31**, which is why Postgres, not the server, is the second-order target once the server is fixed.

## The server's memory shape

30 days at 4-hour resolution (181 samples) is **bimodal, and the mean lies between the modes**:

| Statistic | Resident | $/mo  |
| --------- | -------: | ----: |
| min       | 0.200 GB | $2.00 |
| p25       | 0.255 GB | $2.55 |
| median    | 0.341 GB | $3.41 |
| p75       | 0.788 GB | $7.88 |
| p95       | 1.501 GB | $15.01 |
| max       | **4.083 GB** | $40.85 |
| mean      | 0.578 GB | $5.79 |

- **50% of samples sit under 0.35 GB** — the idle floor.
- **35% exceed 0.60 GB.**
- The worst sample, **4.083 GB on 2026-09-18T04:00Z**, is 20× the idle floor.

There is **no `NODE_OPTIONS` on the server start script** (`apps/server/package.json:9`) and no in-repo memory limit, so V8 sizes its heap against total RAM (8 GB) and has no reason to collect under 4 GB. Nothing OOMs; the process simply grows. Railway charges for every byte-second of that growth.

**Production runs every default.** Verified via `railway variables --service server`: `AGENT_WORKER_CONCURRENCY` unset → 8, `DB_POOL_MAX` unset → derived 20, `NODE_OPTIONS` unset. `derivePoolMax(8) = 8×2 + 4 = 20` (`packages/env/src/pool.ts:66`). Against a stated ceiling of **2 concurrent users**, concurrency 8 is ~4× the requirement, and it sizes the Postgres pool with it.

### Correction: the "04Z cron spike" reading was an artifact

An earlier pass concluded that memory peaks aligned with the cron schedules, because 4-hour sampling showed 04Z averaging 0.931 GB against 20Z at 0.266 GB. **That was wrong.** Railway's 4-hour sampling lands on only six UTC hours (00/04/08/12/16/20), so "mean by hour-of-day" from that data is a six-bucket artifact, not a daily profile. Re-measured at true 1-hour resolution over 7 days (169 samples), the curve is flat — 0.27–0.63 GB, with no 04Z cliff:

```
09Z  mean 0.596  max 1.247     ← genuinely busiest
13Z  mean 0.268  max 0.320
20Z  mean 0.290  max 0.340
```

The diurnal story is unproven. What *is* established is the idle floor (~0.25 GB) and the spike tail (1.5–4 GB). Diagnosing the spike trigger requires log correlation at 1-hour resolution around a spike; the 2026-09-18 window is no longer recoverable — `railway logs` retains ~24h (a `--since 14d` query returns 35 lines, all boot logs). **Open question, not a finding.**

## What to change

Two environment variables, no code:

1. **`AGENT_WORKER_CONCURRENCY=2`** — pool 20 → 8. For 2 users, 8 is still generous. `packages/env/src/pool.ts` exists precisely so an operator tunes one knob; `DB_POOL_MAX` needs no change.
2. **`NODE_OPTIONS=--max-old-space-size=1024`** — set *above* the observed working set, not at the spike. Alone this is the wrong trade (a 4 GB spike becomes an OOM); combined with #1 it gives V8 a reason to collect and holds resident memory near the floor.

Then measure the next invoice before touching anything else.

**Explicitly rejected as cost measures:** Cloudflare Workers ($5 floor, identical to Hobby); Cloudflare Containers (same $5 plan *plus* per-second container time — at that point a $5 VPS with the repo's own Docker Compose dominates, which ADR-0007 already rejected on ops-burden grounds); Neon (its free tier caps at 0.5 GB/project against 1.17 GB in use, and ADR-0008 already rejected it on per-second-compute billing); moving `web` to a static host (a $0.64/mo line, not worth a migration).

## What this does *not* claim

- The spike trigger is **unidentified**. The heap cap is prophylactic, not a fix for a known cause.
- No heap cap exists today, so there is no evidence about where 4 GB comes from — V8 heap, `pg` pool, in-flight agent runs, or a PDF child. `--max-old-space-size` bounds only the V8 heap and will not bound native allocations.
- The PDF extraction child is deliberately capped at 256 MB (`packages/extraction/src/extract-pdf.ts:94`) for its own reasons; a 1 GB parent cap has not been tested against it.
- Postgres at $2.31/mo is the largest remaining line and has no scale-to-zero on Railway. It is the next thing to attack, and it is not solved here.
- The 2-user ceiling is a stated expectation, not a measured one. If concurrent use grows, `AGENT_WORKER_CONCURRENCY` must move with it.

## Redis persistence

Alfred's Redis has `appendonly` and `save` both disabled. This is correct for its role — a pure BullMQ queue and cache with Postgres as the source of truth — and it is **not** load-bearing financially (17 MB, $0.17/mo).

The cost of the choice: with both off, **Redis loses all BullMQ state on restart** — delayed jobs, the ten job schedulers, and in-flight agent leases. Recovery paths exist and are the reason this is safe (`reconcileInflightInvocations` per ADR-0018, `clearPersistedJobSchedulers` when `scheduledJobsEnabled()` is false, lease reclaim past `STALE_RUN_LEASE_MS`). Recorded here so the next reader does not "helpfully" re-enable persistence, and so the trade is revisited if Redis restarts become routine rather than rare.

## Consequences

- Infrastructure cost is a **known, bounded** ~$5–9/mo, dominated by one number: server resident memory.
- The Cloudflare question is closed on cost grounds with the arithmetic recorded, so it stops recurring as unfinished work. It may reopen for non-cost reasons (Hobby's 48 vCPU ceiling, single developer seat) — in which case it is an architecture project and should be argued as one.
- The load-bearing cost surface is **model spend**, not infrastructure. Optimizing this ADR's numbers is worth single digits per month; that is the correct order of magnitude for a hobby project, and it is worth being explicit about that rather than re-litigating hosting every few months.
