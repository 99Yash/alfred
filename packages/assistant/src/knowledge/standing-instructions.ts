import {
  classifyEmailDomain,
  emailDomain,
  STANDING_INSTRUCTION_KEY,
  STANDING_INSTRUCTION_SCHEMA_VERSION,
  standingInstructionTargetKey,
  standingInstructionValueSchema,
  SUPPRESSION_EFFECTS,
  targetMatchesSender,
  type ObservationSource,
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
  /**
   * Audit echo only — membership is derived at read time, so this never
   * filters. An active suppression for the sender binds every consumer.
   * Kept so traces can name which consumer asked.
   */
  effect: SuppressionEffect;
}

export type SenderSuppressionMatch = ActiveSuppressionInstruction & {
  matchedEmail: string;
  effect: SuppressionEffect;
  /**
   * Which target kind decided the match — the one field that tells a trace
   * whether a domain target ever fires in production. An address match and a
   * domain match are otherwise indistinguishable downstream.
   */
  matchedVia: StandingInstructionTargetKind;
};

export const rememberSenderSuppressionArgsSchema = z.object({
  userId: z.string().min(1),
  senderEmail: z.string().nullish(),
  senderLabel: z.string().nullish(),
  accountId: z.string().nullable().optional(),
  directive: z.string().nullish(),
  phrasing: z.string().nullish(),
  /**
   * How wide the instruction binds. `"sender"` (the default) binds the one
   * address. `"domain"` binds every address at that address's domain.
   */
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
      /**
       * The address this write resolved, whatever the target kind stores. A
       * caller that follows up on the sender (todo dismissal) reads this
       * instead of `instruction.target.email`, which a domain target lacks.
       */
      resolvedSenderEmail: string;
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

  // Two rails keep a domain target from growing too wide, and both make the
  // bad target unrepresentable rather than merely unlikely:
  //   1. The caller never supplies a domain. The server derives it from an
  //      address the caller already resolved, so `co.in` cannot become a
  //      target — no sender has that address.
  //   2. Only a `corporate_domain` widens. `classifyEmailDomain` is the one
  //      place that answers "is this domain one organization's", and it also
  //      rejects consumer mailboxes, school and alumni domains, shared-hosting
  //      and disposable hosts, and mail-infrastructure hosts — every class
  //      where one domain carries unrelated senders. It reads the BARE domain,
  //      never `{ email }`: the address form demands a verified hosted domain
  //      the sender side never has, so it would answer `ambiguous_domain` for
  //      every real sender and no instruction would ever widen.
  const candidateDomain = parsed.scope === "domain" ? emailDomain(email) : null;

  const domain =
    candidateDomain && classifyEmailDomain({ domain: candidateDomain }) === "corporate_domain"
      ? candidateDomain
      : null;

  const target: StandingInstructionTarget = domain
    ? { kind: "sender_domain", domain, label, accountId }
    : { kind: "sender_email", email, label, accountId };

  // A domain rule covers senders the label does not name, so the stored
  // sentence names the DOMAIN. Phrasing it from the sender label would read
  // back as "…from Ben Book" for a rule that also binds everyone else at that
  // host — and the model reads this sentence, not the target.
  const directive =
    normalizeOptionalLabel(parsed.directive) ??
    (domain
      ? `Stop surfacing reminders and briefing items from any sender at ${domain}.`
      : `Stop surfacing reminders and briefing items from ${label ?? email}.`);

  const source: MemorySource = parsed.source ?? { kind: "user" };

  const candidate = standingInstructionValueSchema.safeParse({
    schemaVersion: STANDING_INSTRUCTION_SCHEMA_VERSION,
    action: "suppress",
    surface: "open_loop",
    target,
    // Legacy write snapshot, stamped for schema compat: readers derive
    // membership at read time (any active suppression binds its sender for
    // every consumer), so this array is never branched on. Stated, not
    // hidden: the `system.remember` tool description discloses the category
    // prior, and the user can narrow or drop the instruction via
    // list/edit/forget.
    effects: [...SUPPRESSION_EFFECTS],
    directive,
    phrasing: normalizeOptionalLabel(parsed.phrasing) ?? directive,
  });

  if (!candidate.success) return senderClarification();
  const instruction = candidate.data;

  // Identity, not coverage: a second remember collapses only onto an
  // instruction with THIS EXACT target. The sender matcher answered a
  // different question (does anything already cover this sender?), and a
  // domain instruction that covers the sender must not block the user from
  // also pinning the address.
  const existing = findInstructionByTarget(
    await listActiveSuppressionInstructions(parsed.userId),
    instruction.target,
  );

  if (existing) {
    return {
      ok: true,
      status: "already_exists",
      factId: existing.factId,
      instruction: existing.value,
      resolvedSenderEmail: email,
    };
  }

  const row = await db().transaction(async (tx) => {
    // Serialize concurrent remembers for the same (user, sender): without
    // this, two runs can both pass the `existing` check above and insert
    // duplicate active rows. Same per-key advisory-lock pattern as
    // `proposeFact`/`confirmFact` in `facts.ts`.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${parsed.userId}:standing_instruction:${standingInstructionTargetKey(instruction.target)}`}, 0))`,
    );

    // Re-check inside the lock: the outer `existing` read raced with a
    // concurrent inserter, so a duplicate found here collapses to
    // `already_exists` instead of a second active row.
    const rivals = await tx
      .select({ id: userFacts.id, value: userFacts.value, validFrom: userFacts.validFrom })
      .from(userFacts)
      .where(activeStandingInstructionsWhere(parsed.userId))
      .orderBy(desc(userFacts.validFrom));

    const rival = findInstructionByTarget(
      rivals
        .map(instructionFromFact)
        .filter(
          (candidate): candidate is ActiveSuppressionInstruction =>
            candidate !== null && candidate.value.action === "suppress",
        ),
      instruction.target,
    );

    if (rival) return { id: rival.factId, instruction: rival.value, duplicate: true as const };

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

    return { id: inserted.id, instruction, duplicate: false as const };
  });

  if (!row) throw new Error("[memory.standing-instructions] insert returned no row");

  if (row.duplicate) {
    return {
      ok: true,
      status: "already_exists",
      factId: row.id,
      instruction: row.instruction,
      resolvedSenderEmail: email,
    };
  }

  emitReplicachePokes([parsed.userId]);

  return {
    ok: true,
    status: "remembered",
    factId: row.id,
    instruction,
    resolvedSenderEmail: email,
  };
}

/**
 * Identity read: the active instruction whose target names exactly this thing,
 * or null. `standingInstructionTargetKey` carries the per-kind match key, so a
 * new target kind needs no edit here.
 */
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

export async function listActiveSuppressionInstructions(
  userId: string,
  // Audit echo only — membership is derived at read time, so the filter is
  // gone. Kept as an optional arg so existing call sites keep compiling while
  // they migrate off the per-effect read.
  effect?: SuppressionEffect,
): Promise<ActiveSuppressionInstruction[]> {
  void effect;

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
    // Per-row serialization: the `status = 'confirmed'` guard below is the
    // concurrency control (`row_version` is Replicache sync state, never
    // compared). The lock orders concurrent forget/edit callers on this
    // factId so the loser deterministically observes the retired row.
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
 * The single supersede body behind `editStandingInstruction`: close the active
 * row (`edited`), insert the successor (`supersedesId`), and append the
 * `user_standing_instruction` observation in one transaction so the edit stays
 * auditable and reversible.
 */
async function supersedeStandingInstruction(args: {
  userId: string;
  factId: string;
  nextValue: StandingInstructionValue;
  previousValue: StandingInstructionValue;
  source?: MemorySource | undefined;
}): Promise<{ id: string } | null> {
  return db().transaction(async (tx) => {
    // Per-row serialization, same contract as `forgetStandingInstruction`:
    // concurrent superseders order here; the loser matches zero rows on the
    // `status = 'confirmed'` guard and reports `not_found` (stale id, never
    // retried blindly — the caller re-lists). `row_version` bumps for the
    // Replicache changelog only.
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

export function findSenderSuppression(
  instructions: readonly ActiveSuppressionInstruction[],
  lookup: SenderSuppressionLookup,
): SenderSuppressionMatch | null {
  const email = normalizeSenderEmail(lookup.senderEmail);

  if (!email) return null;

  const accountId = lookup.accountId ?? null;

  for (const instruction of instructions) {
    const { target } = instruction.value;

    // Derived membership: an active suppression binds its sender for every
    // consumer. The stored `effects` array is never consulted — it is a
    // write-time snapshot, not a decision. `lookup.effect` is echoed on the
    // match for audit only.
    //
    // Deterministic: a string comparison per instruction, no model call and no
    // database read. `@alfred/contracts` owns the per-kind rule — including
    // how a domain comes off the address — so this loop never restates what a
    // target kind means.
    if (!targetMatchesSender(target, email)) continue;

    if (target.accountId !== null && target.accountId !== accountId) continue;

    return {
      ...instruction,
      matchedEmail: email,
      effect: lookup.effect,
      matchedVia: target.kind,
    };
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
