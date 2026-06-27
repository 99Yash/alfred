import {
  STANDING_INSTRUCTION_KEY,
  STANDING_INSTRUCTION_SCHEMA_VERSION,
  SUPPRESSION_EFFECTS,
  hasSuppressionEffect,
  standingInstructionValueSchema,
  type StandingInstructionValue,
  type SuppressionEffect,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { rejectedInferences, userFacts } from "@alfred/db/schemas";
import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { emitReplicachePokes } from "../../events/replicache-events";
import {
  resolveTodosForGmailSender,
  type ResolveTodosForGmailSenderResult,
} from "../todos/resolve";
import { recallActiveByKey, type FactRow } from "./facts";
import { normalizeSenderEmail } from "./sender-email";
import { valueSignature } from "./signature";
import { memorySourceSchema, type MemorySource } from "./types";

export { normalizeSenderEmail } from "./sender-email";

export interface ActiveSuppressionInstruction {
  factId: string;
  value: StandingInstructionValue;
  validFrom: Date;
}

export interface SenderSuppressionLookup {
  senderEmail: string | null | undefined;
  accountId?: string | null;
  effect: SuppressionEffect;
}

export type SenderSuppressionMatch = ActiveSuppressionInstruction & {
  matchedEmail: string;
  effect: SuppressionEffect;
};

export const rememberSenderSuppressionArgsSchema = z.object({
  userId: z.string().min(1),
  senderEmail: z.string().nullish(),
  senderLabel: z.string().nullish(),
  accountId: z.string().nullable().optional(),
  directive: z.string().nullish(),
  phrasing: z.string().nullish(),
  source: memorySourceSchema.optional(),
});
export type RememberSenderSuppressionArgs = z.infer<typeof rememberSenderSuppressionArgsSchema>;

export type RememberSenderSuppressionResult =
  | {
      ok: true;
      status: "remembered" | "already_exists";
      factId: string;
      instruction: StandingInstructionValue;
      resolvedTodos: ResolveTodosForGmailSenderResult;
    }
  | {
      ok: false;
      status: "needs_clarification";
      reason: "invalid_sender_email";
      message: string;
    };

export async function rememberSenderSuppression(
  args: RememberSenderSuppressionArgs,
): Promise<RememberSenderSuppressionResult> {
  const parsed = rememberSenderSuppressionArgsSchema.parse(args);
  const email = normalizeSenderEmail(parsed.senderEmail);
  if (!email) return senderClarification();

  const label = normalizeOptionalLabel(parsed.senderLabel);
  const accountId = normalizeOptionalLabel(parsed.accountId);
  const directive =
    normalizeOptionalLabel(parsed.directive) ??
    `Stop surfacing reminders and briefing items from ${label ?? email}.`;
  const source: MemorySource = parsed.source ?? { kind: "user" };
  const candidate = standingInstructionValueSchema.safeParse({
    schemaVersion: STANDING_INSTRUCTION_SCHEMA_VERSION,
    action: "suppress",
    surface: "open_loop",
    target: {
      kind: "sender_email",
      email,
      label,
      accountId,
    },
    effects: [...SUPPRESSION_EFFECTS],
    directive,
    phrasing: normalizeOptionalLabel(parsed.phrasing) ?? directive,
  });

  if (!candidate.success) return senderClarification();
  const instruction = candidate.data;

  const existing = await findActiveSenderSuppression(parsed.userId, {
    senderEmail: instruction.target.email,
    accountId: instruction.target.accountId,
    effect: "block_todo_suggestion",
  });
  if (
    existing &&
    SUPPRESSION_EFFECTS.every((effect) => hasSuppressionEffect(existing.value, effect))
  ) {
    const resolvedTodos = await resolveTodosForGmailSender({
      userId: parsed.userId,
      senderEmail: existing.value.target.email,
      accountId: existing.value.target.accountId,
      reason: "standing_instruction_sender_suppression",
    });
    return {
      ok: true,
      status: "already_exists",
      factId: existing.factId,
      instruction: existing.value,
      resolvedTodos,
    };
  }

  const [row] = await db()
    .insert(userFacts)
    .values({
      userId: parsed.userId,
      key: STANDING_INSTRUCTION_KEY,
      value: instruction,
      confidence: 1,
      status: "confirmed",
      source,
      validUntil: null,
    })
    .returning({ id: userFacts.id });

  if (!row) throw new Error("[memory.standing-instructions] insert returned no row");
  emitReplicachePokes([parsed.userId]);
  const resolvedTodos = await resolveTodosForGmailSender({
    userId: parsed.userId,
    senderEmail: instruction.target.email,
    accountId: instruction.target.accountId,
    reason: "standing_instruction_sender_suppression",
  });

  return {
    ok: true,
    status: "remembered",
    factId: row.id,
    instruction,
    resolvedTodos,
  };
}

export async function listActiveSuppressionInstructions(
  userId: string,
  effect?: SuppressionEffect,
): Promise<ActiveSuppressionInstruction[]> {
  const facts = await recallActiveByKey(userId, STANDING_INSTRUCTION_KEY, { limit: 200 });
  return facts
    .map(instructionFromFact)
    .filter((instruction): instruction is ActiveSuppressionInstruction => {
      if (!instruction) return false;
      if (instruction.value.action !== "suppress") return false;
      return effect ? hasSuppressionEffect(instruction.value, effect) : true;
    });
}

export async function findActiveSenderSuppression(
  userId: string,
  lookup: SenderSuppressionLookup,
): Promise<SenderSuppressionMatch | null> {
  const instructions = await listActiveSuppressionInstructions(userId, lookup.effect);
  return findSenderSuppression(instructions, lookup);
}

// ─── Management (user-driven: list / forget / edit) ─────────────────────────
//
// These are the chat-surface operations that let the user reshape Alfred's
// durable instructions in conversation. They are deliberately NOT reachable
// from background inference: extraction/triage call the fact layer's
// propose/supersede paths directly and never these — so a passive workflow can
// never destructively edit or delete what the user told Alfred to remember.
// "Delete" here is a soft reject (the row is marked `rejected`, never hard
// deleted); "edit" supersedes the old row with a new one (reversible chain).

/** One active standing instruction, flattened for the model to reference by `factId`. */
export interface StandingInstructionSummary {
  factId: string;
  action: StandingInstructionValue["action"];
  target: StandingInstructionValue["target"];
  effects: StandingInstructionValue["effects"];
  directive: string;
  validFrom: Date;
}

export type ForgetStandingInstructionResult =
  | { ok: true; status: "forgotten"; factId: string; instruction: StandingInstructionValue }
  | { ok: false; status: "not_found" };

export type EditStandingInstructionResult =
  | {
      ok: true;
      status: "edited";
      factId: string;
      previousFactId: string;
      instruction: StandingInstructionValue;
    }
  | { ok: true; status: "unchanged"; factId: string; instruction: StandingInstructionValue }
  | { ok: false; status: "not_found" };

export const editStandingInstructionArgsSchema = z.object({
  userId: z.string().min(1),
  factId: z.string().min(1),
  directive: z.string().nullish(),
  senderLabel: z.string().nullish(),
  source: memorySourceSchema.optional(),
});
export type EditStandingInstructionArgs = z.infer<typeof editStandingInstructionArgsSchema>;

/** All currently-active standing instructions for the user, newest first. */
export async function listStandingInstructions(
  userId: string,
): Promise<StandingInstructionSummary[]> {
  const instructions = await listActiveSuppressionInstructions(userId);
  return instructions.map((instruction) => ({
    factId: instruction.factId,
    action: instruction.value.action,
    target: instruction.value.target,
    effects: instruction.value.effects,
    directive: instruction.value.directive,
    validFrom: instruction.validFrom,
  }));
}

/**
 * Active lookup by id. Returns null when the id is unknown, belongs to another
 * user, points at a non-instruction fact, or is already retired — so the
 * management tools only ever touch the current standing instruction the model
 * saw in `list_instructions`, never an arbitrary/stale `user_facts` row.
 */
async function loadOwnedStandingInstruction(
  userId: string,
  factId: string,
): Promise<{ value: StandingInstructionValue } | null> {
  const [row] = await db()
    .select({ value: userFacts.value })
    .from(userFacts)
    .where(activeStandingInstructionWhere(userId, factId))
    .limit(1);
  if (!row) return null;
  const parsed = standingInstructionValueSchema.safeParse(row.value);
  return parsed.success ? { value: parsed.data } : null;
}

/** Soft-remove a standing instruction the user explicitly asked to drop. */
export async function forgetStandingInstruction(args: {
  userId: string;
  factId: string;
  reason?: string | null;
}): Promise<ForgetStandingInstructionResult> {
  const forgotten = await db().transaction(async (tx) => {
    const [old] = await tx
      .select({ value: userFacts.value })
      .from(userFacts)
      .where(activeStandingInstructionWhere(args.userId, args.factId))
      .limit(1);
    if (!old) return null;

    const parsed = standingInstructionValueSchema.safeParse(old.value);
    if (!parsed.success) return null;

    const [row] = await tx
      .update(userFacts)
      .set({
        status: "rejected",
        validUntil: sql`now()`,
        rowVersion: sql`${userFacts.rowVersion} + 1`,
      })
      .where(activeStandingInstructionWhere(args.userId, args.factId))
      .returning({ id: userFacts.id });
    if (!row) return null;

    await tx
      .insert(rejectedInferences)
      .values({
        userId: args.userId,
        key: STANDING_INSTRUCTION_KEY,
        valueSignature: valueSignature(parsed.data),
        proposedFactId: args.factId,
        reason: args.reason ?? null,
      })
      .onConflictDoNothing();

    return parsed.data;
  });
  if (!forgotten) return { ok: false, status: "not_found" };

  emitReplicachePokes([args.userId]);
  return { ok: true, status: "forgotten", factId: args.factId, instruction: forgotten };
}

/** Reframe an instruction's directive/label, superseding the old row with a new one. */
export async function editStandingInstruction(
  args: EditStandingInstructionArgs,
): Promise<EditStandingInstructionResult> {
  const parsed = editStandingInstructionArgsSchema.parse(args);
  const existing = await loadOwnedStandingInstruction(parsed.userId, parsed.factId);
  if (!existing) return { ok: false, status: "not_found" };

  const nextDirective = normalizeOptionalLabel(parsed.directive);
  // `phrasing` is verbatim user provenance — a reframe of the directive never
  // rewrites it. The label is editable, including clearing it (null).
  const nextLabel =
    parsed.senderLabel === undefined
      ? existing.value.target.label
      : normalizeOptionalLabel(parsed.senderLabel);

  const nextValue = standingInstructionValueSchema.parse({
    ...existing.value,
    directive: nextDirective ?? existing.value.directive,
    target: { ...existing.value.target, label: nextLabel },
  });

  if (
    nextValue.directive === existing.value.directive &&
    nextValue.target.label === existing.value.target.label
  ) {
    return {
      ok: true,
      status: "unchanged",
      factId: parsed.factId,
      instruction: existing.value,
    };
  }

  const edited = await db().transaction(async (tx) => {
    const [row] = await tx
      .update(userFacts)
      .set({
        status: "edited",
        validUntil: sql`now()`,
        rowVersion: sql`${userFacts.rowVersion} + 1`,
      })
      .where(activeStandingInstructionWhere(parsed.userId, parsed.factId))
      .returning({ id: userFacts.id });
    if (!row) return null;

    const [inserted] = await tx
      .insert(userFacts)
      .values({
        userId: parsed.userId,
        key: STANDING_INSTRUCTION_KEY,
        value: nextValue,
        confidence: 1,
        status: "confirmed",
        source: parsed.source ?? { kind: "user" },
        validFrom: sql`now()`,
        validUntil: null,
        supersedesId: parsed.factId,
      })
      .returning({ id: userFacts.id });
    return inserted ?? null;
  });
  if (!edited) return { ok: false, status: "not_found" };

  emitReplicachePokes([parsed.userId]);
  return {
    ok: true,
    status: "edited",
    factId: edited.id,
    previousFactId: parsed.factId,
    instruction: nextValue,
  };
}

export function findSenderSuppression(
  instructions: readonly ActiveSuppressionInstruction[],
  lookup: SenderSuppressionLookup,
): SenderSuppressionMatch | null {
  const email = normalizeSenderEmail(lookup.senderEmail);
  if (!email) return null;

  const accountId = lookup.accountId ?? null;
  for (const instruction of instructions) {
    const { value } = instruction;
    if (!hasSuppressionEffect(value, lookup.effect)) continue;
    if (value.target.kind !== "sender_email") continue;
    if (value.target.email !== email) continue;
    if (value.target.accountId !== null && value.target.accountId !== accountId) continue;
    return { ...instruction, matchedEmail: email, effect: lookup.effect };
  }

  return null;
}

function activeStandingInstructionWhere(userId: string, factId: string) {
  return and(
    eq(userFacts.id, factId),
    eq(userFacts.userId, userId),
    eq(userFacts.key, STANDING_INSTRUCTION_KEY),
    eq(userFacts.status, "confirmed"),
    lte(userFacts.validFrom, sql`now()`),
    or(isNull(userFacts.validUntil), gt(userFacts.validUntil, sql`now()`)),
  );
}

function instructionFromFact(fact: FactRow): ActiveSuppressionInstruction | null {
  const parsed = standingInstructionValueSchema.safeParse(fact.value);
  if (!parsed.success) return null;
  return {
    factId: fact.id,
    value: parsed.data,
    validFrom: fact.validFrom,
  };
}

function normalizeOptionalLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function senderClarification(): RememberSenderSuppressionResult {
  return {
    ok: false,
    status: "needs_clarification",
    reason: "invalid_sender_email",
    message: "I could not identify the sender address to suppress. Which sender should I use?",
  };
}
