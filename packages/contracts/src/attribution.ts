/**
 * The attribution record (ADR-0115). Each write that changes user-visible state names who did it
 * (`actor`), what permitted it (`authority`, `authorityRef`), which agent action did it (`runId`,
 * `toolCallId`), and why (`cause`, a closed code for each entity).
 */

import { z } from "zod";

// ─── Actor ─────────────────────────────────────────────────────────────────

/** `system` is deterministic code that no model chose to run: a floor, a reconciler, a reply detector. */
export const ATTRIBUTION_ACTORS = ["user", "agent", "system"] as const;

export type AttributionActor = (typeof ATTRIBUTION_ACTORS)[number];

// ─── Authority ─────────────────────────────────────────────────────────────

/**
 * - `user_direct`: a click in the UI. The request session is the proof, so it has no ref.
 * - `user_request`: a user-role chat message in the run's thread.
 * - `instruction`: a standing instruction.
 * - `policy`: a rule in code, named by a code in {@link ATTRIBUTION_POLICY_CODES}.
 */
export const ATTRIBUTION_AUTHORITIES = [
  "user_direct",
  "user_request",
  "instruction",
  "policy",
] as const;

export type AttributionAuthority = (typeof ATTRIBUTION_AUTHORITIES)[number];

/** A new rule that writes state is a new code here. */
export const ATTRIBUTION_POLICY_CODES = [
  /** Triage proposes a todo (ADR-0050). */
  "triage.todo_gate",
  /** The user replied on the thread, so `close-loop-todos` retracts the suggestion. */
  "todo.reply_retraction",
  /** A payment receipt matched the bill that the suggestion asked the user to pay. */
  "todo.payment_match",
] as const;

export type AttributionPolicyCode = (typeof ATTRIBUTION_POLICY_CODES)[number];

const messageRefSchema = z.object({ kind: z.literal("message"), id: z.string().min(1) }).strict();

const instructionRefSchema = z
  .object({
    kind: z.literal("instruction"),
    id: z.string().min(1),
    /** Absent until instructions carry a revision (ADR-0113). */
    revision: z.number().int().nonnegative().optional(),
  })
  .strict();

const approvalRefSchema = z.object({ kind: z.literal("approval"), id: z.string().min(1) }).strict();

const policyRefSchema = z
  .object({ kind: z.literal("policy"), code: z.enum(ATTRIBUTION_POLICY_CODES) })
  .strict();

/** The exact item that gave the authority. Persisted as jsonb, so readers parse it with this schema. */
export const attributionAuthorityRefSchema = z.discriminatedUnion("kind", [
  messageRefSchema,
  instructionRefSchema,
  approvalRefSchema,
  policyRefSchema,
]);

export type AttributionAuthorityRef = z.infer<typeof attributionAuthorityRefSchema>;

// Each authority has exactly one ref kind. `todo_events_authority_ref_valid` enforces the same map.
const requestAuthorityShape = {
  authority: z.literal("user_request"),
  authorityRef: messageRefSchema,
};

const instructionAuthorityShape = {
  authority: z.literal("instruction"),
  authorityRef: instructionRefSchema,
};

const policyAuthorityShape = { authority: z.literal("policy"), authorityRef: policyRefSchema };

/**
 * An agent write names its run and its action. `toolCallId` is the tool call id, the Code Mode
 * host-call id (`<code.run id>#<requestIndex>`), or the step key (`<runId>:<stepId>:<attempt>`)
 * for a workflow step that writes without a tool call.
 */
const agentShape = {
  actor: z.literal("agent"),
  runId: z.string().min(1),
  toolCallId: z.string().min(1),
};

/**
 * The record one write carries, with its entity's `cause` codes. `note` is detail for a person,
 * never read by code. The `todo_events` checks enforce the same actor, authority, and ref rules
 * on each stored row.
 *
 * Agent `authority: null` is a chat tool write: dispatch does not yet pass the user message that
 * asked for it. #1588 checks that message at dispatch and removes the null.
 */
export function attributionRecordSchema<Cause extends string>(cause: z.ZodType<Cause>) {
  const tail = { cause, note: z.string().nullish() };

  return z.union([
    z
      .object({
        actor: z.literal("user"),
        authority: z.literal("user_direct"),
        authorityRef: z.null(),
        ...tail,
      })
      .strict(),
    z.object({ ...agentShape, ...requestAuthorityShape, ...tail }).strict(),
    z.object({ ...agentShape, ...instructionAuthorityShape, ...tail }).strict(),
    z.object({ ...agentShape, ...policyAuthorityShape, ...tail }).strict(),
    z.object({ ...agentShape, authority: z.null(), authorityRef: z.null(), ...tail }).strict(),
    z.object({ actor: z.literal("system"), ...instructionAuthorityShape, ...tail }).strict(),
    z.object({ actor: z.literal("system"), ...policyAuthorityShape, ...tail }).strict(),
  ]);
}

export type AttributionRecord<Cause extends string> = z.infer<
  ReturnType<typeof attributionRecordSchema<Cause>>
>;

type PolicyAuthority = Pick<
  Extract<AttributionRecord<string>, { authority: "policy" }>,
  "authority" | "authorityRef"
>;

/** The ref of a `policy` authority. */
export function policyAuthority(code: AttributionPolicyCode): PolicyAuthority {
  return { authority: "policy", authorityRef: { kind: "policy", code } };
}
