import { db } from "@alfred/db";
import { chatAttachmentRepresentations } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

export const CHAT_ATTACHMENT_REPRESENTATION_VERSION = 1;
export const CHAT_MEDIA_ENRICHMENT_CYCLE_BUDGET_MICROUSD = 500_000;

const boundedText = z.string().max(20_000);
const evidenceSchema = z
  .object({
    kind: z.enum(["ocr", "transcript", "document_text", "chart", "visual", "metadata"]),
    text: boundedText,
  })
  .strict();

export const chatAttachmentRepresentationSchema = z
  .object({
    schemaVersion: z.literal(CHAT_ATTACHMENT_REPRESENTATION_VERSION),
    attachmentId: z.string().min(1),
    messageId: z.string().min(1),
    mime: z.string().min(1).max(255),
    visualDescription: boundedText.nullable(),
    ocrText: boundedText.nullable(),
    salientEntities: z.array(z.string().min(1).max(500)).max(100),
    evidence: z.array(evidenceSchema).max(100),
  })
  .strict();
export type ChatAttachmentRepresentation = z.infer<typeof chatAttachmentRepresentationSchema>;

export async function loadChatAttachmentRepresentation(
  attachmentId: string,
  representationVersion = CHAT_ATTACHMENT_REPRESENTATION_VERSION,
): Promise<ChatAttachmentRepresentation | null> {
  const [row] = await db()
    .select({ representation: chatAttachmentRepresentations.representation })
    .from(chatAttachmentRepresentations)
    .where(
      and(
        eq(chatAttachmentRepresentations.attachmentId, attachmentId),
        eq(chatAttachmentRepresentations.representationVersion, representationVersion),
        eq(chatAttachmentRepresentations.status, "ready"),
      ),
    )
    .limit(1);
  if (!row) return null;
  const parsed = chatAttachmentRepresentationSchema.safeParse(row.representation);
  return parsed.success ? parsed.data : null;
}

/** Claim one attachment/version once. Concurrent consumers reuse the same row. */
export async function claimChatAttachmentEnrichment(
  attachmentId: string,
  representationVersion = CHAT_ATTACHMENT_REPRESENTATION_VERSION,
): Promise<"claimed" | "existing"> {
  const rows = await db()
    .insert(chatAttachmentRepresentations)
    .values({ attachmentId, representationVersion, status: "pending" })
    .onConflictDoNothing({
      target: [
        chatAttachmentRepresentations.attachmentId,
        chatAttachmentRepresentations.representationVersion,
      ],
    })
    .returning({ attachmentId: chatAttachmentRepresentations.attachmentId });
  return rows.length === 1 ? "claimed" : "existing";
}

export async function persistChatAttachmentRepresentation(args: {
  representation: unknown;
  provider: string;
  model: string;
  estimatedCostMicrousd: number;
}): Promise<boolean> {
  if (!Number.isInteger(args.estimatedCostMicrousd) || args.estimatedCostMicrousd < 0) {
    throw new Error("estimatedCostMicrousd must be a non-negative integer");
  }
  const representation = chatAttachmentRepresentationSchema.parse(args.representation);
  const rows = await db()
    .update(chatAttachmentRepresentations)
    .set({
      status: "ready",
      representation,
      provider: args.provider,
      model: args.model,
      estimatedCostMicrousd: args.estimatedCostMicrousd,
      failureCategory: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(chatAttachmentRepresentations.attachmentId, representation.attachmentId),
        eq(chatAttachmentRepresentations.representationVersion, representation.schemaVersion),
        eq(chatAttachmentRepresentations.status, "pending"),
      ),
    )
    .returning({ attachmentId: chatAttachmentRepresentations.attachmentId });
  return rows.length === 1;
}

export function selectAttachmentsWithinEnrichmentBudget<
  T extends { estimatedCostMicrousd: number },
>(candidates: readonly T[], budgetMicrousd = CHAT_MEDIA_ENRICHMENT_CYCLE_BUDGET_MICROUSD): T[] {
  if (!Number.isInteger(budgetMicrousd) || budgetMicrousd < 0) {
    throw new Error("budgetMicrousd must be a non-negative integer");
  }
  let remaining = budgetMicrousd;
  const selected: T[] = [];
  for (const candidate of candidates) {
    if (!Number.isInteger(candidate.estimatedCostMicrousd) || candidate.estimatedCostMicrousd < 0) {
      throw new Error("candidate estimatedCostMicrousd must be a non-negative integer");
    }
    if (candidate.estimatedCostMicrousd > remaining) continue;
    selected.push(candidate);
    remaining -= candidate.estimatedCostMicrousd;
  }
  return selected;
}
