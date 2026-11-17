/**
 * The v1 `rememberSenderSuppression` writer, unpublished (its last production consumer
 * was the backfill script, now archived), plus the `user_facts` row primitives that the
 * v2 capture in `./standing-instructions` shares with it. The writer and its v1 helpers
 * leave with plan PR 5; the primitives stay.
 */

import {
  buildStandingInstructionTarget,
  classifyBareDomain,
  domainSchema,
  emailDomain,
  normalizeEmailAddress,
  renderStandingInstructionDirective,
  standingInstructionScopeRelation,
  standingInstructionTargetKey,
  standingInstructionValueSchema,
  type MemorySource,
  type ObservationSource,
  type StandingInstructionDroppedInput,
  type StandingInstructionOverlap,
  type StandingInstructionScopeNarrowing,
  type StandingInstructionTarget,
  type StandingInstructionValue,
  type StandingInstructionValueV2,
  STANDING_INSTRUCTION_KEY,
  STANDING_INSTRUCTION_SCHEMA_VERSION,
  SUPPRESSION_EFFECTS,
  memorySourceSchema,
  targetNamesOneMailbox,
} from "@alfred/contracts";
import { db, type DbTransaction } from "@alfred/db";
import { sha256Canonical } from "@alfred/db/hash";
import type { DbRunner } from "@alfred/db/helpers";
import { userFacts } from "@alfred/db/schemas";
import { and, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { emitReplicachePokes } from "@alfred/assistant/triggers";
import { insertObservation } from "./observations";

/** A stored v1 row, for the v1 writer and `edit_instruction`. Both leave with plan PR 5. */
interface ActiveStandingInstructionV1 {
  factId: string;
  value: StandingInstructionValue;
  validFrom: Date;
}

/** A prompt-budget cap, not a correctness one. `overlapCount` and `relatedCount` keep the true total. */
export const STANDING_INSTRUCTION_OVERLAP_LIMIT = 10;

/** The wall clock after the capture lock, as Postgres text. Bind it as `${at}::timestamptz`. */
export type CaptureClock = string;

/** Active at `at`, the capture clock, or else at the transaction start. */
export function activeStandingInstructionsWhere(userId: string, at?: CaptureClock) {
  const clock = at === undefined ? sql`now()` : sql`${at}::timestamptz`;

  return and(
    eq(userFacts.userId, userId),
    eq(userFacts.key, STANDING_INSTRUCTION_KEY),
    eq(userFacts.status, "confirmed"),
    lte(userFacts.validFrom, clock),
    or(isNull(userFacts.validUntil), gt(userFacts.validUntil, clock)),
  );
}

export function selectActiveStandingInstructionFacts(
  userId: string,
  runner: DbRunner = db(),
  at?: CaptureClock,
) {
  return runner
    .select({ id: userFacts.id, value: userFacts.value, validFrom: userFacts.validFrom })
    .from(userFacts)
    .where(activeStandingInstructionsWhere(userId, at))
    .orderBy(desc(userFacts.validFrom));
}

type StandingInstructionObservationOperation = "remember" | "edit" | "forget";

export async function appendStandingInstructionObservation(
  args: {
    userId: string;
    operation: StandingInstructionObservationOperation;
    factId: string;
    previousFactId?: string | null;
    instruction: StandingInstructionValue | StandingInstructionValueV2;
    previousInstruction?: StandingInstructionValue | StandingInstructionValueV2 | null;
    reason?: string | null;
    source?: MemorySource | undefined;
  },
  tx: DbTransaction,
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

export function normalizeOptionalLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim();

  return trimmed ? trimmed : null;
}

/** The active instruction whose target is exactly this one, or null. */
function findInstructionByTarget(
  instructions: readonly ActiveStandingInstructionV1[],
  target: StandingInstructionTarget,
): ActiveStandingInstructionV1 | null {
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
  instructions: readonly ActiveStandingInstructionV1[],
  target: StandingInstructionTarget,
): TargetOverlapReport {
  const matched: Array<
    ActiveStandingInstructionV1 & { relation: StandingInstructionOverlap["relation"] }
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

/** Every active v1 `suppress` row, for the chat management tools. */
async function listActiveStandingInstructionsV1(
  userId: string,
): Promise<ActiveStandingInstructionV1[]> {
  const facts = await selectActiveStandingInstructionFacts(userId);

  return facts
    .map(instructionFromFact)
    .filter((instruction): instruction is ActiveStandingInstructionV1 => {
      if (!instruction) return false;

      // oxlint-disable-next-line typescript/no-unnecessary-condition -- `suppress` is the only standing-instruction action today; the check keeps a second action out of this path when it lands.
      if (instruction.value.action !== "suppress") return false;

      return true;
    });
}

function instructionFromFact(fact: {
  id: string;
  value: unknown;
  validFrom: Date;
}): ActiveStandingInstructionV1 | null {
  const parsed = standingInstructionValueSchema.safeParse(fact.value);

  if (!parsed.success) return null;

  return {
    factId: fact.id,
    value: parsed.data,
    validFrom: fact.validFrom,
  };
}

const rememberSenderSuppressionArgsSchema = z.object({
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
  const active = await listActiveStandingInstructionsV1(parsed.userId);
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

    const locked = rivals.map(instructionFromFact).filter(
      (candidate): candidate is ActiveStandingInstructionV1 =>
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- `suppress` is the only standing-instruction action today; the check keeps a second action out of this path when it lands.
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

function senderClarification(): RememberSenderSuppressionResult {
  return {
    ok: false,
    status: "needs_clarification",
    reason: "invalid_sender_email",
    message: "I could not identify the sender address to suppress. Which sender should I use?",
  };
}
