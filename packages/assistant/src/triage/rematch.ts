import { meteredGenerateObject, route } from "@alfred/ai";
import {
  canonicalJson,
  mapConcurrent,
  parseGmailDocumentMetadata,
  toMessage,
  type GmailDocumentMetadata,
  type StandingInstructionScopeResult,
  type TriageInstructionEvaluation,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { gmailMailboxWritesEnabled } from "@alfred/env/server";
import { documents, emailTriage, standingInstructionSetRevisions } from "@alfred/db/schemas";
import { logger } from "@alfred/logging";
import { and, desc, eq, gt, gte, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { enqueueTriageRelabel } from "@alfred/assistant/connections/ingestion";
import {
  standingInstructions,
  standingInstructionsOf,
  type ActiveStandingInstruction,
  type LoadedMailStandingInstructions,
} from "../knowledge";
import { triageEmailBody, triageEmailHeaderLines, type TriageEmailDocument } from "./classify";
import {
  TRIAGE_INSTRUCTION_MATCH_OUTPUT_TOKENS,
  TRIAGE_REMATCH_CONCURRENCY,
  TRIAGE_REMATCH_MAX_ROWS,
  TRIAGE_REMATCH_WINDOW_HOURS,
  TRIAGE_REQUEST_TIMEOUT_MS,
} from "./constants";
import { currentScopeResults, deriveEffectiveTriage } from "./effective";
import {
  fitStandingScopeInstructions,
  readStandingScopeMatches,
  STANDING_SCOPE_SECTION_HEADER,
  standingScopeMatchRules,
  triageInstructionMatchOutputSchema,
} from "./standing-scope";
import {
  parseTriageEvaluationColumns,
  updateTriageEvaluation,
  type TriageEvaluationChange,
  type TriageRow,
} from "./store";

/*
 * The re-match job (ADR-0113, "Re-match after a change"). It brings the stored scope results
 * of recent mail up to the current instruction set:
 *  - a scoped instruction with no current result for a document gets one match-only cheap call;
 *  - every row gets its cached effective result derived again, so a removal or a target-only
 *    change costs no model call.
 */

const rematchOutputSchema = z.object({
  instructionMatches: z.array(triageInstructionMatchOutputSchema),
});

const REMATCH_SYSTEM_PROMPT = [
  "You decide which of the user's standing instructions are about one email. Alfred applies them in code after your answer.",
  "Alfred already classified the email. Do not classify it again.",
  ...standingScopeMatchRules({ lead: "For", verdict: "the stored verdict" }),
].join("\n");

/** The row and document fields the job reads, newest ingest first. */
async function loadRematchRows(userId: string) {
  const since = new Date(Date.now() - TRIAGE_REMATCH_WINDOW_HOURS * 60 * 60 * 1000);

  return db()
    .select({
      sourceThreadId: emailTriage.sourceThreadId,
      documentId: documents.id,
      category: emailTriage.category,
      appliedLabelId: emailTriage.appliedLabelId,
      modelVerdict: emailTriage.modelVerdict,
      instructionEvaluation: emailTriage.instructionEvaluation,
      accountId: documents.accountId,
      metadata: documents.metadata,
      title: documents.title,
      content: documents.content,
      authoredAt: documents.authoredAt,
      // Before the limit, so the job can report the rows past the cap.
      inWindow: sql<number>`count(*) over ()`.mapWith(Number),
    })
    .from(emailTriage)
    .innerJoin(
      documents,
      and(eq(documents.id, emailTriage.documentId), eq(documents.userId, emailTriage.userId)),
    )
    .where(
      and(
        eq(emailTriage.userId, userId),
        ne(emailTriage.source, "user"),
        gte(documents.ingestedAt, since),
      ),
    )
    .orderBy(desc(documents.ingestedAt))
    .limit(TRIAGE_REMATCH_MAX_ROWS);
}

async function matchScopes(args: {
  userId: string;
  documentId: string;
  prompt: string;
  signal: AbortSignal;
}) {
  const result = await meteredGenerateObject(
    {
      model: route("cheap").model(),
      schema: rematchOutputSchema,
      instructions: REMATCH_SYSTEM_PROMPT,
      prompt: args.prompt,
      temperature: 0,
      maxOutputTokens: TRIAGE_INSTRUCTION_MATCH_OUTPUT_TOKENS,
      timeout: { totalMs: TRIAGE_REQUEST_TIMEOUT_MS },
      abortSignal: args.signal,
    },
    {
      role: "triage",
      userId: args.userId,
      name: "triage.standing_rematch",
      requestMeta: { purpose: "triage.standing_rematch", documentId: args.documentId },
    },
  );

  return result.output.instructionMatches;
}

/** The document fields one match-only prompt reads. */
type RematchPromptDocument = Omit<TriageEmailDocument, "metadata"> & {
  metadata: GmailDocumentMetadata;
};

/**
 * The prompt for one match-only call. A row with no model verdict (from before ADR-0113, or
 * the classifier fallback) shows its cached category to the `covers` rule, which is the best
 * record it has. A document with no triage row for it shows no category.
 */
function rematchPrompt(
  document: RematchPromptDocument,
  verdict: TriageRow["modelVerdict"],
  cachedCategory: TriageRow["category"] | null,
  instructionLines: readonly string[],
) {
  const stored = verdict
    ? {
        category: verdict.category,
        documentAsk: verdict.documentAsk,
        todoSuggestion: verdict.todoSuggestion,
      }
    : { category: cachedCategory ?? "not classified" };

  return [
    STANDING_SCOPE_SECTION_HEADER,
    ...instructionLines,
    "",
    "=== The stored verdict ===",
    JSON.stringify(stored),
    "",
    ...triageEmailHeaderLines(document),
    "",
    "=== Subject ===",
    document.title?.trim() || "(no subject)",
    "",
    "=== Body ===",
    triageEmailBody(document),
  ].join("\n");
}

/**
 * The stored scopes for the current scoped instructions, with each fresh result in place of
 * the stored one. A stored result at a later instruction revision wins: an edit landed during
 * the call. A result for an instruction that is no longer a candidate drops.
 */
function mergeScopes(
  mail: LoadedMailStandingInstructions,
  stored: TriageInstructionEvaluation | null,
  fresh: readonly StandingInstructionScopeResult[],
): StandingInstructionScopeResult[] {
  const storedById = new Map(stored?.scopes.map((scope) => [scope.instructionId, scope]));
  const freshById = new Map(fresh.map((scope) => [scope.instructionId, scope]));

  return mail.scoped.flatMap((instruction) => {
    const id = instruction.value.instructionId;
    const old = storedById.get(id);
    const next = freshById.get(id);

    if (next && (!old || next.revision >= old.revision)) return [next];

    return old ? [old] : [];
  });
}

/** Scope order does not count: triage writes them in prompt order. */
function scopesKey(scopes: readonly StandingInstructionScopeResult[]): string {
  return canonicalJson([...scopes].sort((a, b) => a.instructionId.localeCompare(b.instructionId)));
}

/**
 * The new evaluation and cache for the locked row, with the floor audit as its history
 * evidence, or null when nothing changed.
 */
function nextEvaluation(
  row: TriageRow,
  documentId: string,
  mail: LoadedMailStandingInstructions,
  fresh: readonly StandingInstructionScopeResult[],
): TriageEvaluationChange | null {
  const stored = row.instructionEvaluation;
  const scopes = mergeScopes(mail, stored, fresh);

  const instructionEvaluation: TriageInstructionEvaluation = {
    setRevision: Math.max(stored?.setRevision ?? 0, mail.setRevision),
    scopes,
  };

  const { result, floor } = deriveEffectiveTriage({
    triage: { ...row, instructionEvaluation },
    documentId,
    instructions: mail,
  });

  if (result === null) return null;

  const cached = {
    category: row.category,
    documentAsk: row.documentAsk,
    todoSuggestion: row.todoSuggestion,
    todoDecision: row.todoDecision,
  };

  // `setRevision` alone is not a change: no reader decides on it.
  const unchanged =
    scopesKey(scopes) === scopesKey(stored?.scopes ?? []) &&
    canonicalJson(result) === canonicalJson(cached);

  if (unchanged) return null;

  return {
    update: { instructionEvaluation, ...result },
    setRevision: mail.setRevision,
    floor,
  };
}

interface RematchCounts {
  rows: number;
  /** Rows in the window past `TRIAGE_REMATCH_MAX_ROWS`. Their states stay `unknown`. */
  pastCap: number;
  /** Rows that got a match-only call. */
  called: number;
  /** Fresh `matched` results. */
  matched: number;
  /**
   * Scoped instructions still `unknown` after the job: past the allowance, a failed call, or no
   * decision from the model.
   */
  unknownLeft: number;
  failed: number;
  cacheUpdated: number;
  /** Relabels enqueued: a changed category, or a label still behind its category. */
  relabeled: number;
  relabelFailed: number;
}

/**
 * Re-match one user's recent mail against the current instruction set, and record the set
 * revision it read in `rematched_revision`. A failed call or relabel enqueue throws at the
 * end, after the other rows are written, so a retry repeats only what is still `unknown`.
 * On the final attempt the job records the revision anyway: the failed states stay `unknown`
 * (ADR-0113 rule 4), and the log counts them.
 *
 * The relabel marker is durable: a changed category clears `appliedLabelId` in the same
 * transaction. So each run enqueues a relabel for every row in its window whose label is
 * behind, not only for the rows it changed. A retry after a failed enqueue, or after a stop
 * between the commit and the enqueue, then finds the work again.
 */
export async function rematchStandingInstructions(args: {
  userId: string;
  signal: AbortSignal | undefined;
  finalAttempt: boolean;
}): Promise<RematchCounts> {
  const { userId } = args;

  const set = await standingInstructions({ userId, onReadFailure: "throw" });
  const rows = await loadRematchRows(userId);

  const counts: RematchCounts = {
    rows: rows.length,
    pastCap: Math.max(0, (rows[0]?.inWindow ?? 0) - rows.length),
    called: 0,
    matched: 0,
    unknownLeft: 0,
    failed: 0,
    cacheUpdated: 0,
    relabeled: 0,
    relabelFailed: 0,
  };

  // With mailbox writes off no label is ever applied, so a null `appliedLabelId` is not a
  // label behind its category, and a relabel would do nothing.
  const relabels = gmailMailboxWritesEnabled();

  await mapConcurrent(
    rows,
    TRIAGE_REMATCH_CONCURRENCY,
    async (row, scope) => {
      const metadata = parseGmailDocumentMetadata(row.metadata);
      const mail = set.forMail({ sender: metadata.from ?? null, accountId: row.accountId });

      const evaluation = parseTriageEvaluationColumns(row);
      const { unknown } = currentScopeResults(evaluation.instructionEvaluation, mail.scoped);

      let fresh: StandingInstructionScopeResult[] = [];

      if (unknown.length > 0) {
        const { sent, lines } = fitStandingScopeInstructions(unknown);

        counts.unknownLeft += unknown.length - sent.length;

        if (sent.length > 0) {
          counts.called += 1;

          try {
            const output = await matchScopes({
              userId,
              documentId: row.documentId,
              prompt: rematchPrompt(
                { ...row, metadata },
                evaluation.modelVerdict,
                row.category,
                lines,
              ),
              signal: scope.signal,
            });

            fresh = readStandingScopeMatches(sent, output).scopes;
            counts.matched += fresh.filter((result) => result.state === "matched").length;
            // A sent instruction that the model did not decide stays `unknown`.
            counts.unknownLeft += sent.length - fresh.length;
          } catch (err) {
            // A cancelled job stops. It is not a failed call.
            if (scope.signal.aborted) throw err;

            counts.failed += 1;
            counts.unknownLeft += sent.length;
            logger.warn(
              { err, userId, documentId: row.documentId },
              "[triage.rematch] match call failed",
            );
          }
        }
      }

      const written = await updateTriageEvaluation({
        userId,
        sourceThreadId: row.sourceThreadId,
        documentId: row.documentId,
        next: (locked) => nextEvaluation(locked, row.documentId, mail, fresh),
      });

      if (written !== null) counts.cacheUpdated += 1;

      const labelBehind = written
        ? written.update.category !== written.previous.category ||
          written.previous.appliedLabelId === null
        : row.appliedLabelId === null;

      if (!relabels || !labelBehind) return;

      try {
        await enqueueTriageRelabel(userId, row.sourceThreadId);
        counts.relabeled += 1;
      } catch (err) {
        counts.relabelFailed += 1;
        logger.warn(
          { err, userId, sourceThreadId: row.sourceThreadId },
          "[triage.rematch] relabel enqueue failed",
        );
      }
    },
    args.signal ? { signal: args.signal } : {},
  );

  logger.info(
    { userId, setRevision: set.setRevision, ...counts },
    `[triage.rematch] user=${userId} rows=${counts.rows} pastCap=${counts.pastCap} called=${counts.called} matched=${counts.matched} unknownLeft=${counts.unknownLeft} failed=${counts.failed} cacheUpdated=${counts.cacheUpdated} relabeled=${counts.relabeled} relabelFailed=${counts.relabelFailed}`,
  );

  if (counts.failed > 0 || counts.relabelFailed > 0) {
    if (!args.finalAttempt) {
      throw new Error(
        `[triage.rematch] ${counts.failed} match call(s) and ${counts.relabelFailed} relabel enqueue(s) failed for user=${userId}; a retry repeats them`,
      );
    }

    logger.warn(
      {
        userId,
        setRevision: set.setRevision,
        failed: counts.failed,
        relabelFailed: counts.relabelFailed,
      },
      "[triage.rematch] final attempt: failed states stay unknown, and failed relabels stay behind, until the next instruction change",
    );
  }

  // The revision read before the instructions, so a write during the job leaves it behind.
  await db()
    .update(standingInstructionSetRevisions)
    .set({
      rematchedRevision: sql`GREATEST(${standingInstructionSetRevisions.rematchedRevision}, ${set.setRevision})`,
    })
    .where(eq(standingInstructionSetRevisions.userId, userId));

  return counts;
}

/** Users whose instruction set changed since their last finished re-match. */
export async function usersBehindRematch(): Promise<string[]> {
  const rows = await db()
    .select({ userId: standingInstructionSetRevisions.userId })
    .from(standingInstructionSetRevisions)
    .where(
      gt(
        standingInstructionSetRevisions.revision,
        standingInstructionSetRevisions.rematchedRevision,
      ),
    );

  return rows.map((row) => row.userId);
}

/**
 * The state of one proposed instruction for one stored mail, from a read-only preview.
 *  - `matched` / `not_matched`: the answer of the match-only call, as the re-match job stores it.
 *  - `target`: a sender-wide target hits, so code decides the match with no call.
 *  - `not_candidate`: the sender filter or the mailbox bound leaves the mail out, so the model
 *    never sees the instruction for it.
 *  - `unknown`: past the prompt allowance, or the call failed.
 */
export type StandingScopePreviewState =
  | StandingInstructionScopeResult
  | { state: "target"; instructionId: string }
  | { state: "not_candidate"; instructionId: string }
  | { state: "unknown"; instructionId: string };

export interface StandingScopePreview {
  documentId: string;
  results: StandingScopePreviewState[];
  /** The message of a failed call. Each instruction that the call carried is then `unknown`. */
  error: string | null;
}

/**
 * A read-only match-only pass over stored mail for instructions that are not stored yet. The
 * ADR-0113 migration review uses it to show what a scope matches before the owner writes it.
 * It uses the prompt and the rules of the re-match job, makes at most one cheap call for each
 * document, and writes nothing.
 */
export async function previewStandingScopeMatches(args: {
  userId: string;
  documentIds: readonly string[];
  instructions: readonly ActiveStandingInstruction[];
  signal?: AbortSignal | undefined;
}): Promise<StandingScopePreview[]> {
  if (args.documentIds.length === 0) return [];

  const set = standingInstructionsOf(args.instructions);

  const rows = await db()
    .select({
      documentId: documents.id,
      accountId: documents.accountId,
      metadata: documents.metadata,
      title: documents.title,
      content: documents.content,
      authoredAt: documents.authoredAt,
      triageDocumentId: emailTriage.documentId,
      category: emailTriage.category,
      modelVerdict: emailTriage.modelVerdict,
      instructionEvaluation: emailTriage.instructionEvaluation,
    })
    .from(documents)
    .leftJoin(
      emailTriage,
      and(
        eq(emailTriage.userId, documents.userId),
        eq(emailTriage.sourceThreadId, documents.sourceThreadId),
      ),
    )
    .where(and(eq(documents.userId, args.userId), inArray(documents.id, [...args.documentIds])));

  const previews: StandingScopePreview[] = [];

  await mapConcurrent(
    rows,
    TRIAGE_REMATCH_CONCURRENCY,
    async (row, scope) => {
      const metadata = parseGmailDocumentMetadata(row.metadata);
      const mail = set.forMail({ sender: metadata.from ?? null, accountId: row.accountId });
      const hitIds = new Set(mail.targetHits.map((hit) => hit.value.instructionId));
      const candidateIds = new Set(mail.scoped.map((candidate) => candidate.value.instructionId));
      const { sent, lines } = fitStandingScopeInstructions(mail.scoped);

      // The triage row describes this document only when it evaluated this document.
      const own = row.triageDocumentId === row.documentId;
      const verdict = own ? parseTriageEvaluationColumns(row).modelVerdict : null;

      let fresh: StandingInstructionScopeResult[] = [];
      let error: string | null = null;

      if (sent.length > 0) {
        try {
          const output = await matchScopes({
            userId: args.userId,
            documentId: row.documentId,
            prompt: rematchPrompt({ ...row, metadata }, verdict, own ? row.category : null, lines),
            signal: scope.signal,
          });

          fresh = readStandingScopeMatches(sent, output).scopes;
        } catch (err) {
          if (scope.signal.aborted) throw err;

          error = toMessage(err);
        }
      }

      const freshById = new Map(fresh.map((result) => [result.instructionId, result]));

      const results = args.instructions.map((instruction): StandingScopePreviewState => {
        const { instructionId } = instruction.value;

        if (hitIds.has(instructionId)) return { state: "target", instructionId };

        const answer = freshById.get(instructionId);

        if (answer) return answer;

        return candidateIds.has(instructionId)
          ? { state: "unknown", instructionId }
          : { state: "not_candidate", instructionId };
      });

      previews.push({ documentId: row.documentId, results, error });
    },
    args.signal ? { signal: args.signal } : {},
  );

  return previews;
}
