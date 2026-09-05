import {
  runStatusSchema,
  workflowReadinessOutputSchema,
  workflowRunHistoryTriggerSchema,
  workflowRunOutcomeSchema,
  type PersistedWorkflowReadinessProblem,
  type EffectReceipt,
  type RunStatus,
  type WorkflowRunHistory,
  type WorkflowRunHistoryRow,
  type WorkflowRunOutcome,
  type WorkflowRunRecovery,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { actionStagings, agentRuns, workflowRevisions, workflows } from "@alfred/db/schemas";
import {
  EFFECT_RECEIPT_CAP,
  effectReceiptColumns,
  toEffectReceipt,
} from "@alfred/assistant/execution";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { workflowRecoveryNavigation } from "./recovery-navigation";

/**
 * The run history behind the workflow detail page's History tab (#561). One
 * keyset page of a workflow's runs, newest first, each row carrying the typed
 * outcome frozen at its terminal write, the live effect ledger, the readiness
 * gaps a blocked run recorded, and the single recovery the product can offer.
 */

const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

export interface ListWorkflowRunHistoryArgs {
  userId: string;
  workflowId: string;
  cursor?: string | undefined;
  limit?: number | undefined;
}

/** Thrown when a cursor is not one this reader minted; the route maps it to 400. */
export class InvalidRunHistoryCursorError extends Error {
  constructor() {
    super("Invalid run history cursor");
    this.name = "InvalidRunHistoryCursorError";
  }
}

interface HistoryCursor {
  createdAt: Date;
  id: string;
}

function encodeCursor(cursor: HistoryCursor): string {
  return Buffer.from(`${cursor.createdAt.toISOString()}|${cursor.id}`, "utf8").toString(
    "base64url",
  );
}

function decodeCursor(raw: string): HistoryCursor {
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const separator = decoded.indexOf("|");
  if (separator <= 0) throw new InvalidRunHistoryCursorError();
  const createdAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (Number.isNaN(createdAt.getTime()) || id.length === 0) {
    throw new InvalidRunHistoryCursorError();
  }
  return { createdAt, id };
}

/**
 * Returns null when the workflow is not the caller's. A malformed cursor throws
 * {@link InvalidRunHistoryCursorError} rather than silently restarting at the
 * first page, which would loop a paginating client forever.
 */
export async function listWorkflowRunHistory(
  args: ListWorkflowRunHistoryArgs,
): Promise<WorkflowRunHistory | null> {
  const pageSize = Math.min(Math.max(args.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const cursor = args.cursor ? decodeCursor(args.cursor) : null;

  const [workflow] = await db()
    .select({
      id: workflows.id,
      slug: workflows.slug,
      currentRevisionId: workflows.currentRevisionId,
      publishedRevisionId: workflows.publishedRevisionId,
    })
    .from(workflows)
    .where(and(eq(workflows.id, args.workflowId), eq(workflows.userId, args.userId)))
    .limit(1);
  if (!workflow) return null;

  const runs = await db()
    .select({
      id: agentRuns.id,
      status: agentRuns.status,
      trigger: agentRuns.trigger,
      occurrenceKey: agentRuns.occurrenceKey,
      replayOfRunId: agentRuns.replayOfRunId,
      workflowRevisionId: agentRuns.workflowRevisionId,
      createdAt: agentRuns.createdAt,
      startedAt: agentRuns.startedAt,
      endedAt: agentRuns.endedAt,
      output: agentRuns.output,
      outcome: agentRuns.outcome,
      revisionNumber: workflowRevisions.revisionNumber,
    })
    .from(agentRuns)
    .leftJoin(
      workflowRevisions,
      and(
        eq(workflowRevisions.id, agentRuns.workflowRevisionId),
        eq(workflowRevisions.userId, agentRuns.userId),
      ),
    )
    .where(
      and(
        eq(agentRuns.userId, args.userId),
        eq(agentRuns.workflowSlug, workflow.slug),
        // Keyset on the same (created_at desc, id desc) order the history
        // index serves, so every page is one index range scan.
        cursor
          ? sql`(${agentRuns.createdAt}, ${agentRuns.id}) < (${cursor.createdAt}, ${cursor.id})`
          : undefined,
      ),
    )
    .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
    .limit(pageSize + 1);

  const page = runs.slice(0, pageSize);
  const last = page[page.length - 1];
  const nextCursor =
    runs.length > pageSize && last
      ? encodeCursor({ createdAt: last.createdAt, id: last.id })
      : null;

  const effectsByRun = await readEffectsByRun(page.map((run) => run.id));

  const items: WorkflowRunHistoryRow[] = page.map((run) => {
    const status = runStatusSchema.parse(run.status);
    const outcomeParsed = workflowRunOutcomeSchema.safeParse(run.outcome);
    const outcome = outcomeParsed.success ? outcomeParsed.data : null;
    const triggerParsed = workflowRunHistoryTriggerSchema.safeParse(run.trigger);
    const effects = effectsByRun.get(run.id) ?? [];
    const coverageGaps = status === "blocked" ? readCoverageGaps(run.output) : [];
    const revisionId = run.workflowRevisionId;
    const isPublished = revisionId !== null && revisionId === workflow.publishedRevisionId;
    return {
      id: run.id,
      occurrenceKey: run.occurrenceKey,
      replayOfRunId: run.replayOfRunId,
      trigger: triggerParsed.success ? triggerParsed.data : null,
      createdAt: run.createdAt.toISOString(),
      startedAt: run.startedAt?.toISOString() ?? null,
      endedAt: run.endedAt?.toISOString() ?? null,
      revisionId,
      revisionNumber: run.revisionNumber,
      isCurrent: revisionId !== null && revisionId === workflow.currentRevisionId,
      isPublished,
      status,
      outcome,
      effects: effects.slice(0, EFFECT_RECEIPT_CAP),
      effectsTruncated: effects.length > EFFECT_RECEIPT_CAP,
      coverageGaps,
      recovery: recoveryFor({
        workflowId: workflow.id,
        status,
        outcome,
        revisionId,
        isPublished,
        coverageGaps,
      }),
    };
  });

  return { items, nextCursor };
}

async function readEffectsByRun(runIds: string[]): Promise<Map<string, EffectReceipt[]>> {
  const byRun = new Map<string, EffectReceipt[]>();
  if (runIds.length === 0) return byRun;
  const rows = await db()
    .select({ runId: actionStagings.runId, ...effectReceiptColumns })
    .from(actionStagings)
    .where(and(inArray(actionStagings.runId, runIds), ne(actionStagings.riskTier, "no_risk")))
    .orderBy(asc(actionStagings.createdAt), asc(actionStagings.id));
  for (const row of rows) {
    const list = byRun.get(row.runId) ?? [];
    list.push(toEffectReceipt(row));
    byRun.set(row.runId, list);
  }
  return byRun;
}

function readCoverageGaps(output: unknown): PersistedWorkflowReadinessProblem[] {
  const parsed = workflowReadinessOutputSchema.safeParse(output);
  return parsed.success ? parsed.data.readiness : [];
}

/**
 * The one truthful next step for a run. The runtime cannot re-lease a terminal
 * run, so "retry this run" never appears: a failed or cancelled run offers a
 * fresh run (replay) and a blocked run offers the readiness recheck or the
 * OAuth hop the server owns. An unobserved write outranks everything: a retry
 * could duplicate it.
 */
function recoveryFor(args: {
  workflowId: string;
  status: RunStatus;
  outcome: WorkflowRunOutcome | null;
  revisionId: string | null;
  isPublished: boolean;
  coverageGaps: readonly PersistedWorkflowReadinessProblem[];
}): WorkflowRunRecovery {
  if (args.outcome?.kind === "unknown_write_outcome") return { kind: "none" };
  switch (args.status) {
    case "blocked": {
      if (!args.revisionId) return { kind: "none" };
      const navigation = workflowRecoveryNavigation({
        workflowId: args.workflowId,
        revisionId: args.revisionId,
        readiness: args.coverageGaps,
      });
      return navigation ?? { kind: "recheck", revisionId: args.revisionId };
    }
    case "failed":
    case "cancelled":
      return args.revisionId
        ? { kind: "run_again", revisionChoice: args.isPublished ? "original" : "latest" }
        : { kind: "inspect" };
    case "completed":
      return { kind: "inspect" };
    default:
      return { kind: "none" };
  }
}
