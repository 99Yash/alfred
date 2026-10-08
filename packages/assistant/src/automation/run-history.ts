import {
  runStatusSchema,
  WRITE_RISK_TIERS,
  workflowReadinessOutputSchema,
  workflowRunHistoryTriggerSchema,
  workflowRunOutcomeSchema,
  type PersistedWorkflowReadinessProblem,
  type EffectReceipt,
  type RunStatus,
  type WorkflowRunHistory,
  type WorkflowRunHistoryOutcome,
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
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { workflowRecoveryNavigation } from "./recovery-navigation";

/**
 * Run history for the workflow History tab (#561): one keyset page, newest first,
 * with each run's outcome, effect ledger, readiness gaps, and recovery.
 */

const DEFAULT_PAGE_SIZE = 20;

export const MAX_PAGE_SIZE = 50;

export interface ListWorkflowRunHistoryArgs {
  userId: string;
  workflowId: string;
  cursor?: string | undefined;
  limit?: number | undefined;
}

/** Not a cursor this reader minted. The route maps it to 400. */
export class InvalidRunHistoryCursorError extends Error {
  constructor() {
    super("Invalid run history cursor");
    this.name = "InvalidRunHistoryCursorError";
  }
}

/**
 * `created_at` stays as text with microseconds, never a `Date`: a `Date` drops to
 * milliseconds, and one triage batch creates many runs in the same millisecond.
 */
interface HistoryCursor {
  /** Exactly as `createdAtMicros` renders it. */
  createdAt: string;
  id: string;
}

const MICROSECOND_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

const createdAtMicros = sql<string>`to_char(${agentRuns.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

function encodeCursor(cursor: HistoryCursor): string {
  return Buffer.from(`${cursor.createdAt}|${cursor.id}`, "utf8").toString("base64url");
}

function decodeCursor(raw: string): HistoryCursor {
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const separator = decoded.indexOf("|");

  if (separator <= 0) throw new InvalidRunHistoryCursorError();
  const createdAt = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);

  if (!MICROSECOND_INSTANT.test(createdAt) || id.length === 0) {
    throw new InvalidRunHistoryCursorError();
  }

  return { createdAt, id };
}

/**
 * Null when the workflow is not the caller's. A bad cursor throws instead of
 * restarting at page one, which would loop a client forever.
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
      createdAtMicros,
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
        // Same order as the history index, so each page is one range scan. Cast in SQL, not via `Date`.
        cursor
          ? sql`(${agentRuns.createdAt}, ${agentRuns.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id})`
          : undefined,
      ),
    )
    .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
    .limit(pageSize + 1);

  const page = runs.slice(0, pageSize);
  const last = page[page.length - 1];

  const nextCursor =
    runs.length > pageSize && last
      ? encodeCursor({ createdAt: last.createdAtMicros, id: last.id })
      : null;

  const effectsByRun = await readEffectsByRun(page.map((run) => run.id));

  const items: WorkflowRunHistoryRow[] = page.map((run) => {
    const status = runStatusSchema.parse(run.status);
    const outcomeParsed = workflowRunOutcomeSchema.safeParse(run.outcome);
    const outcome = outcomeParsed.success ? outcomeParsed.data : null;
    const wireOutcome = outcome ? toHistoryOutcome(outcome) : null;
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
      outcome: wireOutcome,
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
    .where(
      and(
        inArray(actionStagings.runId, runIds),
        inArray(actionStagings.riskTier, WRITE_RISK_TIERS),
      ),
    )
    .orderBy(asc(actionStagings.createdAt), asc(actionStagings.id));

  for (const row of rows) {
    const list = byRun.get(row.runId) ?? [];
    list.push(toEffectReceipt(row));
    byRun.set(row.runId, list);
  }

  return byRun;
}

/** Drop the frozen receipt lists: the live ledger is the same list. */
function toHistoryOutcome(outcome: WorkflowRunOutcome): WorkflowRunHistoryOutcome {
  switch (outcome.kind) {
    case "completed": {
      const { effects: _effects, ...rest } = outcome;

      return rest;
    }

    case "cancelled": {
      const { completedEffects: _completedEffects, ...rest } = outcome;

      return rest;
    }

    default:
      return outcome;
  }
}

function readCoverageGaps(output: unknown): PersistedWorkflowReadinessProblem[] {
  const parsed = workflowReadinessOutputSchema.safeParse(output);

  return parsed.success ? parsed.data.readiness : [];
}

/**
 * The one honest next step. A terminal run cannot be retried, so failed or cancelled
 * offers a fresh run, and blocked offers a recheck or OAuth. An unobserved write
 * outranks all: a retry could duplicate it.
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
