/**
 * `system.code_run`: the chat read path (ADR-0124). One read-only script whose host functions are
 * the `codeModeRead` tools and `mcp.read`. Each read is a nested dispatch, so it keeps its gate,
 * its staging row, and its span. Available only when the user's flag is on.
 */

import { codeRunInput, type JsonValue } from "@alfred/contracts";
import { liveTool, type RegisteredTool } from "@alfred/assistant/tool-runtime";
import { isSelectedMcpToolReadOnly } from "@alfred/assistant/tool-runtime/mcp";
import { readHostBindings } from "../../code-mode/host-bindings";
import { codeRunDescription } from "../../code-mode/index-text";
import {
  runReadProgram,
  type ReadProgramFailure,
  type ReadProgramLedgerEntry,
  type ReadProgramOutcome,
} from "../../code-mode/run-read-program";

/** What the model reads. `reads` counts the host calls; `failed` includes `tool_error` results. */
export type CodeRunResult =
  | { status: "completed"; value: JsonValue; reads: ReadCounts }
  | { status: ReadProgramFailure; message: string; reads: ReadCounts };

interface ReadCounts {
  total: number;
  failed: number;
}

/** Built at boot from the registered read tools, so the index lists exactly them. */
export function codeRunTool(readTools: readonly RegisteredTool[]): RegisteredTool {
  return liveTool({
    integration: "system",
    action: "code_run",
    riskTier: "no_risk",
    replay: "safe",
    availability: { codeModeReadPath: true },
    description: codeRunDescription(readTools),
    discovery: {
      title: "Read with a script",
      aliases: ["code mode", "run a script", "read many", "batch read"],
      tags: ["read", "script", "code"],
      verbs: ["read", "run", "fetch", "summarize"],
    },
    inputSchema: codeRunInput,
    execute: async (input, ctx): Promise<CodeRunResult> => {
      const { hostRead } = ctx;

      // Dispatch sets it on every call it runs. A direct `execute` has no gate to nest under.
      if (!hostRead) throw new Error("[code-mode] system.code_run ran outside dispatch");

      const outcome = await runReadProgram({
        source: input.source,
        hosts: readHostBindings({
          readTools,
          hostRead,
          isReadOnlyMcpTool: (ref) => isSelectedMcpToolReadOnly({ userId: ctx.userId, ...ref }),
        }),
        runId: ctx.runId,
      });

      return codeRunResult(outcome);
    },
    // ADR-0124 instrumentation: script success, and failed reads in scripts that returned.
    spanFacts: (output) => ({
      metadata: {
        codeRunOutcome: output.status,
        hostCalls: output.reads.total,
        hostCallsFailed: output.reads.failed,
      },
    }),
  });
}

function codeRunResult(outcome: ReadProgramOutcome): CodeRunResult {
  const reads = readCounts(outcome.ledger);

  if (outcome.status === "completed") return { status: "completed", value: outcome.value, reads };

  return { status: outcome.status, message: outcome.message, reads };
}

function readCounts(ledger: readonly ReadProgramLedgerEntry[]): ReadCounts {
  return {
    total: ledger.length,
    failed: ledger.filter((entry) => entry.kind !== "executed").length,
  };
}
