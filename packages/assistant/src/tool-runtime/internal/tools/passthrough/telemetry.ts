/**
 * Truncation telemetry for passthrough results (ADR-0074). Operators read it in
 * Langfuse to decide when to build the object-handle layer. It never enforces anything.
 */

import {
  enumGuard,
  integrationFromToolName,
  isRecord,
  type PassthroughTruncation,
} from "@alfred/contracts";

export interface PassthroughTruncationTelemetry {
  handleEligible: true;
  integration: string;
  toolName: string;
  runId: string;
  /** 2xx with no GraphQL errors. */
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

const TRUNCATION_CAUSE_KINDS = ["string_chars", "array_items", "body_bytes"] as const;

const isTruncationCauseKind = enumGuard(TRUNCATION_CAUSE_KINDS);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readCauses(value: unknown): PassthroughTruncation["causes"] {
  if (!Array.isArray(value)) return [];
  const causes: PassthroughTruncation["causes"] = [];

  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const { kind, droppedApprox } = entry;

    if (!isTruncationCauseKind(kind)) continue;

    if (!isFiniteNumber(droppedApprox)) continue;
    causes.push({ kind, droppedApprox });
  }

  return causes;
}

/** `null` unless the result is a truncated passthrough `http` outcome. Reads only through guards. */
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

/** Never throws: telemetry must not fail the call. */
function integrationFromToolNameSafe(toolName: string): string {
  try {
    // SAFETY: integrationFromToolName throws on an unknown name; the catch handles it.
    return integrationFromToolName(toolName as Parameters<typeof integrationFromToolName>[0]);
  } catch {
    return toolName.slice(0, toolName.indexOf(".")) || toolName;
  }
}
