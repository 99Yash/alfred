import {
  buildStandingInstructionTarget,
  classifyBareDomain,
  domainSchema,
  emailDomain,
  isStandingInstructionOverlapRelation,
  normalizeEmailAddress,
  STANDING_INSTRUCTION_KEY,
  STANDING_INSTRUCTION_SCHEMA_VERSION,
  standingInstructionTargetKey,
  standingInstructionTargetRelation,
  standingInstructionTargetSpecificity,
  memorySourceSchema,
  standingInstructionValueSchema,
  SUPPRESSION_EFFECTS,
  targetMatchesSender,
  type MemorySource,
  type ObservationSource,
  type StandingInstructionOverlap,
  type StandingInstructionOverlapRelation,
  type StandingInstructionScopeNarrowing,
  type StandingInstructionTargetRelation,
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
      /**
       * Every active instruction whose sender-and-account scope STRICTLY
       * contains or is strictly contained by the stored target, drawn from the
       * same row snapshot that decided `status`. ADR-0060 micro-decision 6 asks
       * the write to report a subset or superset; at v1 both rows carry
       * `suppress`, so the overlap contradicts nothing and ADR-0060 §8 already
       * elects one of them at apply time. Reporting it is what stops a second
       * row from looking like a bug.
       *
       * SNAPSHOT-SCOPED. The advisory lock this write takes is keyed on its own
       * target, and an overlapping instruction has a different target key by
       * definition, so a concurrent write at a nesting target takes a different
       * key and neither call reports the other.
       *
       * Capped at {@link STANDING_INSTRUCTION_OVERLAP_LIMIT}; `overlapCount`
       * carries the true total.
       */
      overlaps: readonly StandingInstructionOverlap[];
      overlapCount: number;
      /**
       * Non-null when the caller asked for `scope:"domain"` and the rail stored
       * a `sender_email` target instead. Without it the caller cannot tell that
       * it asked for a class and got one address.
       */
      scopeNarrowing: StandingInstructionScopeNarrowing | null;
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

  // A caller that did not ask to widen gets no narrowing reason, because it
  // was never narrowed: `scopeNarrowing` answers "you asked for a class and
  // got one address", and an unasked question has no answer.
  const widening = parsed.scope === "domain" ? widenToDomain(email) : null;
  const domain = widening?.domain ?? null;
  const scopeNarrowing = widening?.narrowing ?? null;

  const target = buildStandingInstructionTarget({ email, domain, label, accountId });

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
  const active = await listActiveSuppressionInstructions(parsed.userId);
  const existing = findInstructionByTarget(active, instruction.target);

  if (existing) {
    return {
      ok: true,
      status: "already_exists",
      factId: existing.factId,
      instruction: existing.value,
      resolvedSenderEmail: email,
      // Reported from the snapshot THIS path decided on — the unlocked outer
      // read. No path may report an overlap set its own write never saw.
      ...findTargetOverlaps(active, instruction.target),
      scopeNarrowing,
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

    const locked = rivals
      .map(instructionFromFact)
      .filter(
        (candidate): candidate is ActiveSuppressionInstruction =>
          candidate !== null && candidate.value.action === "suppress",
      );

    // The locked read is the snapshot both remaining paths report from, so it
    // travels out of the transaction beside the row they decided. It orders
    // the DUPLICATE check only: the advisory lock is keyed on THIS target, and
    // an overlapping instruction has a different target key by definition, so
    // two concurrent writes at nesting targets take different keys, neither
    // blocks, and each reports only what its own snapshot held.
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
      instruction: row.instruction,
      resolvedSenderEmail: email,
      ...row.overlaps,
      scopeNarrowing,
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
  for (const instruction of instructions) {
    if (isSameStandingInstructionTarget(instruction.value.target, target)) return instruction;
  }

  return null;
}

/**
 * Do two targets name the same thing? `standingInstructionTargetKey` carries
 * the per-kind sender identity, and `accountId` is the second axis of the
 * same identity. One home for the rule, so the duplicate check above and the
 * overlap exclusion below cannot drift apart.
 */
function isSameStandingInstructionTarget(
  a: StandingInstructionTarget,
  b: StandingInstructionTarget,
): boolean {
  if (standingInstructionTargetKey(a) !== standingInstructionTargetKey(b)) return false;

  return a.accountId === b.accountId;
}

/**
 * Two rails keep a domain target from growing too wide, and both make the bad
 * target unrepresentable rather than merely unlikely:
 *   1. The caller never supplies a domain. The server derives it from an
 *      address the caller already resolved, so `co.in` cannot become a
 *      target — no sender has that address.
 *   2. Only a `corporate_domain` widens. `classifyBareDomain` is the one
 *      place that answers "is this domain one organization's", and it also
 *      rejects consumer mailboxes, school and alumni domains, shared-hosting
 *      and disposable hosts, and mail-infrastructure hosts — every class
 *      where one domain carries unrelated senders. It reads the BARE domain,
 *      never a connected account: the account form demands a verified hosted
 *      domain the sender side never has, so it would answer `ambiguous_domain`
 *      for every real sender and no instruction would ever widen.
 *
 * Rail 2 reads a domain the SHARED grammar accepts, which is the stricter of
 * the two grammars this path crosses: the sender was normalized by zod's email
 * pattern, which admits hosts `domainSchema` rejects. So the grammar is tested
 * here, before the class question — `classifyEmailDomain` answers `null` for
 * both an invalid domain and an unclassifiable one, and a caller told that
 * `ab-.com` "is not a single organization" has been told something false.
 *
 * Either rail refusing is a NARROWED write, not a plain address write, and the
 * caller has to be told which one refused. The return is a discriminated pair,
 * so a fall back to the address cannot be built without a reason.
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

/**
 * How many overlaps one result carries. A prompt-budget bound, not a
 * correctness one: a domain remember in a mailbox with fifty address rows
 * would otherwise put fifty directives of up to 1,000 characters into the
 * model's context. `overlapCount` still reports the true total.
 */
const STANDING_INSTRUCTION_OVERLAP_LIMIT = 10;

/**
 * The account axis of the same relation `@alfred/contracts` answers over
 * senders. It lives here for the reason the match rule's account half does:
 * `accountId` is the caller's question, not the target's, and this is the rule
 * `findSenderSuppression` already applies. A `null` `accountId` binds every
 * mailbox, so it is strictly wider than any one of them; two different
 * mailboxes share none.
 */
function accountScopeRelation(pair: {
  readonly of: StandingInstructionTarget;
  readonly relativeTo: StandingInstructionTarget;
}): StandingInstructionTargetRelation {
  const { of: subject, relativeTo } = pair;

  if (subject.accountId === relativeTo.accountId) return "same";

  if (subject.accountId === null) return "wider";

  if (relativeTo.accountId === null) return "narrower";

  return "disjoint";
}

/**
 * How the instruction `of` nests against the write `relativeTo`, over the full
 * SCOPE — its senders crossed with its mailboxes. Null when neither scope
 * contains the other, which covers three cases: one target twice, two
 * unrelated targets, and the crossing pair the account axis admits (a domain
 * row in one mailbox against an address row in every mailbox). The crossing
 * pair intersects without nesting, and this result reports nesting only.
 */
function scopeOverlapRelation(pair: {
  readonly of: StandingInstructionTarget;
  readonly relativeTo: StandingInstructionTarget;
}): StandingInstructionOverlapRelation | null {
  const sender = standingInstructionTargetRelation(pair);
  const account = accountScopeRelation(pair);

  if (sender === "disjoint" || account === "disjoint") return null;

  // An axis that matches exactly defers to the other one. Both matching is the
  // identity row, which the strict guard refuses.
  if (sender === "same") return isStandingInstructionOverlapRelation(account) ? account : null;

  if (account === "same") return sender;

  // Opposite directions: the two scopes intersect, and neither contains the
  // other.
  return sender === account ? sender : null;
}

/**
 * The overlap half of a successful write result. Named so the two `already_exists`
 * paths and the insert path spread ONE shape and cannot disagree about it.
 */
interface TargetOverlapReport {
  overlaps: StandingInstructionOverlap[];
  overlapCount: number;
}

/**
 * The active instructions whose scope strictly contains, or is strictly
 * contained by, `target`. STRICT on purpose: two targets that cover each other
 * are the same target, so the identity row this write collapsed onto never
 * appears in its own overlap list.
 *
 * The cut is total — `validFrom` descending, then `factId` descending — so it
 * never depends on Postgres's ordering of two rows written in the same
 * millisecond. `validFrom` is compared at `Date` millisecond resolution
 * because `Date.getTime()` drops the microseconds Postgres stores, which is
 * why `factId` sits below it.
 */
function findTargetOverlaps(
  instructions: readonly ActiveSuppressionInstruction[],
  target: StandingInstructionTarget,
): TargetOverlapReport {
  const matched: Array<
    ActiveSuppressionInstruction & { relation: StandingInstructionOverlapRelation }
  > = [];

  for (const instruction of instructions) {
    const relation = scopeOverlapRelation({
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
      directive: instruction.value.directive,
    })),
    overlapCount: matched.length,
  };
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

/**
 * ADR-0060 micro-decision 8, made total: the more specific target wins, then
 * the newer `validFrom`, then the greater `factId`. `factId` is the primary
 * key, so two distinct rows never compare equal and the election is a function
 * of the row set alone, never of the caller's array order.
 *
 * `accountId` is a gate, not a rank dimension: the caller filters on it before
 * this comparison, so two matches here are already scoped to the same mailbox.
 * `validFrom` is compared at `Date` millisecond resolution because
 * `Date.getTime()` drops the microseconds Postgres stores — which is exactly
 * why `factId` is needed below it.
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
    // Match `listActiveSuppressionInstructions`: only a `suppress` action is a
    // suppression. `STANDING_INSTRUCTION_ACTIONS` has one member today, so
    // `ActiveSuppressionInstruction` cannot carry another action and this
    // guard is unreachable — it closes the door the day a second action lands,
    // without moving the filter to the six consumers.
    if (instruction.value.action !== "suppress") continue;

    const { target } = instruction.value;

    // Derived membership: an active suppression binds its sender for every
    // consumer. The stored `effects` array is never consulted — it is a
    // write-time snapshot, not a decision. `lookup.effect` is echoed on the
    // match for audit only.
    //
    // Deterministic: a string comparison per instruction, no model call and no
    // database read. `@alfred/contracts` owns the per-kind rule — including
    // how a domain comes off the address and the `accountId` scope gate — so
    // this loop never restates what a target kind means.
    if (!targetMatchesSender(target, email, accountId)) continue;

    // ADR-0060 micro-decision 8: several instructions can match one sender, and
    // the MOST SPECIFIC target wins; `isStrongerSuppressionMatch` breaks a tie
    // by recency, then by `factId`. `sender_domain` made this reachable: the
    // user can mute a domain and still pin one address inside it, which
    // `rememberSenderSuppression` allows on purpose (see the identity-not-
    // coverage duplicate check above). A pure first-match-wins scan would let
    // the newer domain mute defeat that pin.
    if (best === null || isStrongerSuppressionMatch(instruction, best)) best = instruction;
  }

  if (!best) return null;

  return {
    ...best,
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
