import {
  STANDING_INSTRUCTION_KEY,
  STANDING_INSTRUCTION_SCHEMA_VERSION,
  SUPPRESSION_EFFECTS,
  hasSuppressionEffect,
  missingSuppressionEffects,
  standingInstructionValueSchema,
  type ObservationSource,
  type StandingInstructionValue,
  type SuppressionEffect,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { sha256Canonical } from "@alfred/db/hash";
import { rejectedInferences, userFacts } from "@alfred/db/schemas";
import { and, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { emitReplicachePokes } from "@alfred/assistant/triggers";
import { insertObservation } from "./observations";
import { normalizeSenderEmail } from "./sender-email";
import { valueSignature } from "./signature";
import { memorySourceSchema, type MemorySource } from "./types";

export { normalizeSenderEmail } from "./sender-email";

export const STANDING_INSTRUCTION_LIST_LIMIT = 100;

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
    return {
      ok: true,
      status: "already_exists",
      factId: existing.factId,
      instruction: existing.value,
    };
  }

  const row = await db().transaction(async (tx) => {
    const [inserted] = await tx
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

    if (!inserted) return null;

    await appendStandingInstructionObservation(
      {
        userId: parsed.userId,
        operation: "remember",
        factId: inserted.id,
        instruction,
        source,
      },
      tx,
    );

    return inserted;
  });

  if (!row) throw new Error("[memory.standing-instructions] insert returned no row");
  emitReplicachePokes([parsed.userId]);

  return {
    ok: true,
    status: "remembered",
    factId: row.id,
    instruction,
  };
}

export async function listActiveSuppressionInstructions(
  userId: string,
  effect?: SuppressionEffect,
): Promise<ActiveSuppressionInstruction[]> {
  const facts = await db()
    .select({ id: userFacts.id, value: userFacts.value, validFrom: userFacts.validFrom })
    .from(userFacts)
    .where(activeStandingInstructionsWhere(userId))
    .orderBy(desc(userFacts.validFrom));

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
// Each successful mutation also appends a `user_standing_instruction`
// observation in the same transaction so ADR-0067's observation log can replay
// this surface even while `user_facts` remains the live projection.

/** One active standing instruction, flattened for the model to reference by `factId`. */
export interface StandingInstructionSummary {
  factId: string;
  action: StandingInstructionValue["action"];
  target: StandingInstructionValue["target"];
  effects: StandingInstructionValue["effects"];
  directive: string;
  validFrom: Date;
}

export interface StandingInstructionListResult {
  instructions: StandingInstructionSummary[];
  totalActive: number;
  truncated: boolean;
  limit: number;
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

/** Currently-active standing instructions for model management, newest first and capped. */
export async function listStandingInstructions(
  userId: string,
): Promise<StandingInstructionListResult> {
  const instructions = await listActiveSuppressionInstructions(userId);
  const capped = instructions.slice(0, STANDING_INSTRUCTION_LIST_LIMIT);

  return {
    instructions: capped.map(summarizeStandingInstruction),
    totalActive: instructions.length,
    truncated: instructions.length > capped.length,
    limit: STANDING_INSTRUCTION_LIST_LIMIT,
  };
}

function summarizeStandingInstruction(
  instruction: ActiveSuppressionInstruction,
): StandingInstructionSummary {
  return {
    factId: instruction.factId,
    action: instruction.value.action,
    target: instruction.value.target,
    effects: instruction.value.effects,
    directive: instruction.value.directive,
    validFrom: instruction.validFrom,
  };
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
  reason?: string | null | undefined;
  source?: MemorySource | undefined;
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

    await appendStandingInstructionObservation(
      {
        userId: args.userId,
        operation: "forget",
        factId: args.factId,
        instruction: parsed.data,
        reason: args.reason ?? null,
        source: args.source,
      },
      tx,
    );

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

  const edited = await supersedeStandingInstruction({
    userId: parsed.userId,
    factId: parsed.factId,
    nextValue,
    previousValue: existing.value,
    source: parsed.source,
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

/**
 * Adopt every registered {@link SUPPRESSION_EFFECTS} member on an active
 * standing instruction that predates one.
 *
 * This is a REPAIR, not a policy change, and the reason is in the write path:
 * `rememberSenderSuppression` stores `effects: [...SUPPRESSION_EFFECTS]`
 * unconditionally, so the stored array is a snapshot of the registry at write
 * time — never a choice the user made between effects. An instruction written
 * before an effect existed therefore under-states what the user asked for, and
 * the gap widens every time a new consumer registers. Measured on prod
 * 2026-09-16: twelve investment-sender suppressions whose `phrasing` says "do
 * not tag stock-related emails as urgent" carried no effect that could reach a
 * category, so the label kept saying `action_needed`.
 *
 * Supersedes rather than updates in place — same chain, same observation, same
 * reversibility as {@link editStandingInstruction} — so the widening is
 * auditable and undoable. `directive` and `phrasing` are carried VERBATIM: this
 * never reinterprets the user's words, it only widens which consumers read them.
 *
 * Idempotent: an instruction already carrying every registered effect is
 * skipped, so a re-run after a third effect lands repairs only the new gap.
 */
export async function adoptRegisteredSuppressionEffects(args: {
  userId: string;
  source?: MemorySource | undefined;
  /**
   * Preloaded active snapshot (e.g. the caller's preview list). When given the
   * repair upgrades from THIS snapshot instead of re-reading, so a preview
   * printed from the same list cannot disagree with the write.
   */
  active?: readonly ActiveSuppressionInstruction[] | undefined;
}): Promise<{ upgraded: string[]; skipped: number }> {
  const active = args.active ?? (await listActiveSuppressionInstructions(args.userId));
  const upgraded: string[] = [];
  let skipped = 0;

  for (const instruction of active) {
    const missing = missingSuppressionEffects(instruction.value);

    if (missing.length === 0) {
      skipped += 1;
      continue;
    }

    const nextValue = standingInstructionValueSchema.parse({
      ...instruction.value,
      effects: [...SUPPRESSION_EFFECTS],
    });

    const source: MemorySource = args.source ?? { kind: "user" };

    const inserted = await supersedeStandingInstruction({
      userId: args.userId,
      factId: instruction.factId,
      nextValue,
      previousValue: instruction.value,
      source,
    });

    if (inserted) upgraded.push(inserted.id);
  }

  if (upgraded.length > 0) emitReplicachePokes([args.userId]);

  return { upgraded, skipped };
}

/**
 * The single supersede body behind `editStandingInstruction` and
 * `adoptRegisteredSuppressionEffects`: close the active row (`edited`), insert
 * the successor (`supersedesId`), and append the `user_standing_instruction`
 * observation in one transaction so the widening stays auditable and reversible.
 */
async function supersedeStandingInstruction(args: {
  userId: string;
  factId: string;
  nextValue: StandingInstructionValue;
  previousValue: StandingInstructionValue;
  source?: MemorySource | undefined;
}): Promise<{ id: string } | null> {
  return db().transaction(async (tx) => {
    const [closed] = await tx
      .update(userFacts)
      .set({
        status: "edited",
        validUntil: sql`now()`,
        rowVersion: sql`${userFacts.rowVersion} + 1`,
      })
      .where(activeStandingInstructionWhere(args.userId, args.factId))
      .returning({ id: userFacts.id });

    if (!closed) return null;

    const [inserted] = await tx
      .insert(userFacts)
      .values({
        userId: args.userId,
        key: STANDING_INSTRUCTION_KEY,
        value: args.nextValue,
        confidence: 1,
        status: "confirmed",
        source: args.source ?? { kind: "user" },
        validFrom: sql`now()`,
        validUntil: null,
        supersedesId: args.factId,
      })
      .returning({ id: userFacts.id });

    if (!inserted) return null;

    await appendStandingInstructionObservation(
      {
        userId: args.userId,
        operation: "edit",
        factId: inserted.id,
        previousFactId: args.factId,
        instruction: args.nextValue,
        previousInstruction: args.previousValue,
        source: args.source,
      },
      tx,
    );

    return inserted;
  });
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
  return and(eq(userFacts.id, factId), activeStandingInstructionsWhere(userId));
}

function activeStandingInstructionsWhere(userId: string) {
  return and(
    eq(userFacts.userId, userId),
    eq(userFacts.key, STANDING_INSTRUCTION_KEY),
    eq(userFacts.status, "confirmed"),
    lte(userFacts.validFrom, sql`now()`),
    or(isNull(userFacts.validUntil), gt(userFacts.validUntil, sql`now()`)),
  );
}

function instructionFromFact(fact: {
  id: string;
  value: unknown;
  validFrom: Date;
}): ActiveSuppressionInstruction | null {
  const parsed = standingInstructionValueSchema.safeParse(fact.value);

  if (!parsed.success) return null;

  return {
    factId: fact.id,
    value: parsed.data,
    validFrom: fact.validFrom,
  };
}

type StandingInstructionObservationOperation = "remember" | "edit" | "forget";

async function appendStandingInstructionObservation(
  args: {
    userId: string;
    operation: StandingInstructionObservationOperation;
    factId: string;
    previousFactId?: string | null;
    instruction: StandingInstructionValue;
    previousInstruction?: StandingInstructionValue | null;
    reason?: string | null;
    source?: MemorySource | undefined;
  },
  tx: Parameters<typeof insertObservation>[1],
): Promise<void> {
  const source = args.source ?? { kind: "user" as const };

  const payload = {
    operation: args.operation,
    factId: args.factId,
    previousFactId: args.previousFactId ?? null,
    instruction: args.instruction,
    previousInstruction: args.previousInstruction ?? null,
    reason: args.reason ?? null,
    source,
  };

  const evidenceHash = sha256Canonical(payload);

  await insertObservation(
    {
      userId: args.userId,
      source: observationSourceForMemorySource(source),
      kind: "user_standing_instruction",
      occurredAt: new Date(),
      familyKey: `standing_instruction:${args.operation}:${args.factId}:${evidenceHash.slice(0, 32)}`,
      evidenceHash,
      subjectIdentity: { kind: "user" },
      payload,
      schemaVersion: 1,
      reducerVersion: 1,
    },
    tx,
  );
}

function observationSourceForMemorySource(source: MemorySource): ObservationSource {
  return source.kind === "user" ? "user" : "alfred_chat";
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
