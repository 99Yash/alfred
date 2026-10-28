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

/** The exact item that gave the authority. Persisted as jsonb, so readers parse it with this schema. */
export const attributionAuthorityRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("message"), id: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("instruction"),
      id: z.string().min(1),
      /** Absent until instructions carry a revision (ADR-0113). */
      revision: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("approval"), id: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("policy"), code: z.enum(ATTRIBUTION_POLICY_CODES) }).strict(),
]);

export type AttributionAuthorityRef = z.infer<typeof attributionAuthorityRefSchema>;

type AuthorityRefOf<K extends AttributionAuthorityRef["kind"]> = Extract<
  AttributionAuthorityRef,
  { kind: K }
>;

type RequestAuthority = { authority: "user_request"; authorityRef: AuthorityRefOf<"message"> };

type InstructionAuthority = {
  authority: "instruction";
  authorityRef: AuthorityRefOf<"instruction">;
};

type PolicyAuthority = { authority: "policy"; authorityRef: AuthorityRefOf<"policy"> };

/**
 * An agent write names its run and its action. `toolCallId` is the tool call id, the Code Mode
 * host-call id (`<code.run id>#<requestIndex>`), or the step key (`<runId>:<stepId>:<attempt>`)
 * for a workflow step that writes without a tool call.
 *
 * `authority: null` is a chat tool write: dispatch does not yet pass the user message that asked
 * for it. #1588 checks that message at dispatch and removes the null.
 */
type AgentAttribution = { actor: "agent"; runId: string; toolCallId: string } & (
  | RequestAuthority
  | InstructionAuthority
  | PolicyAuthority
  | { authority: null; authorityRef: null }
);

type UserAttribution = { actor: "user"; authority: "user_direct"; authorityRef: null };

type SystemAttribution = { actor: "system" } & (InstructionAuthority | PolicyAuthority);

/** The record one write carries. `note` is detail for a person, never read by code. */
export type AttributionRecord<Cause extends string> = (
  | UserAttribution
  | AgentAttribution
  | SystemAttribution
) & { cause: Cause; note?: string | null };

/** The ref of a `policy` authority. */
export function policyAuthority(code: AttributionPolicyCode): PolicyAuthority {
  return { authority: "policy", authorityRef: { kind: "policy", code } };
}
