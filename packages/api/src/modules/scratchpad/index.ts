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

import {
  logicalScratchKey,
  parseJsonWith,
  scratchKeyPrefix,
  SCRATCH_TTL_SECONDS,
  SCRATCH_ZONES,
  sharedKey,
  subAgentKey,
} from "@alfred/contracts";
import type { ScratchEntry, ScratchZone } from "@alfred/contracts";
import { db } from "@alfred/db";
import { agentRunContext, type AgentRunContextRow } from "@alfred/db/schemas";
import { sql } from "drizzle-orm";
import type IORedis from "ioredis";
import { z } from "zod";
import { createRedisConnection } from "../../queue/connection";
import {
  buildScratchPromoteSpanInput,
  buildScratchReadSpanInput,
  buildScratchSnapshotSpanInput,
  buildScratchWriteSpanInput,
  startScratchSpan,
} from "./health";

// Re-export the scratch health-span contract so it reaches `@alfred/api/backend`
// (the barrel does `export * from "./modules/scratchpad/index"`) for the smoke's
// span-capture seam and for callers that want the stable observation names.
export {
  RUNTIME_SCRATCH_READ,
  RUNTIME_SCRATCH_WRITE,
  RUNTIME_SCRATCH_PROMOTE,
  RUNTIME_SCRATCH_SNAPSHOT,
  _setScratchRuntimeSpanStarterForTests,
} from "./health";

/**
 * Validates the scratch *envelope* on read — `value`'s concrete type is the
 * caller's generic `T` (no runtime info for a type parameter), so a corrupt or
 * stale entry degrades to `null` instead of throwing mid-run.
 */
const scratchEntrySchema = z.object({
  value: z.unknown(),
  zone: z.enum(SCRATCH_ZONES),
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

/**
 * Serialize an entry and SET it with the scratch TTL. Returns the UTF-8 byte
 * size written, for health metadata. The un-instrumented core shared by
 * `writeScratch` and `promoteScratch` so a promote emits exactly one
 * `runtime.scratch.promote` span rather than nesting a spurious write span.
 */
async function putEntry(fullKey: string, entry: ScratchEntry<unknown>): Promise<number> {
  const payload = JSON.stringify(entry);
  await client().set(fullKey, payload, "EX", SCRATCH_TTL_SECONDS);
  return Buffer.byteLength(payload, "utf8");
}

/**
 * GET + envelope-parse. `raw` (null when the key is absent/expired) drives the
 * read span's hit/miss + byte size; `entry` is the parsed envelope, or null when
 * absent OR corrupt — `readScratch`'s existing degrade-to-null contract. The
 * un-instrumented core shared by `readScratch` and `promoteScratch`.
 */
async function fetchEntry(
  fullKey: string,
): Promise<{ raw: string | null; entry: ScratchEntry<unknown> | null }> {
  const raw = await client().get(fullKey);
  if (raw === null) return { raw: null, entry: null };
  return { raw, entry: parseJsonWith(raw, scratchEntrySchema) };
}

export interface WriteScratchArgs<T = unknown> {
  runId: string;
  zone: ScratchZone;
  /** Required when `zone === 'scratch'`; ignored when `zone === 'shared'`. */
  subId?: string;
  path: string;
  value: T;
  /** Identity stamped onto the entry; `'boss'` or a sub-agent id. */
  writtenBy: string;
}

export async function writeScratch<T>(args: WriteScratchArgs<T>): Promise<void> {
  const target = toTarget(args);
  const fullKey = resolveKey(target);
  const span = startScratchSpan(
    buildScratchWriteSpanInput({
      runId: args.runId,
      zone: target.zone,
      logicalKey: logicalScratchKey(args.runId, fullKey),
      writtenBy: args.writtenBy,
      startedAt: new Date(),
    }),
  );
  try {
    const entry: ScratchEntry<T> = {
      value: args.value,
      zone: target.zone,
      writtenBy: args.writtenBy,
      writtenAt: Date.now(),
    };
    const byteSize = await putEntry(fullKey, entry);
    span.end({ status: "ok", metadata: { byteSize } });
  } catch (err) {
    span.end({ status: "error", level: "ERROR" });
    throw err;
  }
}

export interface ReadScratchArgs {
  runId: string;
  zone: ScratchZone;
  subId?: string;
  path: string;
}

export async function readScratch<T>(args: ReadScratchArgs): Promise<ScratchEntry<T> | null> {
  const target = toTarget(args);
  const fullKey = resolveKey(target);
  const span = startScratchSpan(
    buildScratchReadSpanInput({
      runId: args.runId,
      zone: target.zone,
      logicalKey: logicalScratchKey(args.runId, fullKey),
      startedAt: new Date(),
    }),
  );
  try {
    const { raw, entry } = await fetchEntry(fullKey);
    const hit = raw !== null;
    span.end({
      status: "ok",
      metadata: {
        hit,
        // A present-but-unparseable entry (corrupt/stale envelope) degrades to
        // null — flag it so a read miss caused by corruption is distinguishable
        // from a genuinely absent key.
        corrupt: hit && entry === null,
        byteSize: raw === null ? 0 : Buffer.byteLength(raw, "utf8"),
      },
    });
    return entry === null ? null : (entry as ScratchEntry<T>);
  } catch (err) {
    span.end({ status: "error", level: "ERROR" });
    throw err;
  }
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
  const from: ScratchTarget = {
    runId: args.runId,
    zone: "scratch",
    subId: args.fromSubId,
    path: args.fromPath,
  };
  const to: SharedTarget = { runId: args.runId, zone: "shared", path: args.toSharedPath };
  const fromKey = resolveKey(from);
  const toKey = resolveKey(to);
  const writtenBy = args.writtenBy ?? "boss";
  // Read the source and write the destination through the un-instrumented cores
  // so the promote is a single `runtime.scratch.promote` span, not a promote
  // wrapping a spurious read+write span pair.
  const span = startScratchSpan(
    buildScratchPromoteSpanInput({
      runId: args.runId,
      fromLogicalKey: logicalScratchKey(args.runId, fromKey),
      toLogicalKey: logicalScratchKey(args.runId, toKey),
      writtenBy,
      startedAt: new Date(),
    }),
  );
  try {
    const { entry: source } = await fetchEntry(fromKey);
    if (source === null) {
      span.end({ status: "ok", metadata: { hit: false } });
      return null;
    }
    const promoted: ScratchEntry<unknown> = {
      value: source.value,
      zone: "shared",
      writtenBy,
      writtenAt: Date.now(),
    };
    const byteSize = await putEntry(toKey, promoted);
    span.end({ status: "ok", metadata: { hit: true, byteSize } });
    return promoted;
  } catch (err) {
    span.end({ status: "error", level: "ERROR" });
    throw err;
  }
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
  const span = startScratchSpan(buildScratchSnapshotSpanInput({ runId, startedAt: new Date() }));
  try {
    const persisted = await snapshotScratchToPostgresCore(runId, (counts) => {
      // Fold the terminal counts onto the span. Entry count is the PRD's headline
      // durability signal; scanned/corrupt/zone split explain a count that looks
      // wrong without ever emitting a raw key or value.
      span.end({
        status: "ok",
        metadata: {
          scanned: counts.scanned,
          persisted: counts.persisted,
          corrupt: counts.corrupt,
          sharedCount: counts.sharedCount,
          scratchCount: counts.scratchCount,
        },
      });
    });
    return persisted;
  } catch (err) {
    span.end({ status: "error", level: "ERROR" });
    throw err;
  }
}

interface SnapshotCounts {
  /** Keys with a live value that we attempted to parse. */
  scanned: number;
  /** Rows upserted into Postgres. */
  persisted: number;
  /** Present-but-unparseable keys skipped (corrupt/stale envelope). */
  corrupt: number;
  sharedCount: number;
  scratchCount: number;
}

/**
 * The un-instrumented snapshot body. Invokes `onCounts` with the terminal tally
 * on success so the span closer stays out of the SCAN/upsert logic.
 */
async function snapshotScratchToPostgresCore(
  runId: string,
  onCounts: (counts: SnapshotCounts) => void,
): Promise<number> {
  const prefix = scratchKeyPrefix(runId);
  const match = `${prefix}*`;
  const conn = client();

  const rows: AgentRunContextRow[] = [];
  let scanned = 0;
  let corrupt = 0;

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
      scanned += 1;
      const entry = parseJsonWith(raw, scratchEntrySchema);
      if (entry === null) {
        corrupt += 1;
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

  const sharedCount = rows.filter((r) => r.zone === "shared").length;
  const counts: SnapshotCounts = {
    scanned,
    persisted: rows.length,
    corrupt,
    sharedCount,
    scratchCount: rows.length - sharedCount,
  };

  if (rows.length === 0) {
    onCounts(counts);
    return 0;
  }

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

  onCounts(counts);
  return rows.length;
}

function toTarget(args: {
  runId: string;
  zone: ScratchZone;
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
