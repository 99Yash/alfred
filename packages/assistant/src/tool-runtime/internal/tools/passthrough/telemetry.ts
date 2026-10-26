/**
 * Truncation telemetry for passthrough results (ADR-0074). Operators read it in
 * Langfuse to decide when to build the object-handle layer. It never enforces anything.
 */

import {
  integrationFromToolName,
  isToolName,
  type PassthroughResult,
  type PassthroughTruncation,
} from "@alfred/contracts";
import type { ToolSpanFacts } from "../../registry";

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

/** Span facts for a passthrough tool: the truncation of an `http` outcome, if any. */
export function passthroughSpanFacts(output: PassthroughResult): ToolSpanFacts {
  if (output.outcome !== "http" || output.truncation === undefined) return {};

  return {
    passthroughTruncation: { truncation: output.truncation, succeeded: output.succeeded },
  };
}

export function passthroughTruncationTelemetry(
  toolName: string,
  runId: string,
  facts: NonNullable<ToolSpanFacts["passthroughTruncation"]>,
): PassthroughTruncationTelemetry {
  const { truncation, succeeded } = facts;
  const { causes, returnedBytes, originalBytesApprox } = truncation;

  const droppedByKind = (target: string): number =>
    causes.reduce((sum, cause) => (cause.kind === target ? sum + cause.droppedApprox : sum), 0);

  return {
    handleEligible: true,
    integration: integrationFromToolNameSafe(toolName),
    toolName,
    runId,
    succeeded,
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
  if (isToolName(toolName)) return integrationFromToolName(toolName);

  return toolName.slice(0, toolName.indexOf(".")) || toolName;
}
