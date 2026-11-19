/**
 * `system.code_run`: the chat read path (ADR-0124). One read-only script whose host functions are
 * the `codeModeRead` tools and `mcp.read`. Each read is a nested dispatch, so it keeps its gate,
 * its staging row, and its span. Available only when the user's flag is on.
 */

import {
  codeRunInput,
  type JsonValue,
  type ReadEvidenceRef,
  type ScriptSource,
} from "@alfred/contracts";
import { liveTool, type RegisteredTool } from "@alfred/assistant/tool-runtime";
import { readCurrentMcpCatalogRevision } from "@alfred/assistant/tool-runtime/mcp";
import type { HostCallEntry } from "../registry";
import { readHostBindings } from "../../code-mode/host-bindings";
import { codeRunDescription } from "../../code-mode/index-text";
import {
  runReadProgram,
  type ReadProgramFailure,
  type ReadProgramOutcome,
} from "../../code-mode/run-read-program";
import { scriptSources } from "../../code-mode/script-sources";

/**
 * What the model reads. `reads` counts the host calls; `failed` includes `tool_error` results.
 * `sources` are the web pages that the script's reads returned, taken from the evidence record on
 * the host side, so the guest value cannot add to them or remove them. They do not depend on the
 * script's status: a later failure keeps the pages of the reads that succeeded.
 */
export type CodeRunResult = (
  | { status: "completed"; value: JsonValue }
  | { status: ReadProgramFailure; message: string }
) & {
  reads: ReadCounts;
  sources?: ScriptSource[];
  /** Pages left out above the count or byte cap of `sources`. */
  omittedSources?: number;
};

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
      const { hostRead, hostCalls } = ctx;

      // Dispatch sets both on every call it runs. A direct `execute` has no gate to nest under,
      // and no commit to save the record with.
      if (!hostRead || !hostCalls) {
        throw new Error("[code-mode] system.code_run ran outside dispatch");
      }

      // Dispatch saves the ledger with this call's result (ADR-0124 amendment 2026-11-18).
      const outcome = await runReadProgram({
        source: input.source,
        // One pass, one set of catalog pins (ADR-0116 amendment 2026-11-18).
        hosts: readHostBindings({
          readTools,
          hostRead,
          readCatalogRevision: (connectionId) =>
            readCurrentMcpCatalogRevision({ userId: ctx.userId, connectionId }),
        }),
        ledger: hostCalls,
        runId: ctx.runId,
      });

      return codeRunResult(outcome);
    },
    effects: (output) =>
      output.sources
        ? {
            scriptSources: {
              sources: output.sources,
              ...(output.omittedSources ? { omitted: output.omittedSources } : {}),
            },
          }
        : {},
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
  const { sources, omitted: aboveCaps } = scriptSources(webRefsOf(outcome.ledger));
  // Pages whose reference did not fit its schema (a URL above the cap) are omitted too.
  const omitted = aboveCaps + omittedPagesOf(outcome.ledger);

  const pages = {
    ...(sources.length > 0 ? { sources } : {}),
    ...(omitted > 0 ? { omittedSources: omitted } : {}),
  };

  if (outcome.status === "completed") {
    return { status: "completed", value: outcome.value, reads, ...pages };
  }

  return { status: outcome.status, message: outcome.message, reads, ...pages };
}

/** The web references of the reads that executed, in request order. */
function webRefsOf(ledger: readonly HostCallEntry[]): Extract<ReadEvidenceRef, { kind: "web" }>[] {
  return ledger
    .filter((entry) => entry.kind === "executed")
    .toSorted((a, b) => a.index - b.index)
    .flatMap((entry) => entry.evidence?.refs ?? [])
    .filter((ref) => ref.kind === "web");
}

function omittedPagesOf(ledger: readonly HostCallEntry[]): number {
  return ledger
    .filter((entry) => entry.kind === "executed")
    .reduce((sum, entry) => sum + (entry.evidence?.omittedPages ?? 0), 0);
}

function readCounts(ledger: readonly HostCallEntry[]): ReadCounts {
  return {
    total: ledger.length,
    failed: ledger.filter((entry) => entry.kind !== "executed").length,
  };
}
