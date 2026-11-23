import {
  extractGmailDocumentBody,
  ianaTimezoneSchema,
  parseGmailDocumentMetadata,
  replyDraftGatheredObjectSchema,
  replyDraftStyleSelectionSchema,
  UNCONFIRMED_CLAIM_LABEL,
  type ReplyDraftGatheredObject,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { describeCorrespondentHistory, readUserContext } from "@alfred/assistant/knowledge";
import { settings } from "@alfred/assistant/settings";
import { inZone } from "@alfred/assistant/time";
import { getThreadState } from "@alfred/assistant/triage";

// Bound context. The composer treats every source as an excerpt.
const SOURCE_MAX_CHARS = 20_000;

/**
 * Take whole records in priority order while they fit in `budget` characters. A record is never
 * cut: a cut can keep a value and drop the label that says it is unconfirmed (#1897 review).
 */
function takeWholeRecords(records: readonly string[], budget: number) {
  const taken: string[] = [];
  let used = 0;

  for (const record of records) {
    if (used + record.length > budget) continue;

    taken.push(record);
    used += record.length;
  }

  return { taken, used };
}

export const replyGatherSchema = z.object({
  subject: z.string(),
  senderHeader: z.string().nullable(),
  senderAddress: z.string().nullable(),
  inboundRecipients: z.object({ to: z.string().nullable(), cc: z.string().nullable() }),
  replyRecipients: z.object({ to: z.array(z.string()), cc: z.array(z.string()) }),
  authoredAt: z.string().nullable(),
  mailboxAddress: z.string().nullable(),
  audience: z.literal("generic"),
  now: z.string(),
  timezone: ianaTimezoneSchema,
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
}): Promise<ReplyGather> {
  const { document } = args;

  if (!document.sourceThreadId || !document.accountId) {
    throw new Error("[reply-drafting] gather requires a mailbox and Gmail thread");
  }

  // One bind, so the user-context preferences and the zone share one SELECT.
  const userSettings = settings({ userId: args.userId });

  const [userContext, timezone, thread] = await Promise.all([
    readUserContext(args.userId, {
      subjectEmail: args.sender ?? undefined,
      include: args.sender
        ? ["profile", "facts", "preferences", "people"]
        : ["profile", "facts", "preferences"],
      settings: userSettings,
    }),
    userSettings.timezone(),
    getThreadState({
      userId: args.userId,
      sourceThreadId: document.sourceThreadId,
      accountId: document.accountId,
      excludeDocumentId: document.id,
    }),
  ]);

  const now = new Date();
  const { people, facts: claims, recentMemory, ...ownerRest } = userContext;

  const history = people.map(
    (person) =>
      `Mail history for ${person.address}: ${describeCorrespondentHistory(person, timezone)}`,
  );

  // Each record is one complete fact string, and its status stays with its source: a confirmed
  // claim or the profile can support a statement; an unconfirmed claim or a model-written summary
  // cannot by itself (memory.md §9 Q6). Confirmed records take the budget first.
  const ownerRecords = [
    ...history,
    JSON.stringify({ profile: ownerRest.profile }),
    ...claims.filter((claim) => claim.label === undefined).map((claim) => JSON.stringify(claim)),
    ...ownerRest.preferences.map((preference) => JSON.stringify({ preference })),
    JSON.stringify({ activeIntegrations: ownerRest.activeIntegrations }),
  ];

  const weakRecords = [
    ...claims.filter((claim) => claim.label !== undefined).map((claim) => JSON.stringify(claim)),
    ...recentMemory.map((memory) => JSON.stringify({ ...memory, label: UNCONFIRMED_CLAIM_LABEL })),
  ];

  const owner = takeWholeRecords(ownerRecords, SOURCE_MAX_CHARS);
  const weak = takeWholeRecords(weakRecords, SOURCE_MAX_CHARS - owner.used);

  const unconfirmedSources: ReplyDraftGatheredObject[] =
    weak.taken.length > 0
      ? [
          {
            kind: "unconfirmed_claims",
            ref: `unconfirmed-claims:${args.userId}`,
            status: "resolved",
            facts: weak.taken,
          },
        ]
      : [];

  const body = extractGmailDocumentBody(document.content, {
    from: document.metadata.from,
    to: document.metadata.to,
    cc: document.metadata.cc,
    subject: document.title,
  });

  // Style stays outside the evidence: examples guide voice but cannot establish facts.
  const context = {
    subject: document.title ?? "",
    senderHeader: document.metadata.from ?? null,
    senderAddress: args.sender,
    inboundRecipients: { to: document.metadata.to ?? null, cc: document.metadata.cc ?? null },
    replyRecipients: { to: args.sender ? [args.sender] : [], cc: [] },
    authoredAt: document.authoredAt?.toISOString() ?? null,
    mailboxAddress: args.mailboxAddress,
    audience: "generic",
    now: now.toISOString(),
    timezone,
    localDate: inZone(timezone).day(now),
  } satisfies Omit<ReplyGather, "style" | "styleInstructions" | "sources">;

  return replyGatherSchema.parse({
    ...context,
    style: { kind: "style_missing" },
    styleInstructions: null,
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
        facts: owner.taken,
      },
      ...unconfirmedSources,
    ],
  } satisfies ReplyGather);
}
