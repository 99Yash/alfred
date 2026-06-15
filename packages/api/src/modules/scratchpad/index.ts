/**
 * Per-run scratchpad helpers (ADR-0036).
 *
 * Redis is the live store during a run; Postgres receives a per-key
 * snapshot at the executor's terminal step. Keys are produced by the
 * `sharedKey` / `subAgentKey` builders in `@alfred/contracts` so the
 * shape `alfred:scratch:{runId}:{zone}.{path}` is enforced in one place
 * across both writers (here) and the dispatcher's zone gate (Phase 3+).
 *
 * Zone enforcement (boss writes `shared.*`, sub-agent writes its own
 * `scratch.{subId}.*`) lives at the dispatcher — these helpers are
 * primitives. Callers who bypass the dispatcher are trusted to pick the
 * right zone.
 */

import { parseJsonWith, SCRATCH_TTL_SECONDS, sharedKey, subAgentKey } from "@alfred/contracts";
import type { ScratchEntry } from "@alfred/contracts";
import { db } from "@alfred/db";
import { agentRunContext, type AgentRunContextRow } from "@alfred/db/schemas";
import { sql } from "drizzle-orm";
import type IORedis from "ioredis";
import { z } from "zod";
import { createRedisConnection } from "../../queue/connection";

/**
 * Validates the scratch *envelope* on read — `value`'s concrete type is the
 * caller's generic `T` (no runtime info for a type parameter), so a corrupt or
 * stale entry degrades to `null` instead of throwing mid-run.
 */
const scratchEntrySchema = z.object({
  value: z.unknown(),
  zone: z.enum(["shared", "scratch"]),
  writtenBy: z.string(),
  writtenAt: z.number(),
});

let _client: IORedis | undefined;
function client(): IORedis {
  if (!_client) _client = createRedisConnection();
  return _client;
}

type SharedTarget = { runId: string; zone: "shared"; path: string };
type ScratchTarget = { runId: string; zone: "scratch"; subId: string; path: string };
type ScratchTargetArgs = SharedTarget | ScratchTarget;

function resolveKey(target: ScratchTargetArgs): string {
  return target.zone === "shared"
    ? sharedKey(target.runId, target.path)
    : subAgentKey(target.runId, target.subId, target.path);
}

export interface WriteScratchArgs<T = unknown> {
  runId: string;
  zone: "shared" | "scratch";
  /** Required when `zone === 'scratch'`; ignored when `zone === 'shared'`. */
  subId?: string;
  path: string;
  value: T;
  /** Identity stamped onto the entry; `'boss'` or a sub-agent id. */
  writtenBy: string;
}

export async function writeScratch<T>(args: WriteScratchArgs<T>): Promise<void> {
  const target = toTarget(args);
  const entry: ScratchEntry<T> = {
    value: args.value,
    zone: target.zone,
    writtenBy: args.writtenBy,
    writtenAt: Date.now(),
  };
  await client().set(resolveKey(target), JSON.stringify(entry), "EX", SCRATCH_TTL_SECONDS);
}

export interface ReadScratchArgs {
  runId: string;
  zone: "shared" | "scratch";
  subId?: string;
  path: string;
}

export async function readScratch<T>(args: ReadScratchArgs): Promise<ScratchEntry<T> | null> {
  const raw = await client().get(resolveKey(toTarget(args)));
  if (raw === null) return null;
  const entry = parseJsonWith(raw, scratchEntrySchema);
  return entry === null ? null : (entry as ScratchEntry<T>);
}

export interface PromoteScratchArgs {
  runId: string;
  fromSubId: string;
  fromPath: string;
  toSharedPath: string;
  /** Identity stamped on the new `shared.*` entry; defaults to `'boss'`. */
  writtenBy?: string;
}

/**
 * Boss-only: copy a sub-agent's `scratch.{subId}.{fromPath}` value into
 * `shared.{toSharedPath}`. Read-then-write — not atomic across the two
 * keys, but the boss is the single writer of `shared.*` so there is no
 * reader/writer contention to worry about.
 *
 * Returns the new `shared.*` entry, or `null` if the source key was
 * missing or expired.
 */
export async function promoteScratch(
  args: PromoteScratchArgs,
): Promise<ScratchEntry<unknown> | null> {
  const source = await readScratch<unknown>({
    runId: args.runId,
    zone: "scratch",
    subId: args.fromSubId,
    path: args.fromPath,
  });
  if (source === null) return null;
  const writtenBy = args.writtenBy ?? "boss";
  await writeScratch({
    runId: args.runId,
    zone: "shared",
    path: args.toSharedPath,
    value: source.value,
    writtenBy,
  });
  return {
    value: source.value,
    zone: "shared",
    writtenBy,
    writtenAt: Date.now(),
  };
}

/**
 * Terminal-step snapshot: SCAN every `alfred:scratch:{runId}:*` key,
 * parse each entry, and upsert into `agent_run_context` keyed by
 * `(run_id, key)`. Idempotent — re-running on the same Redis state
 * produces the same Postgres state.
 *
 * Returns the number of keys persisted.
 */
export async function snapshotScratchToPostgres(runId: string): Promise<number> {
  const prefix = `alfred:scratch:${runId}:`;
  const match = `${prefix}*`;
  const conn = client();

  const rows: AgentRunContextRow[] = [];

  let cursor = "0";
  do {
    // SCAN COUNT is a hint, not a cap; 100 keeps each round small while
    // limiting the number of round-trips for typical run sizes.
    const [next, batch] = await conn.scan(cursor, "MATCH", match, "COUNT", 100);
    cursor = next;
    if (batch.length === 0) continue;
    const values = await conn.mget(...batch);
    for (let i = 0; i < batch.length; i++) {
      const raw = values[i];
      const fullKey = batch[i];
      if (raw === null || raw === undefined || fullKey === undefined) continue;
      const dotted = fullKey.slice(prefix.length);
      if (dotted.length === 0) continue;
      const entry = parseJsonWith(raw, scratchEntrySchema);
      if (entry === null) {
        console.warn(`[scratchpad] skipping corrupt scratch key during snapshot: ${fullKey}`);
        continue;
      }
      rows.push({
        runId,
        key: dotted,
        zone: entry.zone,
        value: entry.value,
        writtenBy: entry.writtenBy,
        writtenAt: new Date(entry.writtenAt),
      });
    }
  } while (cursor !== "0");

  if (rows.length === 0) return 0;

  // Chunked upsert. Each row carries 6 parameters; Postgres caps bind
  // params at 65535 (`$1`..`$65535`), so a single VALUES list maxes out
  // at ~10,922 rows. 1000 rows / 6000 params per chunk is well under
  // that ceiling and keeps each statement's planning time bounded for
  // any future high-fanout sub-agent topology.
  const CHUNK_SIZE = 1000;
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    await db()
      .insert(agentRunContext)
      .values(chunk)
      .onConflictDoUpdate({
        target: [agentRunContext.runId, agentRunContext.key],
        set: {
          zone: sql`excluded.zone`,
          value: sql`excluded.value`,
          writtenBy: sql`excluded.written_by`,
          writtenAt: sql`excluded.written_at`,
        },
      });
  }

  return rows.length;
}

function toTarget(args: {
  runId: string;
  zone: "shared" | "scratch";
  subId?: string;
  path: string;
}): ScratchTargetArgs {
  if (args.zone === "shared") {
    return { runId: args.runId, zone: "shared", path: args.path };
  }
  if (!args.subId) {
    throw new Error("[scratchpad] subId is required when zone='scratch'");
  }
  return { runId: args.runId, zone: "scratch", subId: args.subId, path: args.path };
}
