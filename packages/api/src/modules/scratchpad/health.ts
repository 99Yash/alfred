/**
 * Scratchpad runtime-health observations (#408, PRD #405).
 *
 * The Langfuse trace tree covers the execution spine (LLM generations, tool
 * executions, dispatch rejections) and #406 added `runtime.dispatch.batch` for
 * orchestration overhead. This slice closes the priority blind spot the PRD
 * calls out first: **scratchpad helper health**. Redis is the live per-run store
 * and Postgres receives the terminal snapshot, but read/write/promote/snapshot
 * round-trips were invisible in the trace — an operator couldn't tell whether
 * scratch activity was slow, failing, missing, or snapshotting correctly.
 *
 * This module owns the `runtime.scratch.*` span contract (stable names, opening
 * metadata, key hashing) as pure, testable helpers plus a thin injectable
 * wrapper over `@alfred/ai`'s `startRuntimeSpan`. The four scratchpad primitives
 * in `./index` wrap their Redis/Postgres work with these spans, so every caller
 * — the `system.*` scratch tools, direct workflow writes, and the terminal
 * snapshot — is instrumented at one seam without changing behavior.
 *
 * Privacy posture (PRD "avoid logging sensitive raw values"): metadata is
 * timings / counts / statuses / **hashes** only. A scratch key's `path` is
 * model-controlled and can describe private run memory, so it is never emitted
 * raw — only a stable `keyHash` and its `keyLength`. Scratch *values* likewise
 * never reach a span; only their byte size does. Full I/O still rides the
 * existing `LANGFUSE_CAPTURE_IO` gate inside `startRuntimeSpan`, and the
 * `RuntimeMetaValue` type keeps raw objects off the span by construction.
 */

import {
  startRuntimeSpan,
  type RuntimeSpanCloser,
  type RuntimeSpanInput,
} from "@alfred/ai";
import type { ScratchZone } from "@alfred/contracts";
import { createHash } from "node:crypto";

/** Stable observation names for the scratchpad runtime spans (PRD #405). */
export const RUNTIME_SCRATCH_READ = "runtime.scratch.read";
export const RUNTIME_SCRATCH_WRITE = "runtime.scratch.write";
export const RUNTIME_SCRATCH_PROMOTE = "runtime.scratch.promote";
export const RUNTIME_SCRATCH_SNAPSHOT = "runtime.scratch.snapshot";

/**
 * Short, stable, PII-free fingerprint of a scratch key's logical (dotted) form,
 * e.g. `shared.goal` or `scratch.sub1.findings`. The raw dotted key is never
 * emitted — its `path`/`subId` parts are model-controlled and can leak run
 * memory — so this is the only identity that reaches a span. Hashing the
 * *logical* key (no run-id prefix) means the same key groups across runs.
 * Truncated to 16 hex chars: enough to distinguish keys in a run, far too short
 * to be a durable secret.
 */
export function hashScratchKey(logicalKey: string): string {
  return `sha256:${createHash("sha256").update(logicalKey).digest("hex").slice(0, 16)}`;
}

export interface ScratchReadSpanArgs {
  /** Run id whose scratch namespace owns the key — doubles as the trace id. */
  runId: string;
  zone: ScratchZone;
  /** Logical dotted key (`shared.<path>` / `scratch.<subId>.<path>`). Hashed, never emitted raw. */
  logicalKey: string;
  startedAt: Date;
}

/** Pure builder for the `runtime.scratch.read` opening span. Exported for tests. */
export function buildScratchReadSpanInput(args: ScratchReadSpanArgs): RuntimeSpanInput {
  return {
    runId: args.runId,
    name: RUNTIME_SCRATCH_READ,
    startedAt: args.startedAt,
    metadata: {
      operation: "read",
      zone: args.zone,
      keyHash: hashScratchKey(args.logicalKey),
      keyLength: args.logicalKey.length,
    },
  };
}

export interface ScratchWriteSpanArgs extends ScratchReadSpanArgs {
  /** Identity stamped on the entry (`boss` or a sub-agent id). A role label, not PII. */
  writtenBy: string;
}

/** Pure builder for the `runtime.scratch.write` opening span. Exported for tests. */
export function buildScratchWriteSpanInput(args: ScratchWriteSpanArgs): RuntimeSpanInput {
  return {
    runId: args.runId,
    name: RUNTIME_SCRATCH_WRITE,
    startedAt: args.startedAt,
    metadata: {
      operation: "write",
      zone: args.zone,
      keyHash: hashScratchKey(args.logicalKey),
      keyLength: args.logicalKey.length,
      writtenBy: args.writtenBy,
    },
  };
}

export interface ScratchPromoteSpanArgs {
  runId: string;
  /** Source sub-agent key (`scratch.<subId>.<path>`). Hashed, never emitted raw. */
  fromLogicalKey: string;
  /** Destination boss key (`shared.<path>`). Hashed, never emitted raw. */
  toLogicalKey: string;
  writtenBy: string;
  startedAt: Date;
}

/** Pure builder for the `runtime.scratch.promote` opening span. Exported for tests. */
export function buildScratchPromoteSpanInput(args: ScratchPromoteSpanArgs): RuntimeSpanInput {
  return {
    runId: args.runId,
    name: RUNTIME_SCRATCH_PROMOTE,
    startedAt: args.startedAt,
    metadata: {
      operation: "promote",
      fromZone: "scratch",
      toZone: "shared",
      fromKeyHash: hashScratchKey(args.fromLogicalKey),
      fromKeyLength: args.fromLogicalKey.length,
      toKeyHash: hashScratchKey(args.toLogicalKey),
      toKeyLength: args.toLogicalKey.length,
      writtenBy: args.writtenBy,
    },
  };
}

/** Pure builder for the `runtime.scratch.snapshot` opening span. Exported for tests. */
export function buildScratchSnapshotSpanInput(args: {
  runId: string;
  startedAt: Date;
}): RuntimeSpanInput {
  return {
    runId: args.runId,
    name: RUNTIME_SCRATCH_SNAPSHOT,
    startedAt: args.startedAt,
    metadata: { operation: "snapshot" },
  };
}

// Injectable starter so a test/smoke can observe the emitted span contract
// without a live Langfuse client (mirrors dispatch's `_setRuntimeSpanStarterForTests`).
let runtimeSpanStarter: (input: RuntimeSpanInput) => RuntimeSpanCloser = startRuntimeSpan;

/** Open a scratchpad runtime span. Returns the generic runtime-span closer. */
export function startScratchSpan(input: RuntimeSpanInput): RuntimeSpanCloser {
  return runtimeSpanStarter(input);
}

export function _setScratchRuntimeSpanStarterForTests(
  starter: (input: RuntimeSpanInput) => RuntimeSpanCloser,
): () => void {
  const previous = runtimeSpanStarter;
  runtimeSpanStarter = starter;
  return () => {
    runtimeSpanStarter = previous;
  };
}
