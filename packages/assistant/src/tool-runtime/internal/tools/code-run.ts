/**
 * `system.code_run`: the chat read path (ADR-0124). One read-only script whose host functions are
 * the `codeModeRead` tools and `mcp.read`. Each read is a nested dispatch, so it keeps its gate,
 * its staging row, and its span. Available only when the user's flag is on.
 */

import {
  codeRunInput,
  getStringPath,
  isJsonObject,
  type JsonValue,
  type ToolName,
} from "@alfred/contracts";
import { liveTool, type RegisteredTool } from "@alfred/assistant/tool-runtime";
import { readHostBindings } from "../../code-mode/host-bindings";
import { codeRunDescription } from "../../code-mode/index-text";
import {
  runReadProgram,
  type ReadProgramFailure,
  type ReadProgramLedgerEntry,
  type ReadProgramOutcome,
} from "../../code-mode/run-read-program";

/**
 * What the model reads. `reads` counts the host calls; `failed` includes `tool_error` results.
 * `citations` are the web pages that the script's reads returned, collected on the host side, so
 * the chat sources strip shows them. The guest value cannot add to them or remove them.
 */
export type CodeRunResult =
  | { status: "completed"; value: JsonValue; reads: ReadCounts; citations?: ScriptCitation[] }
  | {
      status: ReadProgramFailure;
      message: string;
      reads: ReadCounts;
      citations?: ScriptCitation[];
    };

/** One web page that a host read returned. The shape of a `system.web_search` citation. */
interface ScriptCitation {
  url: string;
  title?: string;
}

const WEB_SEARCH_TOOL = "system.web_search" satisfies ToolName;

const FETCH_URL_TOOL = "system.fetch_url" satisfies ToolName;

/** The pages of one executed web read: a search's citations, or the page that a fetch read. */
function citationsOf(toolName: ToolName, value: JsonValue): ScriptCitation[] {
  if (!isJsonObject(value) || value.ok !== true) return [];

  if (toolName === WEB_SEARCH_TOOL && Array.isArray(value.citations)) {
    return value.citations.flatMap((citation) => {
      const url = getStringPath(citation, "url");
      const title = getStringPath(citation, "title");

      return url ? [title ? { url, title } : { url }] : [];
    });
  }

  if (toolName === FETCH_URL_TOOL) {
    const url = getStringPath(value, "finalUrl") ?? getStringPath(value, "url");
    const title = getStringPath(value, "title");

    return url ? [title ? { url, title } : { url }] : [];
  }

  return [];
}

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

      const citations: ScriptCitation[] = [];

      const outcome = await runReadProgram({
        source: input.source,
        hosts: readHostBindings({
          readTools,
          hostRead: async (request) => {
            const read = await hostRead(request);

            if (read.kind === "executed")
              citations.push(...citationsOf(request.toolName, read.value));

            return read;
          },
        }),
        runId: ctx.runId,
      });

      const result = codeRunResult(outcome);

      return citations.length > 0 ? { ...result, citations } : result;
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
