import { z } from "zod";

/** The semantic document kinds an inbound Gmail request may ask for. */
export const DOCUMENT_ASK_KINDS = ["resume", "portfolio"] as const;

export const documentAskKindSchema = z.enum(DOCUMENT_ASK_KINDS);

export type DocumentAskKind = z.infer<typeof documentAskKindSchema>;

/** The dedicated document-ask lifecycle. `resolved` is absorbing. */
export const DOCUMENT_ASK_STATUSES = ["active", "resolved"] as const;

export const documentAskStatusSchema = z.enum(DOCUMENT_ASK_STATUSES);

export type DocumentAskStatus = z.infer<typeof documentAskStatusSchema>;

/** The only truthful local evidence provenance accepted by the reducer. */
export const documentAskEvidenceSourceSchema = z.literal("extracted_content");

export type DocumentAskEvidenceSource = z.infer<typeof documentAskEvidenceSourceSchema>;

/**
 * The classifier may propose only the semantic kind. Identity, Gmail direction,
 * carrier, and attachment evidence are owned by persisted rows, never by model
 * output.
 */
export const documentAskProposalSchema = z
  .object({
    requestedKind: documentAskKindSchema,
  })
  .strict();

export type DocumentAskProposal = z.infer<typeof documentAskProposalSchema>;
