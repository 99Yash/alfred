/**
 * Per-run scratchpad (ADR-0036): live in Redis, snapshotted to Postgres when the run ends.
 * `scratchpad({ runId, writer })` binds one writer and owns the zone rules. The snapshot is a
 * run-level operation and has no writer.
 */

import {
  assertNever,
  logicalScratchKey,
  parseJsonWith,
  scratchKeyPrefix,
  SCRATCH_TTL_SECONDS,
  SCRATCH_ZONES,
  sharedKey,
  subAgentKey,
} from "@alfred/contracts";
import type { ScratchEntry } from "@alfred/contracts";
import type { ToolCallActor } from "@alfred/assistant/tool-runtime";
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
import { logger } from "@alfred/logging";

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

/** Who acts on the scratchpad: the boss, or one sub-agent. The same value as the tool caller. */
export type ScratchWriter = ToolCallActor["caller"];

type SharedTarget = { zone: "shared"; path: string };

type SubAgentTarget = { zone: "scratch"; subId: string; path: string };

type ScratchTarget = SharedTarget | SubAgentTarget;

/** One operation, named by logical keys: `shared.<path>` or `scratch.<subId>.<path>`. */
export type ScratchOperation =
  | { verb: "read"; key: string }
  | { verb: "write"; key: string }
  | { verb: "promote"; fromKey: string; toKey: string };

/** The refusal text that dispatch returns as `invalid_input`. */
type Refusal = { ok: false; refusal: string };

type Admission<T> = { ok: true; target: T } | Refusal;

function refuse(refusal: string): Refusal {
  return { ok: false, refusal };
}

function keyPartRefusal(name: "subId" | "path", value: string | undefined): string | null {
  return !value || value.includes(":")
    ? `Scratch key ${name} must be non-empty and contain no ':'`
    : null;
}

function parseLogicalKey(key: string): Admission<ScratchTarget> {
  const [zone, first, second, ...rest] = key.split(".");

  if (zone === "shared" && first !== undefined && second === undefined) {
    const pathRefusal = keyPartRefusal("path", first);

    if (pathRefusal !== null) return refuse(pathRefusal);

    return { ok: true, target: { zone: "shared", path: first } };
  }

  if (zone === "scratch" && first !== undefined && second !== undefined && rest.length === 0) {
    const partRefusal = keyPartRefusal("subId", first) ?? keyPartRefusal("path", second);

    if (partRefusal !== null) return refuse(partRefusal);

    return { ok: true, target: { zone: "scratch", subId: first, path: second } };
  }

  return refuse("Scratch key must be shared.<path> or scratch.<subId>.<path>");
}

// The zone rules (ADR-0036), decided only here. Only the boss writes `shared.*` and promotes.
// A sub-agent reads `shared.*` and its own zone, and writes only its own zone.

function admitRead(writer: ScratchWriter, key: string): Admission<ScratchTarget> {
  const parsed = parseLogicalKey(key);

  if (!parsed.ok || writer === "boss") return parsed;

  const { target } = parsed;

  if (target.zone === "scratch" && target.subId !== writer.subId) {
    return refuse(`Sub-agent '${writer.subId}' cannot read scratch for '${target.subId}'`);
  }

  return parsed;
}

function admitWrite(writer: ScratchWriter, key: string): Admission<ScratchTarget> {
  const parsed = parseLogicalKey(key);

  if (!parsed.ok) return parsed;

  const { target } = parsed;

  if (writer === "boss") {
    return target.zone === "shared"
      ? parsed
      : refuse("Boss can only write shared.<path> scratch keys");
  }

  return target.zone === "scratch" && target.subId === writer.subId
    ? parsed
    : refuse(`Sub-agent '${writer.subId}' can only write scratch.${writer.subId}.<path> keys`);
}

function admitPromote(
  writer: ScratchWriter,
  fromKey: string,
  toKey: string,
): Admission<{ from: SubAgentTarget; to: SharedTarget }> {
  // The `system.promote` caller floor already keeps a sub-agent from reaching this.
  if (writer !== "boss") return refuse(`Sub-agent '${writer.subId}' cannot promote scratch keys`);

  const from = parseLogicalKey(fromKey);

  if (!from.ok) return from;
  const to = parseLogicalKey(toKey);

  if (!to.ok) return to;

  if (from.target.zone !== "scratch") {
    return refuse("system.promote fromKey must be scratch.<subId>.<path>");
  }

  if (to.target.zone !== "shared") return refuse("system.promote toKey must be shared.<path>");

  return { ok: true, target: { from: from.target, to: to.target } };
}

function admit(writer: ScratchWriter, operation: ScratchOperation): Admission<unknown> {
  switch (operation.verb) {
    case "read":
      return admitRead(writer, operation.key);
    case "write":
      return admitWrite(writer, operation.key);
    case "promote":
      return admitPromote(writer, operation.fromKey, operation.toKey);
    default:
      return assertNever(operation, "scratchpad verb");
  }
}

/** A verb called with a refused operation throws here, before any span or I/O. */
function admitted<T>(admission: Admission<T>): T {
  if (!admission.ok) throw new Error(`[scratchpad] ${admission.refusal}`);

  return admission.target;
}

/**
 * One run's scratchpad as one writer sees it. Keys are logical: `shared.<path>` or
 * `scratch.<subId>.<path>`. The writer sets `writtenBy` and decides which keys it may touch.
 */
export interface Scratchpad {
  /** The refusal text for `operation`, or `null` when the zone rules admit it. No I/O. */
  refusal(operation: ScratchOperation): string | null;
  /** `null` when the key is absent or its entry is corrupt. Throws on a refused key. */
  read(key: string): Promise<ScratchEntry<unknown> | null>;
  /** Returns the stored envelope. Throws on a refused key. */
  write<T>(key: string, value: T): Promise<ScratchEntry<T>>;
  /**
   * Copy a sub-agent value into `shared.*`. Not atomic, but the boss is the only `shared.*`
   * writer. `null` when the source is missing. Throws on a refused pair.
   */
  promote(fromKey: string, toKey: string): Promise<ScratchEntry<unknown> | null>;
}

/** Bind one run's scratchpad to the writer that acts on it. */
export function scratchpad(args: { runId: string; writer: ScratchWriter }): Scratchpad {
  const { runId, writer } = args;
  const writtenBy = writer === "boss" ? "boss" : writer.subId;

  return {
    refusal: (operation) => {
      const admission = admit(writer, operation);

      return admission.ok ? null : admission.refusal;
    },
    read: (key) => readEntry(runId, admitted(admitRead(writer, key))),
    write: (key, value) =>
      writeEntry({ runId, target: admitted(admitWrite(writer, key)), value, writtenBy }),
    promote: (fromKey, toKey) =>
      promoteEntry({ runId, ...admitted(admitPromote(writer, fromKey, toKey)), writtenBy }),
  };
}

function resolveKey(runId: string, target: ScratchTarget): string {
  return target.zone === "shared"
    ? sharedKey(runId, target.path)
    : subAgentKey(runId, target.subId, target.path);
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

async function writeEntry<T>(args: {
  runId: string;
  target: ScratchTarget;
  value: T;
  writtenBy: string;
}): Promise<ScratchEntry<T>> {
  const fullKey = resolveKey(args.runId, args.target);

  const span = startScratchSpan(
    buildScratchWriteSpanInput({
      runId: args.runId,
      zone: args.target.zone,
      logicalKey: logicalScratchKey(args.runId, fullKey),
      writtenBy: args.writtenBy,
      startedAt: new Date(),
    }),
  );

  try {
    const entry: ScratchEntry<T> = {
      value: args.value,
      zone: args.target.zone,
      writtenBy: args.writtenBy,
      writtenAt: Date.now(),
    };

    const byteSize = await putEntry(fullKey, entry);
    span.end({ status: "ok", metadata: { byteSize } });

    return entry;
  } catch (err) {
    span.end({ status: "error", level: "ERROR" });
    throw err;
  }
}

async function readEntry(
  runId: string,
  target: ScratchTarget,
): Promise<ScratchEntry<unknown> | null> {
  const fullKey = resolveKey(runId, target);

  const span = startScratchSpan(
    buildScratchReadSpanInput({
      runId,
      zone: target.zone,
      logicalKey: logicalScratchKey(runId, fullKey),
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

    return entry;
  } catch (err) {
    span.end({ status: "error", level: "ERROR" });
    throw err;
  }
}

async function promoteEntry(args: {
  runId: string;
  from: SubAgentTarget;
  to: SharedTarget;
  writtenBy: string;
}): Promise<ScratchEntry<unknown> | null> {
  const fromKey = resolveKey(args.runId, args.from);
  const toKey = resolveKey(args.runId, args.to);
  const { writtenBy } = args;

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
        logger.warn(`[scratchpad] skipping corrupt scratch key during snapshot: ${fullKey}`);
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
