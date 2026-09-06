import {
  extractGmailDocumentBody,
  parseGmailDocumentMetadata,
  replyDraftGatheredObjectSchema,
  replyDraftStyleSelectionSchema,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { readUserContext } from "@alfred/assistant/knowledge";
import { getStyleProfile } from "@alfred/assistant/knowledge/style-profiles";
import { resolveTimezone } from "@alfred/assistant/settings";
import { inZone } from "@alfred/assistant/time";
import { getThreadState } from "@alfred/assistant/triage";

// Bound persisted/model context. The composer treats all sources as excerpts.
const SOURCE_MAX_CHARS = 20_000;

export const replyGatherSchema = z.object({
  subject: z.string(),
  senderHeader: z.string().nullable(),
  senderAddress: z.string().nullable(),
  inboundRecipients: z.object({ to: z.string().nullable(), cc: z.string().nullable() }),
  replyRecipients: z.object({ to: z.array(z.string()), cc: z.array(z.string()) }),
  authoredAt: z.string().nullable(),
  mailboxAddress: z.string().nullable(),
  audience: z.literal("generic"),
  relationship: z.string(),
  now: z.string(),
  timezone: z.string(),
  localDate: z.string(),
  style: replyDraftStyleSelectionSchema,
  styleInstructions: z.string().nullable(),
  sources: z.array(replyDraftGatheredObjectSchema),
});
export type ReplyGather = z.infer<typeof replyGatherSchema>;

/** Unlike triage's loader, a missing credential is a normal drafting outcome. */
export async function loadReplyDocument(userId: string, documentId: string) {
  const [document] = await db()
    .select()
    .from(documents)
    .where(and(eq(documents.userId, userId), eq(documents.id, documentId)))
    .limit(1);
  if (!document || document.source !== "gmail") return null;
  return { ...document, metadata: parseGmailDocumentMetadata(document.metadata) };
}

export async function gatherReplyContext(args: {
  userId: string;
  document: NonNullable<Awaited<ReturnType<typeof loadReplyDocument>>>;
  sender: string | null;
  mailboxAddress: string | null;
  relationship: string;
}): Promise<ReplyGather> {
  const { document } = args;
  if (!document.sourceThreadId || !document.accountId) {
    throw new Error("[reply-drafting] gather requires a mailbox and Gmail thread");
  }
  const [userContext, profile, timezone, thread] = await Promise.all([
    readUserContext(args.userId, {
      subjectEmail: args.sender ?? undefined,
      include: ["profile", "facts", "preferences", "entities", "relationships"],
    }),
    // #238 owns audience inference/materialization. Read the active generic
    // profile only; do not guess a more specific audience from prose.
    getStyleProfile(args.userId, "gmail", "generic"),
    resolveTimezone(args.userId),
    getThreadState({
      userId: args.userId,
      sourceThreadId: document.sourceThreadId,
      accountId: document.accountId,
      excludeDocumentId: document.id,
    }),
  ]);
  const now = new Date();
  const body = extractGmailDocumentBody(document.content, {
    from: document.metadata.from,
    to: document.metadata.to,
    cc: document.metadata.cc,
    subject: document.title,
  });
  // Both model calls cite this same context. Keep style instructions outside
  // the evidence: examples may guide voice but cannot establish facts.
  const context = {
    subject: document.title ?? "",
    senderHeader: document.metadata.from ?? null,
    senderAddress: args.sender,
    inboundRecipients: { to: document.metadata.to ?? null, cc: document.metadata.cc ?? null },
    replyRecipients: { to: args.sender ? [args.sender] : [], cc: [] },
    authoredAt: document.authoredAt?.toISOString() ?? null,
    mailboxAddress: args.mailboxAddress,
    audience: "generic",
    relationship: args.relationship,
    now: now.toISOString(),
    timezone,
    localDate: inZone(timezone).day(now),
  } satisfies Omit<ReplyGather, "style" | "styleInstructions" | "sources">;
  return replyGatherSchema.parse({
    ...context,
    style: profile ? { kind: "profile", styleProfileId: profile.id } : { kind: "style_missing" },
    styleInstructions: profile?.profileDoc ?? null,
    sources: [
      {
        kind: "reply_context",
        ref: `reply-context:${document.id}`,
        status: "resolved",
        facts: [JSON.stringify(context)],
      },
      {
        kind: "inbound_document",
        ref: document.id,
        status: "resolved",
        facts: [body.slice(0, SOURCE_MAX_CHARS)],
      },
      {
        kind: "thread_context",
        ref: document.sourceThreadId,
        status: "resolved",
        facts: thread.recentMessages.map((message) =>
          JSON.stringify({
            direction: message.direction,
            authoredAt: message.authoredAt?.toISOString() ?? null,
            excerpt: message.snippet,
          }),
        ),
      },
      {
        kind: "user_context",
        ref: args.userId,
        status: "resolved",
        facts: [JSON.stringify(userContext).slice(0, SOURCE_MAX_CHARS)],
      },
    ],
  } satisfies ReplyGather);
}
