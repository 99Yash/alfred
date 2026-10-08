/**
 * `runtime.scratch.*` spans (#408). Keys and values never reach a span: the model writes
 * the key path, which can describe private run memory. Spans get a key hash and byte sizes only.
 */

import { startRuntimeSpan, type RuntimeSpanCloser, type RuntimeSpanInput } from "@alfred/ai";
import type { ScratchZone } from "@alfred/contracts";
import { createHash } from "node:crypto";

export const RUNTIME_SCRATCH_READ = "runtime.scratch.read";

export const RUNTIME_SCRATCH_WRITE = "runtime.scratch.write";

export const RUNTIME_SCRATCH_PROMOTE = "runtime.scratch.promote";

export const RUNTIME_SCRATCH_SNAPSHOT = "runtime.scratch.snapshot";

/** Hashes the dotted key without the run id, so one key groups across runs. */
export function hashScratchKey(logicalKey: string): string {
  return `sha256:${createHash("sha256").update(logicalKey).digest("hex").slice(0, 16)}`;
}

export interface ScratchReadSpanArgs {
  /** Also the trace id. */
  runId: string;
  zone: ScratchZone;
  /** Hashed; never emitted raw. */
  logicalKey: string;
  startedAt: Date;
}

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
  /** `boss` or a sub-agent id; not PII. */
  writtenBy: string;
}

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
  /** Hashed; never emitted raw. */
  fromLogicalKey: string;
  /** Hashed; never emitted raw. */
  toLogicalKey: string;
  writtenBy: string;
  startedAt: Date;
}

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

// Replaceable, so a test can see spans without Langfuse.
let runtimeSpanStarter: (input: RuntimeSpanInput) => RuntimeSpanCloser = startRuntimeSpan;

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
