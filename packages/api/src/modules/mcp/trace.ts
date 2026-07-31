import { startRuntimeSpan, type RuntimeMetaValue, type RuntimeSpanCloser } from "@alfred/ai";
import { createHash, randomBytes, randomUUID } from "node:crypto";

export interface McpTraceContext {
  /** Local run trace identity; never sent to the MCP peer. */
  runId?: string;
  traceparent: string;
  tracestate?: string;
}

export interface McpTraceSpan {
  context: McpTraceContext;
  end(input: {
    status: string;
    level?: "DEFAULT" | "WARNING" | "ERROR";
    metadata?: Record<string, RuntimeMetaValue>;
  }): void;
}

function w3cTraceId(traceId: string): string {
  const derived = createHash("sha256").update(traceId).digest("hex").slice(0, 32);
  return /^0+$/.test(derived) ? "00000000000000000000000000000001" : derived;
}

/** Create one scrubbed span and the controlled W3C context sent to the MCP peer. */
export function startMcpTraceSpan(input: {
  traceId?: string;
  parent?: McpTraceContext;
  name: "runtime.mcp.connect" | "runtime.mcp.catalog_refresh" | "runtime.mcp.broker_invoke";
  metadata?: Record<string, RuntimeMetaValue>;
}): McpTraceSpan {
  const runId = input.traceId ?? input.parent?.runId ?? `mcp:${randomUUID()}`;
  const parentTraceId = input.parent?.traceparent.split("-")[1];
  const traceId =
    parentTraceId && /^[0-9a-f]{32}$/.test(parentTraceId) ? parentTraceId : w3cTraceId(runId);
  const spanId = randomBytes(8).toString("hex");
  const context: McpTraceContext = {
    runId,
    traceparent: `00-${traceId}-${spanId}-01`,
    ...(input.parent?.tracestate ? { tracestate: input.parent.tracestate } : {}),
  };
  let span: RuntimeSpanCloser = { end() {} };
  try {
    span = startRuntimeSpan({
      runId,
      name: input.name,
      startedAt: new Date(),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
  } catch {
    // A missing/misconfigured observability environment must not break MCP.
  }
  return {
    context,
    end(args) {
      span.end(args);
    },
  };
}
