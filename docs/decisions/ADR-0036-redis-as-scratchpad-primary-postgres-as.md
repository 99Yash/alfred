# ADR-0036 — Redis as scratchpad primary; Postgres as terminal snapshot

**Decision.** During a boss run, all scratchpad reads and writes go to Redis (`alfred:scratch:{runId}:{zone}.{path}` keys, 30-day TTL at insert). On terminal state — success, failure, or cancellation — the executor's terminal step copies the full Redis-side scratchpad into the `agent_run_context` table as per-key rows (one INSERT per key, idempotent via `ON CONFLICT (run_id, key) DO UPDATE`). Live writes pay Redis latency (~1ms on Railway's private network); audit/replay/cross-run queries hit Postgres. Mid-run Redis loss recovers via idempotent step re-execution per ADR-0014 — same shape as any other transient failure.

**Supersedes part of ADR-0016.** ADR-0016 said _"no Redis for this layer: at single-user scale, Postgres handles per-run K/V trivially."_ That was correct at decision time; m13's design pressure surfaced two issues: (a) sub-agent fan-out wants fast inter-agent reads for the boss's synthesis pass (Dimension's "sub-millisecond reads"), and (b) per-key Postgres writes cost a network round-trip per scratch op where Redis costs a fraction. ADR-0036 keeps ADR-0016's _pattern_ unchanged (namespaced scratchpad, boss-promotes-to-shared, single-writer-per-zone, no sub-sub-agents, sub-agents don't compact) and changes only the _store layer_.

**Why this composition.**

- **Speed where it matters.** Live inter-agent reads during a run hit Redis. The hot path — sub-agents writing findings + the boss reading them — runs at private-network latency.
- **Durability where it matters.** Audit queries ("everything Alice was mentioned in last week") hit Postgres. Cross-run reads use the same store the runtime checkpoints to. No "which store is canonical" ambiguity outside the run lifetime.
- **Composes with the durable runtime.** ADR-0014's idempotent steps are the recovery primitive for mid-run Redis loss. No new recovery semantics required — a lost scratch entry re-executes its producing step on the next executor wake.
- **Single source of truth at every moment.** During the run: Redis. After terminal step: Postgres. Clean transition.
- **No data migration cost.** `agent_run_context` schema is unchanged. m13 builds the Redis-primary path from day one; no parallel-write phase.

**Key shape.**

```
alfred:scratch:{runId}:shared.{path}             -- e.g. alfred:scratch:run_abc:shared.alice_email
alfred:scratch:{runId}:scratch.{subId}.{path}    -- e.g. alfred:scratch:run_abc:scratch.sub_a.findings
```

The `alfred:scratch:` prefix namespaces against the existing Redis use (BullMQ queues, ADR-0005 Pub/Sub, session-cache, ADR-0034's `policy-bust:u:{userId}` channel). Two distinct builders in `@alfred/contracts`, not one variadic helper — so call sites cannot accidentally target the wrong zone:

```ts
export const sharedKey = (runId: string, path: string) =>
  `alfred:scratch:${runId}:shared.${path}` as const;
export const subAgentKey = (runId: string, subId: string, path: string) =>
  `alfred:scratch:${runId}:scratch.${subId}.${path}` as const;
```

**Value envelope.**

```ts
export type ScratchEntry<T = unknown> = {
  value: T;
  zone: "shared" | "scratch";
  writtenBy: string; // 'boss' or `${subId}`
  writtenAt: number; // epoch ms
};
```

Stored as JSON-serialized via `SET key value EX 2592000`. The generic at the call site (`read_scratch<TFindings>(key)`) lets callers narrow the value type. Per-zone single-writer is enforced at the dispatcher (a child run's `write_scratch` tool can only target its own `scratch.{subId}.*` keys; the boss's tool only targets `shared.*`) — not at the type system.

**TTL: 30 days at insert.**

- Live runs can pause for HIL hours or days (ADR-0014's durable-resume); a short TTL would expire mid-pause.
- "Delete on terminal step" was rejected — terminal-step cleanup needs idempotency against crash-retry; not deleting at all sidesteps that class of bug entirely.
- 30 days > (longest realistic HIL pause + 7-day post-completion audit hot window) with margin.
- Memory pressure at single-user scale is a non-concern: hundreds of runs/day × kilobytes of scratch = single-digit MB total.

**Snapshot to Postgres at terminal step.**

Schema unchanged from ADR-0016:

```sql
agent_run_context
  run_id      text references agent_runs(id)
  key         text
  value       jsonb
  zone        text                -- 'shared' | 'scratch'
  written_by  text                -- 'boss' or '{sub_id}'
  written_at  timestamptz
  primary key (run_id, key)
```

Terminal-step semantics (pseudocode):

```ts
await db.transaction(async (tx) => {
  const keys = await redisClient.scan(`alfred:scratch:${runId}:*`);
  for (const key of keys) {
    const raw = await redisClient.get(key);
    if (!raw) continue;
    const entry: ScratchEntry = JSON.parse(raw);
    const subKey = key.replace(`alfred:scratch:${runId}:`, "");
    await tx
      .insert(agentRunContext)
      .values({
        runId,
        key: subKey,
        value: entry.value,
        zone: entry.zone,
        writtenBy: entry.writtenBy,
        writtenAt: new Date(entry.writtenAt),
      })
      .onConflictDoUpdate({
        target: [agentRunContext.runId, agentRunContext.key],
        set: { value: sql`excluded.value` /* etc */ },
      });
  }
});
```

`ON CONFLICT DO UPDATE` makes the snapshot idempotent against terminal-step retry (a crash between "scan Redis" and "transaction commit" replays cleanly).

**Atomicity.**

- Single-key writes are atomic by Redis semantics.
- Compound writes (a sub-agent writing `findings.x` and `summary` in one logical batch) are caller's responsibility — use MULTI/EXEC if atomicity matters. Most cases are single-key.
- `promote(scratchKey)` (ADR-0016's primitive — copy `scratch.{subId}.foo` to `shared.foo`) is implemented as read-then-write; not atomic. Single-writer-per-zone (only the boss writes `shared.*`, only `sub_a` writes `scratch.sub_a.*`) makes this race-free in practice.

**Failure modes.**

- **Redis unavailable** → scratchpad ops throw `RedisUnavailableError` → step fails → durable-resume retries on the next executor wake. Same shape as Postgres-down.
- **Network partition** → same as Redis-down.
- **Stale Redis reads** → not possible under our access pattern (single-writer per zone enforced at the dispatcher).
- **Terminal-step snapshot fails** → the run's terminal state is still set, but the Postgres mirror is incomplete; a follow-up `snapshot-retry` sub-step re-attempts on the next executor wake. Pure idempotent retry; no impact on user-facing state.

No circuit breakers, no fallbacks. Redis is a hard dependency at the same level as Postgres.

**Migration.**

- No data migration. `agent_run_context` schema is unchanged.
- Existing builtin workflows (m9/m10/m11) don't write to the scratchpad — they're explicit-DAG step workflows, not boss-agent runs.
- m13 builds the Redis-primary path from day one; no dual-write phase.

**Alternatives.**

- (a) **Pure ephemeral (Redis only, no Postgres mirror).** Rejected — post-completion audit becomes a 7-day TTL race. The single snapshot at terminal step is cheap and preserves the cross-run query surface.
- (b) **Dual-write to both stores on every scratch op.** Rejected — doubles write cost on the hot path for marginal gain. Dual-write is correct when both stores are _concurrently_ live; for per-run intermediate state with a clean terminal handoff, it's twice the work for no benefit.
- (c) **One jsonb blob per run** (single `data jsonb` column instead of per-key rows). Rejected — saves nothing material, gives up SQL ergonomics for cross-run queries.
- (d) **Postgres unchanged from ADR-0016 (no Redis).** Rejected on empirical grounds — m13's sub-agent fan-out + boss-synthesis pattern wants sub-ms inter-agent reads; Postgres at 1-3ms per op multiplied across a boss read pass over N sub-agent findings adds material latency to the user-facing boss turn.
- (e) **Keep Redis keys live indefinitely (no TTL).** Rejected — leak risk on abandoned runs; 30-day TTL gives natural eviction without orchestration-layer cleanup.
- (f) **Delete Redis keys at terminal step.** Rejected — couples cleanup to terminal-step idempotency in a way that introduces a real failure class (partial-delete + retry = inconsistent state). Letting TTL handle eviction is simpler and equivalent in outcome at our scale.

**Open.**

- Whether the boss's synthesis read pass should `SCAN` for `scratch.{subId}.*` keys per run, or maintain a per-sub_id index list in Redis. v1: SCAN with pattern (`SCAN MATCH alfred:scratch:{runId}:scratch.*`) — at single-user scale, scratch counts per run are in the low tens. Revisit if profiling shows SCAN dominating.
- Whether the snapshot step should store a Redis SCAN cursor or completion marker so a retried snapshot doesn't re-read already-landed keys. v1: `ON CONFLICT DO UPDATE` makes re-reads safe; explicit cursor is an optimization that only matters at thousands of scratch entries.
