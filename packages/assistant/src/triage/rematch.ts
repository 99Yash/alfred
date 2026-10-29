import { meteredGenerateObject, route } from "@alfred/ai";
import {
  canonicalJson,
  extractGmailDocumentBody,
  mapConcurrent,
  parseGmailDocumentMetadata,
  type StandingInstructionScopeResult,
  type TriageInstructionEvaluation,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents, emailTriage, standingInstructionSetRevisions } from "@alfred/db/schemas";
import { logger } from "@alfred/logging";
import { and, desc, eq, gte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { enqueueTriageRelabel } from "@alfred/assistant/connections/ingestion";
import { standingInstructions, type MailStandingInstructions } from "../knowledge";
import {
  TRIAGE_BODY_MAX_CHARS,
  TRIAGE_INSTRUCTION_MATCH_OUTPUT_TOKENS,
  TRIAGE_REMATCH_CONCURRENCY,
  TRIAGE_REMATCH_MAX_ROWS,
  TRIAGE_REMATCH_WINDOW_HOURS,
  TRIAGE_REQUEST_TIMEOUT_MS,
} from "./constants";
import { deriveEffectiveTriage } from "./effective";
import {
  fitStandingScopeInstructions,
  readStandingScopeMatches,
  standingScopeCoversRule,
  triageInstructionMatchOutputSchema,
  type TriageInstructionMatchOutput,
} from "./standing-scope";
import {
  parseTriageEvaluationColumns,
  updateTriageEvaluation,
  type TriageEvaluationUpdate,
  type TriageRow,
} from "./store";

/**
 * The re-match job (ADR-0113, "Re-match after a change"). After an instruction write, it
 * brings the stored scope results of recent mail up to the current instruction set:
 *  - a scoped instruction with no current result for a document gets one match-only cheap call;
 *  - every row gets its cached effective result derived again, so a removal or a target-only
 *    change costs no model call.
 * A failed call leaves the state `unknown`, and the job throws at the end, so BullMQ retries it.
 */

const rematchOutputSchema = z.object({
  instructionMatches: z.array(triageInstructionMatchOutputSchema),
});

const REMATCH_SYSTEM_PROMPT = [
  "You decide which of the user's standing instructions are about one email. Alfred applies them in code after your answer.",
  "Alfred already classified the email. Do not classify it again.",
  "For each instruction whose scope this email is about, add one entry to `instructionMatches`: `id` (copied exactly), `reason` (one short line, under 20 words), and `covers`. Leave out every instruction whose scope does not fit. An empty list is a normal answer.",
  standingScopeCoversRule("the stored verdict"),
].join("\n");

/** The row and document fields the job reads, newest ingest first. */
async function loadRematchRows(userId: string) {
  const since = new Date(Date.now() - TRIAGE_REMATCH_WINDOW_HOURS * 60 * 60 * 1000);

  return db()
    .select({
      sourceThreadId: emailTriage.sourceThreadId,
      documentId: documents.id,
      category: emailTriage.category,
      modelVerdict: emailTriage.modelVerdict,
      instructionEvaluation: emailTriage.instructionEvaluation,
      accountId: documents.accountId,
      metadata: documents.metadata,
      title: documents.title,
      content: documents.content,
      authoredAt: documents.authoredAt,
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

type RematchRow = Awaited<ReturnType<typeof loadRematchRows>>[number];

type LoadedMail = Extract<MailStandingInstructions, { kind: "loaded" }>;

/** One match-only call. Tests and probes inject it. */
export type RunRematchMatch = (input: {
  userId: string;
  documentId: string;
  prompt: string;
}) => Promise<readonly TriageInstructionMatchOutput[]>;

const defaultRunMatch: RunRematchMatch = async ({ userId, documentId, prompt }) => {
  const result = await meteredGenerateObject(
    {
      model: route("cheap").model(),
      schema: rematchOutputSchema,
      instructions: REMATCH_SYSTEM_PROMPT,
      prompt,
      temperature: 0,
      maxOutputTokens: TRIAGE_INSTRUCTION_MATCH_OUTPUT_TOKENS,
      timeout: { totalMs: TRIAGE_REQUEST_TIMEOUT_MS },
    },
    {
      role: "triage",
      userId,
      name: "triage.standing_rematch",
      requestMeta: { purpose: "triage.standing_rematch", documentId },
    },
  );

  return result.output.instructionMatches;
};

/**
 * The verdict the `covers` rule reads. A row with no model verdict (from before ADR-0113, or
 * the classifier fallback) shows its cached category, which is the best record it has.
 */
function rematchPrompt(row: RematchRow, verdict: TriageRow["modelVerdict"], lines: string[]) {
  const meta = parseGmailDocumentMetadata(row.metadata);
  const { from, to, cc } = meta;

  const body = extractGmailDocumentBody(row.content, { from, to, cc, subject: row.title });

  const content =
    body.length > TRIAGE_BODY_MAX_CHARS
      ? body.slice(0, TRIAGE_BODY_MAX_CHARS) + "\n[…truncated]"
      : body;

  const stored = verdict
    ? {
        category: verdict.category,
        documentAsk: verdict.documentAsk,
        todoSuggestion: verdict.todoSuggestion,
      }
    : { category: row.category };

  return [
    "=== The user's standing instructions with a scope ===",
    ...lines,
    "",
    "=== The stored verdict ===",
    JSON.stringify(stored),
    "",
    ...(from ? [`From: ${from}`] : []),
    ...(to ? [`To: ${to}`] : []),
    ...(cc ? [`Cc: ${cc}`] : []),
    ...(row.authoredAt ? [`Date: ${row.authoredAt.toISOString()}`] : []),
    "",
    "=== Subject ===",
    row.title?.trim() || "(no subject)",
    "",
    "=== Body ===",
    content,
  ].join("\n");
}

/**
 * The stored scopes for the current scoped instructions, with each fresh result in place of
 * the stored one. A stored result at a later instruction revision wins: an edit landed during
 * the call. A result for an instruction that is no longer a candidate drops.
 */
function mergeScopes(
  mail: LoadedMail,
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

/** The new evaluation and cache for the locked row, or null when nothing changed. */
function nextEvaluation(
  row: TriageRow,
  documentId: string,
  mail: LoadedMail,
  fresh: readonly StandingInstructionScopeResult[],
): TriageEvaluationUpdate | null {
  const stored = row.instructionEvaluation;
  const scopes = mergeScopes(mail, stored, fresh);

  const instructionEvaluation: TriageInstructionEvaluation = {
    setRevision: Math.max(stored?.setRevision ?? 0, mail.setRevision),
    scopes,
  };

  const { result } = deriveEffectiveTriage({
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

  return unchanged ? null : { instructionEvaluation, ...result };
}

export interface RematchCounts {
  rows: number;
  /** Rows that got a match-only call. */
  called: number;
  /** Fresh `matched` results. */
  matched: number;
  /** Scoped instructions still `unknown` after the job: past the allowance, or a failed call. */
  unknownLeft: number;
  failed: number;
  cacheUpdated: number;
  relabeled: number;
}

/**
 * Re-match one user's recent mail against the current instruction set. On success it records
 * the set revision it read in `rematched_revision`. A failed call throws at the end, after the
 * other rows are written, so a retry repeats only what is still `unknown`.
 */
export async function rematchStandingInstructions(args: {
  userId: string;
  runMatch?: RunRematchMatch;
}): Promise<RematchCounts> {
  const { userId } = args;
  const runMatch = args.runMatch ?? defaultRunMatch;

  const set = await standingInstructions({ userId, onReadFailure: "throw" });
  const rows = await loadRematchRows(userId);

  const counts: RematchCounts = {
    rows: rows.length,
    called: 0,
    matched: 0,
    unknownLeft: 0,
    failed: 0,
    cacheUpdated: 0,
    relabeled: 0,
  };

  await mapConcurrent(rows, TRIAGE_REMATCH_CONCURRENCY, async (row) => {
    const metadata = parseGmailDocumentMetadata(row.metadata);
    const mail = set.forMail({ sender: metadata.from ?? null, accountId: row.accountId });

    const evaluation = parseTriageEvaluationColumns(row);

    // Only `unknown` is read here, and it depends on the evaluation alone.
    const { unknown } = deriveEffectiveTriage({
      triage: {
        documentId: row.documentId,
        category: row.category,
        documentAsk: null,
        todoSuggestion: null,
        todoDecision: null,
        ...evaluation,
      },
      documentId: row.documentId,
      instructions: mail,
    });

    let fresh: StandingInstructionScopeResult[] = [];

    if (unknown.length > 0) {
      const { sent, lines } = fitStandingScopeInstructions(unknown);

      counts.unknownLeft += unknown.length - sent.length;

      if (sent.length > 0) {
        counts.called += 1;

        try {
          const output = await runMatch({
            userId,
            documentId: row.documentId,
            prompt: rematchPrompt(row, evaluation.modelVerdict, lines),
          });

          fresh = readStandingScopeMatches(sent, output).scopes;
          counts.matched += fresh.filter((scope) => scope.state === "matched").length;
        } catch (err) {
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

    if (written === null) return;

    counts.cacheUpdated += 1;

    if (written.update.category === written.previous.category) return;

    try {
      await enqueueTriageRelabel(userId, row.sourceThreadId);
      counts.relabeled += 1;
    } catch (err) {
      logger.warn(
        { err, userId, sourceThreadId: row.sourceThreadId },
        "[triage.rematch] relabel enqueue failed",
      );
    }
  });

  logger.info(
    { userId, setRevision: set.setRevision, ...counts },
    `[triage.rematch] user=${userId} rows=${counts.rows} called=${counts.called} matched=${counts.matched} unknownLeft=${counts.unknownLeft} failed=${counts.failed} cacheUpdated=${counts.cacheUpdated} relabeled=${counts.relabeled}`,
  );

  if (counts.failed > 0) {
    throw new Error(
      `[triage.rematch] ${counts.failed} match call(s) failed for user=${userId}; their states stay unknown until a retry`,
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
export async function usersBehindRematch(): Promise<{ userId: string; revision: number }[]> {
  return db()
    .select({
      userId: standingInstructionSetRevisions.userId,
      revision: standingInstructionSetRevisions.revision,
    })
    .from(standingInstructionSetRevisions)
    .where(
      sql`${standingInstructionSetRevisions.revision} > ${standingInstructionSetRevisions.rematchedRevision}`,
    );
}
