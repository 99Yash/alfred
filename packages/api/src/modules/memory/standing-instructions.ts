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
import { userFacts } from "@alfred/db/schemas";
import { z } from "zod";
import { emitReplicachePokes } from "../../events/replicache-events";
import { recallActiveByKey, type FactRow } from "./facts";
import { memorySourceSchema, type MemorySource } from "./types";

const senderEmailSchema = z.string().trim().toLowerCase().pipe(z.email());

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
  if (existing && SUPPRESSION_EFFECTS.every((effect) => hasSuppressionEffect(existing.value, effect))) {
    return {
      ok: true,
      status: "already_exists",
      factId: existing.factId,
      instruction: existing.value,
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
      validFrom: new Date(),
      validUntil: null,
    })
    .returning({ id: userFacts.id });

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

export function normalizeSenderEmail(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;

  const angleAddress = raw.match(/<([^<>]+)>/)?.[1];
  const candidate = (angleAddress ?? raw).replace(/^mailto:/i, "").trim();
  const parsed = senderEmailSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
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
