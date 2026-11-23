import { z } from "zod";
import { jsonObjectSchema } from "./user-model";

/** The source of a `user_preferences` or `memory_chunks` row. A claim (`user_facts`) uses the claim fields below. */
export const memorySourceSchema = z.object({
  kind: z.enum(["document", "chunk", "tool_call", "cold_start", "user", "agent"]),
  id: z.string().optional(),
  meta: jsonObjectSchema.optional(),
});

export type MemorySource = z.infer<typeof memorySourceSchema>;

// ---------------------------------------------------------------------------
// Claims (ADR-0123, docs/theory/memory.md §3)
// ---------------------------------------------------------------------------

/** Who made the claim: the user said it, or the agent concluded it. */
export const CLAIM_AUTHORS = ["user", "agent"] as const;

export const claimAuthorSchema = z.enum(CLAIM_AUTHORS);

export type ClaimAuthor = z.infer<typeof claimAuthorSchema>;

/** The user's own act on a surface. `confirm` keeps the author of the claim; `create` and `edit` make a user claim. */
export const USER_EDIT_ACTIONS = ["create", "edit", "confirm"] as const;

export type UserEditAction = (typeof USER_EDIT_ACTIONS)[number];

const chatMessageEvidenceSchema = z.object({
  kind: z.literal("chat_message"),
  /** A `chat_messages.id` of a user turn. */
  id: z.string().min(1),
});

const userEditEvidenceSchema = z.object({
  kind: z.literal("user_edit"),
  surface: z.literal("memory_page"),
  action: z.enum(USER_EDIT_ACTIONS),
  /** ISO time of the act. */
  at: z.string().min(1),
});

const documentEvidenceSchema = z.object({
  kind: z.literal("document"),
  /** A `documents.id`. */
  id: z.string().min(1),
});

const observationEvidenceSchema = z.object({
  kind: z.literal("observation"),
  /** An `observations.id`. */
  id: z.string().min(1),
});

/** A web page that the producer read. No text snapshot yet (memory step 5 adds it). */
const webPageEvidenceSchema = z.object({
  kind: z.literal("web_page"),
  url: z.string().min(1),
});

/** Evidence that only the user can give. A user claim cites at least one link of this kind. */
export const userClaimEvidenceSchema = z.discriminatedUnion("kind", [
  chatMessageEvidenceSchema,
  userEditEvidenceSchema,
]);

export type UserClaimEvidence = z.infer<typeof userClaimEvidenceSchema>;

/** The user's own act on the memory page. `at` is an ISO time. The server and the sync client share it. */
export function memoryPageEdit(action: UserEditAction, at: string) {
  return {
    kind: "user_edit",
    surface: "memory_page",
    action,
    at,
  } as const satisfies UserClaimEvidence;
}

/** One link from a claim to an item in the raw record. */
export const claimEvidenceSchema = z.discriminatedUnion("kind", [
  chatMessageEvidenceSchema,
  userEditEvidenceSchema,
  documentEvidenceSchema,
  observationEvidenceSchema,
  webPageEvidenceSchema,
]);

export type ClaimEvidence = z.infer<typeof claimEvidenceSchema>;

export type ClaimEvidenceKind = ClaimEvidence["kind"];

export const claimEvidenceListSchema = z.array(claimEvidenceSchema);

/** The pipeline that wrote a claim, the deployed commit, and the model. */
export const claimProducerSchema = z.object({
  /** For example `memory-extraction`, `system.remember`, `memory-page`, `cold-start`. */
  pipeline: z.string().min(1),
  /** The agent run that wrote it, when one did. */
  runId: z.string().min(1).nullable(),
  /** Null when the writer could not know it (rows before ADR-0123, a local run). */
  commit: z.string().min(1).nullable(),
  /** Null when no model wrote the claim. */
  model: z.string().min(1).nullable(),
});

export type ClaimProducer = z.infer<typeof claimProducerSchema>;

/**
 * The provenance of one claim write. A user claim cites evidence that only the user can give, so
 * a mail, a page, or an activity event can never make a user claim (#1889). An agent claim is
 * never confirmed at write; only the user's own act confirms it (memory.md §9 Q6).
 */
export type ClaimProvenance =
  | {
      readonly author: "user";
      readonly evidence: readonly [UserClaimEvidence, ...ClaimEvidence[]];
      readonly producer: ClaimProducer;
    }
  | {
      readonly author: "agent";
      readonly evidence: readonly [ClaimEvidence, ...ClaimEvidence[]];
      readonly producer: ClaimProducer;
    };

/** The provenance of a claim that the user made: a chat turn or the user's own edit. */
export type UserClaimProvenance = Extract<ClaimProvenance, { author: "user" }>;

/** The label that a reader shows next to a claim that the user has not confirmed. */
export const UNCONFIRMED_CLAIM_LABEL = "agent-concluded, not confirmed by you";
