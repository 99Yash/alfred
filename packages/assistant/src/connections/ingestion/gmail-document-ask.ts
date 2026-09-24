import { documentAskEvidenceSchema, isSentGmailMetadata } from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";
import { documentAskReducer, type DocumentAskObserveResult } from "../document-asks";

export interface ObserveGmailDocumentAskArgs {
  userId: string;
  /** The persisted Gmail mail row that owns the media job. */
  documentId: string;
  /** Provider identity seeds; the parent row remains authoritative. */
  messageId: string;
  accountId: string;
  threadId: string;
  evidence: readonly unknown[];
  observedAt: Date;
}

/**
 * The one media-completion hand-off to the document-ask owner. Registration,
 * database, and conditional-write faults propagate to the existing BullMQ retry
 * path; expected reducer no-ops return normally.
 */
export async function observeGmailDocumentAsk(
  args: ObserveGmailDocumentAskArgs,
): Promise<DocumentAskObserveResult> {
  const evidence = documentAskEvidenceSchema.array().parse(args.evidence);

  const rows = await db()
    .select({
      sourceId: documents.sourceId,
      accountId: documents.accountId,
      sourceThreadId: documents.sourceThreadId,
      authoredAt: documents.authoredAt,
      metadata: documents.metadata,
    })
    .from(documents)
    .where(
      and(
        eq(documents.id, args.documentId),
        eq(documents.userId, args.userId),
        eq(documents.source, "gmail"),
      ),
    )
    .limit(1);

  const parent = rows[0];

  if (!parent) return { kind: "noop", reason: "unowned_source" };

  if (
    !parent.accountId ||
    !parent.sourceThreadId ||
    parent.sourceId !== args.messageId ||
    parent.accountId !== args.accountId ||
    parent.sourceThreadId !== args.threadId
  ) {
    return { kind: "noop", reason: "malformed_source" };
  }

  const accountId = parent.accountId;
  const threadId = parent.sourceThreadId;

  return documentAskReducer.observe({
    userId: args.userId,
    carrier: {
      accountId,
      messageId: parent.sourceId,
      threadId,
      authoredAt: parent.authoredAt,
      isSent: isSentGmailMetadata(parent.metadata),
    },
    evidence,
    observedAt: args.observedAt,
  });
}
