import { startRuntimeSpan, type RuntimeMetaValue, type RuntimeSpanCloser } from "@alfred/ai";
import { createHash, randomBytes, randomUUID } from "node:crypto";

export interface McpTraceContext {
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
  name: "runtime.mcp.connect" | "runtime.mcp.catalog_refresh" | "runtime.mcp.broker_invoke";
  metadata?: Record<string, RuntimeMetaValue>;
}): McpTraceSpan {
  const runId = input.traceId ?? `mcp:${randomUUID()}`;
  const spanId = randomBytes(8).toString("hex");
  const context: McpTraceContext = {
    traceparent: `00-${w3cTraceId(runId)}-${spanId}-01`,
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
