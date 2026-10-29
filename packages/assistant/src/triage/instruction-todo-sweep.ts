import { parseGmailDocumentMetadata } from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents, emailTriage } from "@alfred/db/schemas";
import { and, desc, eq, inArray } from "drizzle-orm";
import { standingInstructions } from "../knowledge";
import { deriveEffectiveTriage } from "./effective";
import { notSentGmailDocumentWhere } from "./sent-mail";
import { parseTriageEvaluationColumns } from "./store";

/**
 * The threads whose live todo this instruction blocks now (ADR-0113). Capture calls it before
 * it dismisses a todo, so the dismissal follows the same rule as the todo lane: the effective
 * result must block the todo, and the instruction must match. An exception that cancels the
 * block therefore keeps the todo. The decision reads the document that triage evaluated, else
 * the newest inbound message. A read failure throws, so nothing is dismissed.
 */
export async function threadsWhereInstructionBlocksTodo(args: {
  userId: string;
  instructionId: string;
  sourceThreadIds: readonly string[];
}): Promise<Set<string>> {
  if (args.sourceThreadIds.length === 0) return new Set();

  const threadIds = [...args.sourceThreadIds];

  const [instructions, triageRows, messages] = await Promise.all([
    standingInstructions({ userId: args.userId, onReadFailure: "throw" }),
    db()
      .select({
        sourceThreadId: emailTriage.sourceThreadId,
        documentId: emailTriage.documentId,
        category: emailTriage.category,
        modelVerdict: emailTriage.modelVerdict,
        instructionEvaluation: emailTriage.instructionEvaluation,
      })
      .from(emailTriage)
      .where(
        and(eq(emailTriage.userId, args.userId), inArray(emailTriage.sourceThreadId, threadIds)),
      ),
    db()
      .select({
        documentId: documents.id,
        sourceThreadId: documents.sourceThreadId,
        accountId: documents.accountId,
        metadata: documents.metadata,
      })
      .from(documents)
      .where(
        and(
          eq(documents.userId, args.userId),
          eq(documents.source, "gmail"),
          inArray(documents.sourceThreadId, threadIds),
          notSentGmailDocumentWhere(),
        ),
      )
      .orderBy(desc(documents.authoredAt)),
  ]);

  const triageByThread = new Map(triageRows.map((row) => [row.sourceThreadId, row]));
  const blocked = new Set<string>();

  for (const threadId of threadIds) {
    const triage = triageByThread.get(threadId) ?? null;
    const inThread = messages.filter((message) => message.sourceThreadId === threadId);

    const message =
      inThread.find((candidate) => candidate.documentId === triage?.documentId) ?? inThread[0];

    if (message === undefined) continue;

    const effective = deriveEffectiveTriage({
      // The block reads only the category and the evaluation, so the cached todo stays out.
      triage: triage
        ? {
            documentId: triage.documentId,
            category: triage.category,
            documentAsk: null,
            todoSuggestion: null,
            todoDecision: null,
            ...parseTriageEvaluationColumns(triage),
          }
        : null,
      documentId: message.documentId,
      instructions: instructions.forMail({
        sender: parseGmailDocumentMetadata(message.metadata).from ?? null,
        accountId: message.accountId,
      }),
    });

    const matched = effective.matches.some(
      (match) => match.value.instructionId === args.instructionId,
    );

    if (matched && effective.todoBlockedBy !== null) blocked.add(threadId);
  }

  return blocked;
}
