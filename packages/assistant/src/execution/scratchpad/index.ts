/**
 * Per-run scratchpad (ADR-0036): live in Redis, snapshotted to Postgres when the run ends.
 * The dispatcher enforces zones; these helpers trust their caller.
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
import { z } from "zod";
import { createRedisConnection, type BoundedRedis } from "@alfred/db/redis";
import {
  buildScratchPromoteSpanInput,
  buildScratchReadSpanInput,
  buildScratchSnapshotSpanInput,
  buildScratchWriteSpanInput,
  startScratchSpan,
} from "./health";

export {
  RUNTIME_SCRATCH_READ,
  RUNTIME_SCRATCH_WRITE,
  RUNTIME_SCRATCH_PROMOTE,
  RUNTIME_SCRATCH_SNAPSHOT,
  _setScratchRuntimeSpanStarterForTests,
} from "./health";

/** Checks only the envelope; `value` is the caller's `T`. A bad entry reads as `null`. */
const scratchEntrySchema = z.object({
  value: z.unknown(),
  zone: z.enum(SCRATCH_ZONES),
  writtenBy: z.string(),
  writtenAt: z.number(),
});

let _client: BoundedRedis | undefined;

function client(): BoundedRedis {
  if (!_client) _client = createRedisConnection("command");

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

/** Returns the bytes written. No span, so a promote emits only its own span. */
async function putEntry(fullKey: string, entry: ScratchEntry<unknown>): Promise<number> {
  const payload = JSON.stringify(entry);
  await client().set(fullKey, payload, "EX", SCRATCH_TTL_SECONDS);

  return Buffer.byteLength(payload, "utf8");
}

/** `entry` is null when the key is absent or corrupt; `raw` tells the two apart. No span. */
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
  /** Required for the `scratch` zone. */
  subId?: string;
  path: string;
  value: T;
  /** `'boss'` or a sub-agent id. */
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
        corrupt: hit && entry === null,
        byteSize: raw === null ? 0 : Buffer.byteLength(raw, "utf8"),
      },
    });

    // SAFETY: entries are written with this envelope, and a corrupt one is already null.
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
  /** Defaults to `'boss'`. */
  writtenBy?: string;
}

/**
 * Boss only: copy a sub-agent value into `shared.*`. Not atomic, but the boss is the only
 * `shared.*` writer.
 * Returns `null` if the source is missing.
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
 * Upsert every scratch key of the run into `agent_run_context`. Idempotent. Returns the row count.
 */
export async function snapshotScratchToPostgres(runId: string): Promise<number> {
  const span = startScratchSpan(buildScratchSnapshotSpanInput({ runId, startedAt: new Date() }));

  try {
    const persisted = await snapshotScratchToPostgresCore(runId, (counts) => {
      // Counts only; never a raw key or value.
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
  scanned: number;
  persisted: number;
  corrupt: number;
  sharedCount: number;
  scratchCount: number;
}

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
    // COUNT is a hint, not a cap.
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

  // Postgres allows 65535 bind params per statement; 1000 rows stays well under.
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
