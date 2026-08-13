/**
 * Passthrough "thermometer" telemetry (ADR-0074, PRD User Story 17).
 *
 * When a passthrough result is clipped, the shaper attaches a {@link
 * PassthroughTruncation} to the `http` outcome (the `handleEligible` marker).
 * This module turns that marker into the structured signal the operator reads in
 * Langfuse to *measure* when the raw firehose starts hurting real workflows —
 * the evidence gate for building the object-handle layer (L0). It is emitted, not
 * enforced: crossing a threshold triggers an operator review, never an automatic
 * architecture switch.
 *
 * Pure + shape-defensive: the tool result reaches the dispatcher as `unknown`
 * (the span wrapper is generic over every tool), so this narrows the passthrough
 * shape by hand rather than trusting a cast — a non-passthrough or
 * non-truncated result returns `null` and emits nothing.
 */

import { integrationFromToolName, isRecord, type PassthroughTruncation } from "@alfred/contracts";

/**
 * The structured thermometer signal folded onto the tool span's metadata and
 * mirrored to a structured log line. Carries the exact fields the L0-trigger
 * review needs (PRD "Thermometer"): which integration/tool, the truncation
 * causes, returned vs. original approximate bytes, the dropped totals by kind,
 * the run id, and whether the HTTP call otherwise succeeded (a truncated success
 * is the interesting case; a truncated error body less so).
 */
export interface PassthroughTruncationTelemetry {
  handleEligible: true;
  integration: string;
  toolName: string;
  runId: string;
  /** Whether the underlying HTTP call otherwise succeeded (2xx, no GraphQL errors). */
  succeeded: boolean;
  returnedBytes: number;
  originalBytesApprox: number;
  /** originalBytesApprox − returnedBytes, floored at 0. */
  droppedBytesApprox: number;
  droppedStringCharsApprox: number;
  droppedArrayItemsApprox: number;
  droppedBodyBytesApprox: number;
  causes: PassthroughTruncation["causes"];
}

const TRUNCATION_CAUSE_KINDS = new Set(["string_chars", "array_items", "body_bytes"]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Narrow the `causes` array off an untrusted truncation record, dropping anything malformed. */
function readCauses(value: unknown): PassthroughTruncation["causes"] {
  if (!Array.isArray(value)) return [];
  const causes: PassthroughTruncation["causes"] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const { kind, droppedApprox } = entry;
    if (typeof kind !== "string" || !TRUNCATION_CAUSE_KINDS.has(kind)) continue;
    if (!isFiniteNumber(droppedApprox)) continue;
    causes.push({ kind, droppedApprox } as PassthroughTruncation["causes"][number]);
  }
  return causes;
}

/**
 * Build the thermometer signal from a tool result, or `null` when the result is
 * not a truncated passthrough `http` outcome. Shape-defensive by design: reads
 * only through guards so a non-passthrough tool's result (or a passthrough
 * result that wasn't clipped) is silently skipped.
 */
export function passthroughTruncationTelemetry(
  toolName: string,
  runId: string,
  result: unknown,
): PassthroughTruncationTelemetry | null {
  if (!isRecord(result) || result.outcome !== "http") return null;
  const { truncation, succeeded } = result;
  if (!isRecord(truncation) || truncation.handleEligible !== true) return null;

  const causes = readCauses(truncation.causes);
  const returnedBytes = isFiniteNumber(truncation.returnedBytes) ? truncation.returnedBytes : 0;
  const originalBytesApprox = isFiniteNumber(truncation.originalBytesApprox)
    ? truncation.originalBytesApprox
    : 0;
  const droppedByKind = (target: string): number =>
    causes.reduce((sum, cause) => (cause.kind === target ? sum + cause.droppedApprox : sum), 0);

  return {
    handleEligible: true,
    integration: integrationFromToolNameSafe(toolName),
    toolName,
    runId,
    succeeded: succeeded === true,
    returnedBytes,
    originalBytesApprox,
    droppedBytesApprox: Math.max(0, originalBytesApprox - returnedBytes),
    droppedStringCharsApprox: droppedByKind("string_chars"),
    droppedArrayItemsApprox: droppedByKind("array_items"),
    droppedBodyBytesApprox: droppedByKind("body_bytes"),
    causes,
  };
}

/** Tool name → integration slug, tolerant of a malformed name (telemetry must never throw). */
function integrationFromToolNameSafe(toolName: string): string {
  try {
    return integrationFromToolName(toolName as Parameters<typeof integrationFromToolName>[0]);
  } catch {
    return toolName.slice(0, toolName.indexOf(".")) || toolName;
  }
}
