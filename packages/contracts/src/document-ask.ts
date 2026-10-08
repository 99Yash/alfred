import { z } from "zod";

/** Document kinds an inbound Gmail request can ask for. */
export const DOCUMENT_ASK_KINDS = ["resume", "portfolio"] as const;

export const documentAskKindSchema = z.enum(DOCUMENT_ASK_KINDS);

export type DocumentAskKind = z.infer<typeof documentAskKindSchema>;

/** `resolved` is final. */
export const DOCUMENT_ASK_STATUSES = ["active", "resolved"] as const;

export const documentAskStatusSchema = z.enum(DOCUMENT_ASK_STATUSES);

export type DocumentAskStatus = z.infer<typeof documentAskStatusSchema>;

/** The only evidence source the reducer accepts. */
export const documentAskEvidenceSourceSchema = z.literal("extracted_content");

export type DocumentAskEvidenceSource = z.infer<typeof documentAskEvidenceSourceSchema>;

/** The model proposes only the kind. Everything else comes from stored rows. */
export const documentAskProposalSchema = z
  .object({
    requestedKind: documentAskKindSchema,
  })
  .strict();

export type DocumentAskProposal = z.infer<typeof documentAskProposalSchema>;
