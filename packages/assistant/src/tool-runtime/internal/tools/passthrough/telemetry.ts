/**
 * Truncation telemetry for passthrough results (ADR-0074). Operators read it in
 * Langfuse to decide when to build the object-handle layer. It never enforces anything.
 */

import {
  canonicalJson,
  integrationFromToolName,
  isToolName,
  restPassthroughRequestSchema,
  truncatedCoverage,
  type PassthroughResult,
  type ResultCut,
  type ReadEvidence,
} from "@alfred/contracts";
import type { ToolSpanFacts } from "../../registry";
import { itemEvidence } from "../../../item-evidence";

export interface PassthroughTruncationTelemetry {
  integration: string;
  toolName: string;
  runId: string;
  /** 2xx with no GraphQL errors. */
  succeeded: boolean;
  limitBytes: number;
  totalBytes: number;
  /** The list items that the one size rule removed (ADR-0130 decision 5). */
  droppedItems: number;
  /** The string characters that it removed. */
  droppedChars: number;
  cuts: number;
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

  const dropped = (unit: ResultCut["unit"]): number =>
    truncation.cuts.reduce((sum, cut) => (cut.unit === unit ? sum + cut.total - cut.kept : sum), 0);

  return {
    integration: integrationFromToolNameSafe(toolName),
    toolName,
    runId,
    succeeded,
    limitBytes: truncation.limitBytes,
    totalBytes: truncation.totalBytes,
    droppedItems: dropped("items"),
    droppedChars: dropped("chars"),
    cuts: truncation.cuts.length + (truncation.moreCuts ?? 0),
  };
}

/** Never throws: telemetry must not fail the call. */
function integrationFromToolNameSafe(toolName: string): string {
  if (isToolName(toolName)) return integrationFromToolName(toolName);

  return toolName.slice(0, toolName.indexOf(".")) || toolName;
}

/**
 * The evidence of a passthrough read (ADR-0124 evidence record). The response is opaque, so the
 * item is the whole body, and its id is the request: the tool, the method, the path, and the query.
 * It states its coverage gap when the bounds cut the body. `bind()` derives it, so a passthrough
 * tool has no hook to forget.
 */
export function passthroughEvidence(
  toolName: string,
  input: unknown,
  output: PassthroughResult,
): ReadEvidence {
  if (output.outcome !== "http" || !output.succeeded) return itemEvidence([]);

  const request = restPassthroughRequestSchema.safeParse(input);

  const id = request.success
    ? [
        request.data.method.toUpperCase(),
        request.data.path,
        ...(request.data.query ? [canonicalJson(request.data.query)] : []),
      ].join(" ")
    : "request";

  return itemEvidence(
    [{ ref: { kind: "record", store: toolName, id, depth: "body" }, item: output.body }],
    truncatedCoverage(output.truncation !== undefined),
  );
}
