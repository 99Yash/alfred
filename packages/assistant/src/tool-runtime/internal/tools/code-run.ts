/**
 * `system.code_run`: the chat read path (ADR-0124). One read-only script whose host functions are
 * the `codeModeRead` tools, `mcp.read`, and the clock `time.now()`. Each read is a nested dispatch,
 * so it keeps its gate, its staging row, and its span. Available only when the user's flag is on.
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
import { readHostBindings, timeNowBinding } from "../../code-mode/host-bindings";
import { codeRunDescription } from "../../code-mode/index-text";
import {
  runReadProgram,
  type ReadProgramFailure,
  type ReadProgramOutcome,
} from "../../code-mode/run-read-program";
import { scriptSources } from "../../code-mode/script-sources";
import { approvalCauseFact, type ApprovalCauseFact } from "../../approval-rule";
import { RESULT_HANDLE_EVIDENCE_STORE } from "./load-result";
import { currentTimeSnapshot } from "./system";

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
  /**
   * The reads that wait for the user's approval: the reason and the settings that remove each card
   * (ADR-0130 amendment (c)). From the host ledger, so a script that catches `needs_approval` does
   * not lose them. One entry per tool, at most `MAX_APPROVAL_FACTS`.
   */
  approvals?: ApprovalCauseFact[];
  /**
   * The oldest fetch time of the stored results that the script read with `system.load_result`,
   * from the host ledger. The park step gives the value this fetch time, so data from an earlier
   * turn does not look new (ADR-0130 decision 7).
   */
  loadedFetchedAt?: string;
};

/** A bound on the approval facts of one script, so a loop over many gated reads stays small. */
const MAX_APPROVAL_FACTS = 5;

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
        hosts: [
          ...readHostBindings({
            readTools,
            hostRead,
            readCatalogRevision: (connectionId) =>
              readCurrentMcpCatalogRevision({ userId: ctx.userId, connectionId }),
          }),
          // The same snapshot and zone as `system.current_time` (ADR-0130 decision 7).
          timeNowBinding(() => currentTimeSnapshot(ctx.timezone)),
        ],
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

  const approvals = approvalFactsOf(outcome.ledger);
  const loadedFetchedAt = oldestLoadedFetchOf(outcome.ledger);

  const pages = {
    ...(sources.length > 0 ? { sources } : {}),
    ...(omitted > 0 ? { omittedSources: omitted } : {}),
    ...(approvals.length > 0 ? { approvals } : {}),
    ...(loadedFetchedAt ? { loadedFetchedAt } : {}),
  };

  if (outcome.status === "completed") {
    return { status: "completed", value: outcome.value, reads, ...pages };
  }

  return { status: outcome.status, message: outcome.message, reads, ...pages };
}

/**
 * The approval facts of the reads that waited for a card, in request order: one per tool,
 * governing integration, server tool, and cause. So `mcp.call` on two providers, or on two tools
 * of one server, stays two facts, and two causes of one tool stay two facts. Each server tool has
 * its own rule (ADR-0130 amendment (c)), so the model must see each one.
 */
function approvalFactsOf(ledger: readonly HostCallEntry[]): ApprovalCauseFact[] {
  const byRule = new Map<string, ApprovalCauseFact>();

  for (const entry of ledger.toSorted((a, b) => a.index - b.index)) {
    const cause = entry.approvalCause;

    if (cause === undefined) continue;

    const { reason } = cause;

    const rule =
      reason.cause === "high_risk"
        ? ""
        : `${reason.integration}:${reason.serverTool?.connectionId ?? ""}:${reason.serverTool?.remoteName ?? ""}`;

    const key = `${reason.toolName}:${rule}:${reason.cause}`;

    if (!byRule.has(key)) byRule.set(key, approvalCauseFact(cause));
  }

  return [...byRule.values()].slice(0, MAX_APPROVAL_FACTS);
}

/** The oldest `version` of a stored result that a load delivered: its ISO fetch time. */
function oldestLoadedFetchOf(ledger: readonly HostCallEntry[]): string | undefined {
  const times = ledger
    .filter((entry) => entry.kind === "executed")
    .flatMap((entry) => entry.evidence?.refs ?? [])
    .flatMap((ref) =>
      ref.kind === "record" && ref.store === RESULT_HANDLE_EVIDENCE_STORE && ref.version
        ? [ref.version]
        : [],
    )
    .toSorted();

  return times[0];
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
