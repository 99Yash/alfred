import {
  buildStandingInstructionTarget,
  classifyBareDomain,
  domainSchema,
  emailDomain,
  normalizeEmailAddress,
  renderStandingInstructionDirective,
  STANDING_INSTRUCTION_KEY,
  STANDING_INSTRUCTION_SCHEMA_VERSION,
  standingInstructionTargetKey,
  standingInstructionScopeRelation,
  standingInstructionTargetSpecificity,
  memorySourceSchema,
  standingInstructionValueSchema,
  SUPPRESSION_EFFECTS,
  targetMatchesSender,
  targetNamesOneMailbox,
  type MemorySource,
  type ObservationSource,
  type StandingInstructionDroppedInput,
  type StandingInstructionOverlap,
  type StandingInstructionScopeNarrowing,
  type StandingInstructionTarget,
  type StandingInstructionTargetKind,
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
import { valueSignature } from "./signature";

export const STANDING_INSTRUCTION_LIST_LIMIT = 100;

export interface ActiveSuppressionInstruction {
  factId: string;
  value: StandingInstructionValue;
  validFrom: Date;
}

export interface SenderSuppressionLookup {
  senderEmail: string | null | undefined;
  accountId?: string | null;
  /** Audit echo only: an active suppression binds every consumer, so this never filters. */
  effect: SuppressionEffect;
}

export type SenderSuppressionMatch = ActiveSuppressionInstruction & {
  matchedEmail: string;
  effect: SuppressionEffect;
  /** Which target kind matched. The only trace of whether a domain target ever fires. */
  matchedVia: StandingInstructionTargetKind;
};

export const rememberSenderSuppressionArgsSchema = z.object({
  userId: z.string().min(1),
  senderEmail: z.string().nullish(),
  senderLabel: z.string().nullish(),
  accountId: z.string().nullable().optional(),
  directive: z.string().nullish(),
  phrasing: z.string().nullish(),
  /** `"sender"` (default) binds one address; `"domain"` binds every address at its domain. */
  scope: z.enum(["sender", "domain"]).optional(),
  source: memorySourceSchema.optional(),
});

export type RememberSenderSuppressionArgs = z.infer<typeof rememberSenderSuppressionArgsSchema>;

export type RememberSenderSuppressionResult =
  | {
      ok: true;
      status: "remembered" | "already_exists";
      factId: string;
      instruction: StandingInstructionValue;
      /** Echo for the model reply. The todo sweep reads `instruction.target`, not this. */
      resolvedSenderEmail: string;
      /**
       * Active rows whose scope strictly contains or is contained by the target (ADR-0060 micro-decision 6).
       * Drawn from the snapshot that decided `status`, so it can miss a concurrent write:
       * the lock key ignores `accountId` and sender kind, and `now()` freezes at BEGIN.
       * Capped at {@link STANDING_INSTRUCTION_OVERLAP_LIMIT}; `overlapCount` has the total.
       */
      overlaps: readonly StandingInstructionOverlap[];
      overlapCount: number;
      /** Set when the caller asked for `scope:"domain"` but the rail stored one address. */
      scopeNarrowing: StandingInstructionScopeNarrowing | null;
      /** Inputs a class target cannot store: a `directive` or a `senderLabel`. */
      droppedInputs: readonly StandingInstructionDroppedInput[];
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
  const email = normalizeEmailAddress(parsed.senderEmail);

  if (!email) return senderClarification();

  const label = normalizeOptionalLabel(parsed.senderLabel);
  const accountId = normalizeOptionalLabel(parsed.accountId);

  // An unasked widening gets no narrowing reason.
  const widening = parsed.scope === "domain" ? widenToDomain(email) : null;
  const domain = widening?.domain ?? null;
  const scopeNarrowing = widening?.narrowing ?? null;

  const target = buildStandingInstructionTarget({ email, domain, label, accountId });

  // A domain rule covers senders the label does not name, so its sentence comes from the target alone.
  const modelDirective = normalizeOptionalLabel(parsed.directive);

  const directive =
    domain || modelDirective === null ? renderStandingInstructionDirective(target) : modelDirective;

  // Report what the domain branch ignored. Read the normalized values, so dropped whitespace is not reported.
  const droppedInputs: StandingInstructionDroppedInput[] = [];

  if (domain) {
    if (modelDirective !== null) droppedInputs.push("directive");

    if (label !== null) droppedInputs.push("senderLabel");
  }

  const source: MemorySource = parsed.source ?? { kind: "user" };

  const candidate = standingInstructionValueSchema.safeParse({
    schemaVersion: STANDING_INSTRUCTION_SCHEMA_VERSION,
    action: "suppress",
    surface: "open_loop",
    target,
    // Legacy write snapshot for schema compat. Readers derive membership and never branch on it.
    effects: [...SUPPRESSION_EFFECTS],
    directive,
    phrasing: normalizeOptionalLabel(parsed.phrasing) ?? directive,
  });

  if (!candidate.success) return senderClarification();
  const instruction = candidate.data;

  // Identity, not coverage: collapse only onto a row with this exact target and `accountId`.
  // A domain row that covers the sender must not block pinning the address.
  const active = await listActiveSuppressionInstructions(parsed.userId);
  const existing = findInstructionByTarget(active, instruction.target);

  if (existing) {
    return {
      ok: true,
      status: "already_exists",
      factId: existing.factId,
      // Rendered: this path never rewrites the row, so an old domain row would echo personal prose.
      instruction: readStandingInstruction(existing.value),
      resolvedSenderEmail: email,
      // Report from the snapshot this path decided on.
      ...findTargetOverlaps(active, instruction.target),
      scopeNarrowing,
      droppedInputs,
    };
  }

  const row = await db().transaction(async (tx) => {
    // Serialize concurrent remembers for the same (user, sender), else both insert.
    // Do not change the lock key text: a rolling deploy would then run unserialized.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${parsed.userId}:standing_instruction:${standingInstructionTargetKey(instruction.target)}`}, 0))`,
    );

    // Re-check inside the lock: the outer read raced with other inserters.
    const rivals = await tx
      .select({ id: userFacts.id, value: userFacts.value, validFrom: userFacts.validFrom })
      .from(userFacts)
      .where(activeStandingInstructionsWhere(parsed.userId))
      .orderBy(desc(userFacts.validFrom));

    const locked = rivals
      .map(instructionFromFact)
      .filter(
        (candidate): candidate is ActiveSuppressionInstruction =>
          candidate !== null && candidate.value.action === "suppress",
      );

    // The locked read is the snapshot both remaining paths report from.
    // It can still miss a concurrent row: `now()` freezes at BEGIN, so lock order is not time order.
    const overlaps = findTargetOverlaps(locked, instruction.target);
    const rival = findInstructionByTarget(locked, instruction.target);

    if (rival)
      return { id: rival.factId, instruction: rival.value, duplicate: true as const, overlaps };

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

    return { id: inserted.id, instruction, duplicate: false as const, overlaps };
  });

  if (!row) throw new Error("[memory.standing-instructions] insert returned no row");

  if (row.duplicate) {
    return {
      ok: true,
      status: "already_exists",
      factId: row.id,
      // Same reason as the unlocked echo above.
      instruction: readStandingInstruction(row.instruction),
      resolvedSenderEmail: email,
      ...row.overlaps,
      scopeNarrowing,
      droppedInputs,
    };
  }

  emitReplicachePokes([parsed.userId]);

  return {
    ok: true,
    status: "remembered",
    factId: row.id,
    instruction,
    resolvedSenderEmail: email,
    ...row.overlaps,
    scopeNarrowing,
    droppedInputs,
  };
}

/** The active instruction whose target is exactly this one, or null. */
function findInstructionByTarget(
  instructions: readonly ActiveSuppressionInstruction[],
  target: StandingInstructionTarget,
): ActiveSuppressionInstruction | null {
  const key = standingInstructionTargetKey(target);

  for (const instruction of instructions) {
    if (standingInstructionTargetKey(instruction.value.target) !== key) continue;

    if (instruction.value.target.accountId !== target.accountId) continue;

    return instruction;
  }

  return null;
}

/**
 * Two rails keep a domain target narrow:
 *   1. The server derives the domain from a resolved address, never from caller input.
 *   2. Only a `corporate_domain` from `classifyBareDomain` widens. It reads the bare
 *      domain, because the account form needs a verified hosted domain no sender has.
 * The grammar check runs first: zod's email pattern admits hosts `domainSchema` rejects,
 * and `classifyBareDomain` returns `null` for both invalid and unclassifiable domains.
 * A refusal is a narrowed write and must carry its reason.
 */
type DomainWidening =
  | { domain: string; narrowing: null }
  | { domain: null; narrowing: StandingInstructionScopeNarrowing };

function widenToDomain(email: string): DomainWidening {
  const candidateDomain = domainSchema.safeParse(emailDomain(email));

  if (!candidateDomain.success) return { domain: null, narrowing: "domain_unparseable" };

  if (classifyBareDomain({ domain: candidateDomain.data }) !== "corporate_domain") {
    return { domain: null, narrowing: "domain_not_single_organization" };
  }

  return { domain: candidateDomain.data, narrowing: null };
}

/** A prompt-budget cap, not a correctness one. `overlapCount` keeps the true total. */
const STANDING_INSTRUCTION_OVERLAP_LIMIT = 10;

/** Shared by both `already_exists` paths and the insert path. */
interface TargetOverlapReport {
  overlaps: StandingInstructionOverlap[];
  overlapCount: number;
}

/**
 * Active rows whose scope strictly contains, or is strictly contained by, `target`.
 * Strict, so the identity row never lists itself. Sorted by `validFrom` then `factId`,
 * because `Date` drops the microseconds Postgres stores.
 */
function findTargetOverlaps(
  instructions: readonly ActiveSuppressionInstruction[],
  target: StandingInstructionTarget,
): TargetOverlapReport {
  const matched: Array<
    ActiveSuppressionInstruction & { relation: StandingInstructionOverlap["relation"] }
  > = [];

  for (const instruction of instructions) {
    const relation = standingInstructionScopeRelation({
      of: instruction.value.target,
      relativeTo: target,
    });

    if (relation === null) continue;

    matched.push({ ...instruction, relation });
  }

  matched.sort((a, b) => {
    const byValidFrom = b.validFrom.getTime() - a.validFrom.getTime();

    if (byValidFrom !== 0) return byValidFrom;

    return a.factId < b.factId ? 1 : a.factId > b.factId ? -1 : 0;
  });

  return {
    overlaps: matched.slice(0, STANDING_INSTRUCTION_OVERLAP_LIMIT).map((instruction) => ({
      factId: instruction.factId,
      relation: instruction.relation,
      target: instruction.value.target,
      directive: readStandingInstructionDirective(instruction.value),
    })),
    overlapCount: matched.length,
  };
}

/** Every active `suppress` instruction. No effect filter: a suppression binds every consumer. */
export async function listActiveSuppressionInstructions(
  userId: string,
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

      return true;
    });
}

export async function findActiveSenderSuppression(
  userId: string,
  lookup: SenderSuppressionLookup,
): Promise<SenderSuppressionMatch | null> {
  const instructions = await listActiveSuppressionInstructions(userId);

  return findSenderSuppression(instructions, lookup);
}

// ─── Management (user-driven: list / forget / edit) ─────────────────────────
// Chat-only. Background inference never calls these, so it cannot edit or delete what
// the user said. Forget is a soft reject; edit supersedes. Each mutation appends a
// `user_standing_instruction` observation in the same transaction (ADR-0067).

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
      /** Edits a class row cannot take. Empty on an address row. */
      droppedInputs: readonly StandingInstructionDroppedInput[];
    }
  | {
      ok: true;
      status: "unchanged";
      factId: string;
      instruction: StandingInstructionValue;
      /** Edits the row could not take. */
      droppedInputs: readonly StandingInstructionDroppedInput[];
    }
  | { ok: false; status: "not_found" };

export const editStandingInstructionArgsSchema = z.object({
  userId: z.string().min(1),
  factId: z.string().min(1),
  directive: z.string().nullish(),
  senderLabel: z.string().nullish(),
  source: memorySourceSchema.optional(),
});

export type EditStandingInstructionArgs = z.infer<typeof editStandingInstructionArgsSchema>;

/** Active standing instructions, newest first, capped. */
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
    directive: readStandingInstructionDirective(instruction.value),
    validFrom: instruction.validFrom,
  };
}

/** A class row renders from its target, so an old row's address prose still reads as a class rule. */
function readStandingInstructionDirective(value: StandingInstructionValue): string {
  return targetNamesOneMailbox(value.target)
    ? value.directive
    : renderStandingInstructionDirective(value.target);
}

/**
 * The same rule for a whole row. `already_exists` echoes a row it never rewrites.
 * Returns the input unchanged for an address row.
 */
function readStandingInstruction(value: StandingInstructionValue): StandingInstructionValue {
  const directive = readStandingInstructionDirective(value);

  return directive === value.directive ? value : { ...value, directive };
}

/** Null for an unknown, foreign, non-instruction, or retired id. */
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

export async function forgetStandingInstruction(args: {
  userId: string;
  factId: string;
  reason?: string | null | undefined;
  source?: MemorySource | undefined;
}): Promise<ForgetStandingInstructionResult> {
  const forgotten = await db().transaction(async (tx) => {
    // The `status = 'confirmed'` guard is the concurrency control; the lock lets the loser see the retired row.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`standing_instruction:${args.userId}:${args.factId}`}, 0))`,
    );

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

/** Reframe a directive or label by superseding the row. */
export async function editStandingInstruction(
  args: EditStandingInstructionArgs,
): Promise<EditStandingInstructionResult> {
  const parsed = editStandingInstructionArgsSchema.parse(args);
  const existing = await loadOwnedStandingInstruction(parsed.userId, parsed.factId);

  if (!existing) return { ok: false, status: "not_found" };

  const target = existing.value.target;

  // A class row derives its sentence from its target and has no label. So a `directive`
  // edit reads `unchanged`, and a `senderLabel` edit is a no-op. Address rows take both.
  const requestedDirective = normalizeOptionalLabel(parsed.directive);

  const nextDirective = targetNamesOneMailbox(target)
    ? requestedDirective
    : renderStandingInstructionDirective(target);

  // Report the refused edits, else `edited` or `unchanged` reads as if they applied.
  const droppedInputs: StandingInstructionDroppedInput[] = [];

  if (!targetNamesOneMailbox(target)) {
    if (requestedDirective !== null) droppedInputs.push("directive");

    if (parsed.senderLabel !== undefined) droppedInputs.push("senderLabel");
  }

  // `phrasing` is the user's verbatim words; an edit never rewrites it.
  const nextValue = standingInstructionValueSchema.parse({
    ...existing.value,
    directive: nextDirective ?? existing.value.directive,
    target: targetNamesOneMailbox(target)
      ? {
          ...target,
          label:
            parsed.senderLabel === undefined
              ? target.label
              : normalizeOptionalLabel(parsed.senderLabel),
        }
      : target,
  });

  const nextLabelValue = targetNamesOneMailbox(nextValue.target) ? nextValue.target.label : null;

  const existingLabelValue = targetNamesOneMailbox(target) ? target.label : null;

  if (nextValue.directive === existing.value.directive && nextLabelValue === existingLabelValue) {
    return {
      ok: true,
      status: "unchanged",
      factId: parsed.factId,
      instruction: existing.value,
      droppedInputs,
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
    droppedInputs,
  };
}

/** Close the active row, insert the successor, and append the observation in one transaction. */
async function supersedeStandingInstruction(args: {
  userId: string;
  factId: string;
  nextValue: StandingInstructionValue;
  previousValue: StandingInstructionValue;
  source?: MemorySource | undefined;
}): Promise<{ id: string } | null> {
  return db().transaction(async (tx) => {
    // Same contract as `forgetStandingInstruction`: the loser reports `not_found`.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`standing_instruction:${args.userId}:${args.factId}`}, 0))`,
    );

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

/**
 * ADR-0060 micro-decision 8, made total: the more specific target wins, then the newer `validFrom`,
 * then the greater `factId`. Callers already filtered on `accountId`.
 */
function isStrongerSuppressionMatch(
  candidate: ActiveSuppressionInstruction,
  incumbent: ActiveSuppressionInstruction,
): boolean {
  const candidateSpecificity = standingInstructionTargetSpecificity(candidate.value.target);
  const incumbentSpecificity = standingInstructionTargetSpecificity(incumbent.value.target);

  if (candidateSpecificity !== incumbentSpecificity) {
    return candidateSpecificity > incumbentSpecificity;
  }

  const candidateValidFrom = candidate.validFrom.getTime();
  const incumbentValidFrom = incumbent.validFrom.getTime();

  if (candidateValidFrom !== incumbentValidFrom) {
    return candidateValidFrom > incumbentValidFrom;
  }

  return candidate.factId > incumbent.factId;
}

export function findSenderSuppression(
  instructions: readonly ActiveSuppressionInstruction[],
  lookup: SenderSuppressionLookup,
): SenderSuppressionMatch | null {
  const email = normalizeEmailAddress(lookup.senderEmail);

  if (!email) return null;

  const accountId = lookup.accountId ?? null;

  let best: ActiveSuppressionInstruction | null = null;

  for (const instruction of instructions) {
    // Unreachable while `suppress` is the only action; it guards the day a second one lands.
    if (instruction.value.action !== "suppress") continue;

    const { target } = instruction.value;

    // An active suppression binds every consumer; the stored `effects` array is not read.
    if (!targetMatchesSender(target, email, accountId)) continue;

    // ADR-0060 micro-decision 8: the most specific target wins, so a pinned address beats a newer domain mute.
    if (best === null || isStrongerSuppressionMatch(instruction, best)) best = instruction;
  }

  if (!best) return null;

  // Nothing renders `directive` from here today; rendering keeps a future reader on the class sentence.
  // `phrasing` stays as stored: it is the user's verbatim words.
  const value = targetNamesOneMailbox(best.value.target)
    ? best.value
    : { ...best.value, directive: renderStandingInstructionDirective(best.value.target) };

  return {
    ...best,
    value,
    matchedEmail: email,
    effect: lookup.effect,
    matchedVia: best.value.target.kind,
  };
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
