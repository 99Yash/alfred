import {
  buildStandingInstructionTarget,
  classifyBareDomain,
  domainSchema,
  normalizeEmailAddress,
  renderStandingInstructionDirective,
  STANDING_INSTRUCTION_KEY,
  standingInstructionTargetKey,
  standingInstructionScopeRelation,
  standingInstructionScopesIntersect,
  memorySourceSchema,
  readStoredStandingInstruction,
  STANDING_INSTRUCTION_SCHEMA_VERSION_V2,
  standingInstructionValueSchema,
  standingInstructionValueV2Schema,
  type rememberInput,
  type StandingInstructionEffect,
  targetNamesOneMailbox,
  type StandingInstructionValueV2,
  type MemorySource,
  type UserClaimProvenance,
  type StandingInstructionDroppedInput,
  type StandingInstructionOverlap,
  type StandingInstructionTarget,
  type StandingInstructionValue,
} from "@alfred/contracts";
import { db, type DbTransaction } from "@alfred/db";
import { createId, type DbRunner } from "@alfred/db/helpers";
import { rejectedInferences, userFacts } from "@alfred/db/schemas";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { emitReplicachePokes } from "@alfred/assistant/triggers";
import {
  appendStandingInstructionObservation,
  activeStandingInstructionsWhere,
  normalizeOptionalLabel,
  selectActiveStandingInstructionFacts,
  STANDING_INSTRUCTION_OVERLAP_LIMIT,
  type CaptureClock,
} from "./sender-suppression";
import { instructionKeyOf } from "./instructions-in-words";
import { valueSignature } from "./signature";

export const STANDING_INSTRUCTION_LIST_LIMIT = 100;

/** Any stored version, read as v2 (ADR-0113). A v1 row is lifted with the effects it enforces. */
export interface ActiveStandingInstruction {
  factId: string;
  value: StandingInstructionValueV2;
  validFrom: Date;
}

/**
 * An active instruction with the shape it is stored in. Only a stored v2 row has a durable
 * `instructionId`: a lifted v1 row uses its fact id, which plan PR 5 replaces.
 */
interface StoredStandingInstruction extends ActiveStandingInstruction {
  storedVersion: 1 | 2;
}

// ─── Capture (v2, ADR-0113) ─────────────────────────────────────────────────

/** The parsed `system.remember` input. It saves with no card (ADR-0130 decision 2). */
export type SaveStandingInstructionInput = Omit<z.infer<typeof rememberInput>, "kind">;

/** An active instruction that shares a sender with the saved one (ADR-0060 micro-decision 6). */
export interface RelatedStandingInstruction {
  instructionId: string;
  factId: string;
  directive: string;
  /**
   * How the related instruction's sender relates to the saved one's, for one shared sender.
   * `overlaps`: they share mail but neither contains the other, for example a domain in one
   * mailbox and an address at that domain in every mailbox.
   */
  relation: StandingInstructionOverlap["relation"] | "same" | "overlaps";
}

export type SaveStandingInstructionResult =
  | {
      ok: true;
      status: "remembered" | "revised" | "already_exists";
      factId: string;
      instruction: StandingInstructionValueV2;
      /** Capped at {@link STANDING_INSTRUCTION_OVERLAP_LIMIT}; `relatedCount` has the total. */
      related: RelatedStandingInstruction[];
      relatedCount: number;
    }
  | {
      ok: false;
      status: "invalid_sender";
      /** The input value that is not an address or a single organization's domain. */
      sender: string;
      message: string;
    }
  | { ok: false; status: "unknown_instruction"; instructionId: string; message: string }
  | {
      ok: false;
      /** The revised instruction changed after the card was proposed. Nothing was stored. */
      status: "stale_revision";
      instructionId: string;
      /** `null` when the input named no revision. The input schema requires one. */
      expectedRevision: number | null;
      currentRevision: number;
      message: string;
    }
  | { ok: false; status: "invalid_exception"; exceptionOf: string; message: string }
  | { ok: false; status: "invalid_resolution"; instructionId: string; message: string }
  /** No user chat turn started the run, so the words are not the user's (ADR-0123). Nothing was stored. */
  | { ok: false; status: "not_said_in_chat"; message: string }
  | {
      ok: false;
      /**
       * Nothing was stored (ADR-0060 micro-decision 6). Each related instruction needs the
       * user's choice: `replaces`, `exceptionOf`, or `coexistsWith`.
       */
      status: "conflict";
      /** Capped at {@link STANDING_INSTRUCTION_OVERLAP_LIMIT}; `conflictCount` has the total. */
      conflicts: RelatedStandingInstruction[];
      conflictCount: number;
      message: string;
    };

/** The refusals of {@link saveStandingInstruction}. Nothing was stored. */
export type StandingInstructionCaptureRefusal = Extract<
  SaveStandingInstructionResult,
  { ok: false }
>;

type SenderParse =
  | { ok: true; target: StandingInstructionTarget }
  | { ok: false; sender: string; message: string };

/**
 * An address, or a bare domain of one organization. The domain gate is the same rail as v1
 * capture: a personal, school, shared-hosting, or mail-service host is refused, because it
 * names many unrelated senders.
 */
function parseInstructionSender(sender: string, accountId: string | null): SenderParse {
  if (sender.includes("@")) {
    const email = normalizeEmailAddress(sender);

    if (email === null) {
      return { ok: false, sender, message: `'${sender}' is not a valid email address.` };
    }

    return {
      ok: true,
      target: buildStandingInstructionTarget({ email, domain: null, label: null, accountId }),
    };
  }

  const domain = domainSchema.safeParse(sender);

  if (!domain.success || classifyBareDomain({ domain: domain.data }) !== "corporate_domain") {
    return {
      ok: false,
      sender,
      message:
        `'${sender}' is not the domain of one organization. Name an address, or use a scope ` +
        "for a class of mail.",
    };
  }

  return {
    ok: true,
    target: { kind: "sender_domain", domain: domain.data, accountId },
  };
}

function parseInstructionSenders(
  senders: readonly string[] | undefined,
  accountId: string | null,
):
  | { ok: true; targets: StandingInstructionTarget[] | undefined }
  | Extract<SenderParse, { ok: false }> {
  if (senders === undefined) return { ok: true, targets: undefined };

  const targets = new Map<string, StandingInstructionTarget>();

  for (const sender of senders) {
    const parsed = parseInstructionSender(sender, accountId);

    if (!parsed.ok) return parsed;

    targets.set(standingInstructionTargetKey(parsed.target), parsed.target);
  }

  return { ok: true, targets: [...targets.values()] };
}

/** The contract requires `forceCategory` with `force_category`, so no effect is dropped. */
function captureEffects(input: SaveStandingInstructionInput): StandingInstructionEffect[] {
  return [...new Set(input.effects)].flatMap((kind): StandingInstructionEffect[] => {
    if (kind !== "force_category") return [{ kind }];

    return input.forceCategory === undefined ? [] : [{ kind, category: input.forceCategory }];
  });
}

/** The stored value for one parsed input at one identity. */
function captureValue(
  input: SaveStandingInstructionInput,
  parsed: Extract<ParsedCaptureInput, { ok: true }>,
  identity: { instructionId: string; revision: number },
): StandingInstructionValueV2 {
  return standingInstructionValueV2Schema.parse({
    schemaVersion: STANDING_INSTRUCTION_SCHEMA_VERSION_V2,
    instructionId: identity.instructionId,
    revision: identity.revision,
    phrasing: input.phrasing,
    directive: input.directive,
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    targets: parsed.targets ?? [],
    ...(parsed.senderFilter === undefined ? {} : { senderFilter: parsed.senderFilter }),
    effects: captureEffects(input),
    ...(input.exceptionOf === undefined ? {} : { exceptionOf: input.exceptionOf }),
    // Targets and the filter carry the mailbox. The scope needs its own bound (ADR-0113).
    ...(parsed.accountId === null || input.scope === undefined
      ? {}
      : { accountId: parsed.accountId }),
  } satisfies z.input<typeof standingInstructionValueV2Schema>);
}

/** The content of an instruction, without its identity, for the duplicate check. */
function instructionContentSignature(value: StandingInstructionValueV2): string {
  const { instructionId: _id, revision: _revision, ...content } = value;

  return valueSignature(content);
}

/** The senders, as stored targets, before the lock. A bad sender refuses the whole input. */
type ParsedCaptureInput =
  | {
      ok: true;
      accountId: string | null;
      targets: StandingInstructionTarget[] | undefined;
      senderFilter: StandingInstructionTarget[] | undefined;
    }
  | Extract<SaveStandingInstructionResult, { status: "invalid_sender" }>;

function parseCaptureInput(input: SaveStandingInstructionInput): ParsedCaptureInput {
  const accountId = normalizeOptionalLabel(input.accountId);
  const targets = parseInstructionSenders(input.targets, accountId);

  if (!targets.ok) return { ...targets, status: "invalid_sender" };

  const senderFilter = parseInstructionSenders(input.senderFilter, accountId);

  if (!senderFilter.ok) return { ...senderFilter, status: "invalid_sender" };

  return { ok: true, accountId, targets: targets.targets, senderFilter: senderFilter.targets };
}

/**
 * The rows one capture reads. `retired` holds each `replaces` id that names a stored
 * instruction that is no longer active, so a repeat of a finished replacement still plans.
 */
interface CaptureState {
  active: StoredStandingInstruction[];
  retired: ReadonlySet<string>;
}

async function readCaptureState(
  userId: string,
  input: SaveStandingInstructionInput,
  runner: DbRunner = db(),
  at?: CaptureClock,
): Promise<CaptureState> {
  const active = await readStoredStandingInstructions(userId, runner, at);
  const activeIds = new Set(active.map((row) => row.value.instructionId));
  const missing = (input.replaces ?? []).filter((id) => !activeIds.has(id));

  if (missing.length === 0) return { active, retired: new Set() };

  // A v1 row's id is its fact id. A v2 row keeps its id in the value across revisions.
  const instructionIdColumn = sql<string | null>`${userFacts.value}->>'instructionId'`;

  const rows = await runner
    .select({ factId: userFacts.id, instructionId: instructionIdColumn })
    .from(userFacts)
    .where(
      and(
        eq(userFacts.userId, userId),
        eq(userFacts.key, STANDING_INSTRUCTION_KEY),
        or(inArray(userFacts.id, missing), inArray(instructionIdColumn, missing)),
      ),
    );

  const known = new Set(rows.flatMap((row) => [row.factId, row.instructionId ?? row.factId]));

  return { active, retired: new Set(missing.filter((id) => known.has(id))) };
}

/**
 * What capture does with one input over one read of the active set. The stored content and the
 * capture operation are separate: an input whose content an active row already holds can still
 * close the rows it replaces.
 */
type CapturePlan =
  | StandingInstructionCaptureRefusal
  | {
      ok: true;
      /** `existing`: an active row already holds this content, so no row is inserted. */
      stored:
        | { kind: "existing"; row: StoredStandingInstruction }
        | {
            kind: "insert";
            value: StandingInstructionValueV2;
            previous: StoredStandingInstruction | null;
          };
      /** Active rows that `replaces` names. They close in the same transaction. */
      replaced: StoredStandingInstruction[];
      report: RelatedInstructionsReport;
    };

/**
 * Decide one capture over the active set. Pure, so the pre-card check and the write under the
 * lock decide the same way. The order is: the revision and exception targets, the user's
 * resolution, the duplicate check, the expected revision, and last the structural-conflict gate
 * (ADR-0060 micro-decision 6): each related instruction needs `replaces`, `exceptionOf`, or
 * `coexistsWith`.
 *
 * `replaces` states an end state, so an id that is already retired is accepted and closes
 * nothing. A repeat of a finished capture then plans `existing`.
 */
function planCapture(
  { active, retired }: CaptureState,
  input: SaveStandingInstructionInput,
  parsed: Extract<ParsedCaptureInput, { ok: true }>,
): CapturePlan {
  // A v1 row's id is its fact id, so it is no revision or exception target.
  const byId = new Map(
    active.flatMap((row) =>
      row.storedVersion === 2 ? [[row.value.instructionId, row] as const] : [],
    ),
  );

  // `replaces` and `coexistsWith` take any version: a v1 row lists its fact id as its id.
  const byAnyId = new Map(active.map((row) => [row.value.instructionId, row] as const));

  const previous =
    input.instructionId === undefined ? null : (byId.get(input.instructionId) ?? null);

  if (input.instructionId !== undefined && previous === null) {
    return unknownInstruction(input.instructionId);
  }

  const instructionId = previous?.value.instructionId ?? createId("si");

  if (input.exceptionOf !== undefined) {
    const message = exceptionProblem(byId, instructionId, input.exceptionOf);

    if (message !== null) {
      return { ok: false, status: "invalid_exception", exceptionOf: input.exceptionOf, message };
    }
  }

  const replaces = input.replaces ?? [];
  const coexistsWith = new Set(input.coexistsWith);

  for (const id of replaces) {
    if (!byAnyId.has(id) && !retired.has(id)) return unknownInstruction(id);
  }

  for (const id of coexistsWith) {
    if (!byAnyId.has(id)) return unknownInstruction(id);
  }

  for (const id of replaces) {
    const message =
      id === instructionId
        ? "A revision cannot replace the instruction it revises."
        : id === input.exceptionOf
          ? "An instruction cannot replace the instruction it is an exception to."
          : coexistsWith.has(id)
            ? "An instruction cannot be both replaced and kept."
            : null;

    if (message !== null) {
      return { ok: false, status: "invalid_resolution", instructionId: id, message };
    }
  }

  const value = captureValue(input, parsed, {
    instructionId,
    revision: previous === null ? 0 : previous.value.revision + 1,
  });

  const signature = instructionContentSignature(value);
  const replacedIds = new Set(replaces);

  // A revision duplicates only its own row. A new instruction duplicates any active one, and
  // then a `replaces` id for that same row keeps it.
  const duplicate = previous
    ? instructionContentSignature(previous.value) === signature
      ? previous
      : null
    : (active.find((row) => instructionContentSignature(row.value) === signature) ?? null);

  const replaced = active.filter(
    (row) => replacedIds.has(row.value.instructionId) && row.factId !== duplicate?.factId,
  );

  const kept = duplicate ?? previous;

  const others = active.filter(
    (row) => row.factId !== kept?.factId && !replaced.some((r) => r.factId === row.factId),
  );

  const report = findRelatedInstructions(others, value);

  // The stored row already passed the conflict gate, so only the replacements are new work.
  if (duplicate) {
    return { ok: true, stored: { kind: "existing", row: duplicate }, replaced, report };
  }

  // The card showed a revision of one stored revision. A different one is now active.
  if (previous && previous.value.revision !== input.expectedRevision) {
    return {
      ok: false,
      status: "stale_revision",
      instructionId: previous.value.instructionId,
      expectedRevision: input.expectedRevision ?? null,
      currentRevision: previous.value.revision,
      message:
        "Nothing was stored: the instruction changed after this call was proposed. List the " +
        "instructions, show the user the current one, and ask again.",
    };
  }

  // An exception of this instruction, or the instruction this one narrows, is already declared.
  const unresolved = others.filter(
    (row) =>
      !coexistsWith.has(row.value.instructionId) &&
      row.value.instructionId !== input.exceptionOf &&
      row.value.exceptionOf !== instructionId,
  );

  const conflicts = findRelatedInstructions(unresolved, value);

  if (conflicts.relatedCount > 0) {
    return {
      ok: false,
      status: "conflict",
      conflicts: conflicts.related,
      conflictCount: conflicts.relatedCount,
      message:
        "Nothing was stored. Show the user each conflicting instruction and ask for one " +
        "choice: replace it (`replaces`), make the new one an exception to it (`exceptionOf`), " +
        "or keep both (`coexistsWith`). Then call system.remember again with that choice.",
    };
  }

  return { ok: true, stored: { kind: "insert", value, previous }, replaced, report };
}

function unknownInstruction(instructionId: string): StandingInstructionCaptureRefusal {
  return {
    ok: false,
    status: "unknown_instruction",
    instructionId,
    message:
      "No active instruction has this id. A revision and `exceptionOf` need schemaVersion 2. " +
      "List the instructions and try again.",
  };
}

/** A row that capture planned to close was closed by a writer outside the capture lock. */
class CaptureRowClosedError extends Error {
  constructor(readonly instructionId: string) {
    super(`[memory.standing-instructions] instruction ${instructionId} closed during capture`);
  }
}

/**
 * The capture refusal for this input over the current set, or null. It runs before the card, so
 * the user does not confirm an input that capture would refuse. It takes no lock, so
 * {@link saveStandingInstruction} decides again under the lock.
 */
export async function checkStandingInstructionCapture(args: {
  userId: string;
  input: SaveStandingInstructionInput;
}): Promise<StandingInstructionCaptureRefusal | null> {
  const parsed = parseCaptureInput(args.input);

  if (!parsed.ok) return parsed;

  const plan = planCapture(await readCaptureState(args.userId, args.input), args.input, parsed);

  return plan.ok ? null : plan;
}

/**
 * Store a v2 standing instruction, or revise one (ADR-0113 capture). It runs with no card
 * (ADR-0130 decision 2). Code mints the instruction id; a revision keeps it and
 * adds 1 to `revision`. The `user_facts` trigger raises the set revision with the write.
 */
export async function saveStandingInstruction(args: {
  userId: string;
  input: SaveStandingInstructionInput;
  /** An instruction is the user's own claim: it cites the user's chat turn (ADR-0123). */
  provenance: UserClaimProvenance;
  /** The source of the activity record (ADR-0118). */
  source?: MemorySource | undefined;
}): Promise<SaveStandingInstructionResult> {
  const parsed = parseCaptureInput(args.input);

  if (!parsed.ok) return parsed;

  const source: MemorySource = args.source ?? { kind: "user" };

  type CaptureOutcome =
    | StandingInstructionCaptureRefusal
    | { ok: true; factId: string; plan: Extract<CapturePlan, { ok: true }> };

  const outcome = await db()
    .transaction(async (tx): Promise<CaptureOutcome> => {
      const at = await lockStandingInstructionCapture(tx, args.userId);

      const decided = planCapture(
        await readCaptureState(args.userId, args.input, tx, at),
        args.input,
        parsed,
      );

      if (!decided.ok) return decided;

      const { stored, replaced } = decided;
      const previous = stored.kind === "insert" ? stored.previous : null;
      const closing = [...(previous ? [previous] : []), ...replaced];

      if (closing.length > 0) {
        const closed = await tx
          .update(userFacts)
          .set({
            status: "edited",
            validUntil: sql`${at}::timestamptz`,
            rowVersion: sql`${userFacts.rowVersion} + 1`,
          })
          .where(
            and(
              inArray(
                userFacts.id,
                closing.map((row) => row.factId),
              ),
              activeStandingInstructionsWhere(args.userId, at),
            ),
          )
          .returning({ id: userFacts.id });

        // The v1 writer and a v1 edit from an older deploy do not take the capture lock. Roll back.
        const closedIds = new Set(closed.map((row) => row.id));
        const missed = closing.find((row) => !closedIds.has(row.factId));

        if (missed) throw new CaptureRowClosedError(missed.value.instructionId);
      }

      let factId: string;
      let instruction: StandingInstructionValueV2;

      if (stored.kind === "existing") {
        factId = stored.row.factId;
        instruction = stored.row.value;
      } else {
        const [inserted] = await tx
          .insert(userFacts)
          .values({
            userId: args.userId,
            key: STANDING_INSTRUCTION_KEY,
            value: stored.value,
            confidence: 1,
            status: "confirmed",
            author: args.provenance.author,
            evidence: [...args.provenance.evidence],
            producer: args.provenance.producer,
            validFrom: sql`${at}::timestamptz`,
            validUntil: null,
            supersedesId: previous?.factId ?? null,
          })
          .returning({ id: userFacts.id });

        if (!inserted) throw new Error("[memory.standing-instructions] insert returned no row");

        factId = inserted.id;
        instruction = stored.value;

        await appendStandingInstructionObservation(
          {
            userId: args.userId,
            operation: previous === null ? "remember" : "edit",
            factId,
            previousFactId: previous?.factId ?? null,
            instruction,
            previousInstruction: previous?.value ?? null,
            source,
          },
          tx,
        );
      }

      // A replaced instruction is edited into the kept one, so its history links to it.
      for (const row of replaced) {
        await appendStandingInstructionObservation(
          {
            userId: args.userId,
            operation: "edit",
            factId,
            previousFactId: row.factId,
            instruction,
            previousInstruction: row.value,
            reason: `replaced by ${instruction.instructionId}`,
            source,
          },
          tx,
        );
      }

      return { ok: true, factId, plan: decided };
    })
    .catch((error: unknown) => {
      if (error instanceof CaptureRowClosedError) return unknownInstruction(error.instructionId);

      throw error;
    });

  if (!outcome.ok) return outcome;

  const { stored, replaced, report } = outcome.plan;

  if (stored.kind === "insert" || replaced.length > 0) emitReplicachePokes([args.userId]);

  return {
    ok: true,
    status:
      stored.kind === "existing" ? "already_exists" : stored.previous ? "revised" : "remembered",
    factId: outcome.factId,
    instruction: stored.kind === "existing" ? stored.row.value : stored.value,
    ...report,
  };
}

/** The senders an instruction names: its targets and its scope filter. */
function namedSenders(value: StandingInstructionValueV2): StandingInstructionTarget[] {
  return [...value.targets, ...(value.senderFilter ?? [])];
}

/**
 * Active instructions that name a sender the saved one names, the same or wider or narrower.
 * The boss shows them, so the user can replace one, make an exception, or keep both.
 */
interface RelatedInstructionsReport {
  related: RelatedStandingInstruction[];
  relatedCount: number;
}

function findRelatedInstructions(
  active: readonly ActiveStandingInstruction[],
  value: StandingInstructionValueV2,
): RelatedInstructionsReport {
  const related: RelatedStandingInstruction[] = [];
  let relatedCount = 0;

  for (const instruction of active) {
    const relation = senderRelation(namedSenders(instruction.value), namedSenders(value));

    if (relation === null) continue;

    relatedCount += 1;

    if (related.length === STANDING_INSTRUCTION_OVERLAP_LIMIT) continue;

    related.push({
      instructionId: instruction.value.instructionId,
      factId: instruction.factId,
      directive: instruction.value.directive,
      relation,
    });
  }

  return { related, relatedCount };
}

/**
 * Why `exceptionOf` cannot name this target, or null. It must be a different active v2
 * instruction, and the `exceptionOf` chain above it must not come back to `instructionId`.
 */
function exceptionProblem(
  byId: ReadonlyMap<string, StoredStandingInstruction>,
  instructionId: string,
  exceptionOf: string,
): string | null {
  if (exceptionOf === instructionId) return "An instruction cannot be an exception to itself.";

  if (!byId.has(exceptionOf)) {
    return "`exceptionOf` must name an active schemaVersion 2 instruction.";
  }

  const seen = new Set<string>();

  for (
    let id: string | undefined = exceptionOf;
    id !== undefined && !seen.has(id);
    id = byId.get(id)?.value.exceptionOf
  ) {
    if (id === instructionId) {
      return "`exceptionOf` makes a cycle: that instruction is already an exception to this one.";
    }

    seen.add(id);
  }

  return null;
}

function senderRelation(
  of: readonly StandingInstructionTarget[],
  relativeTo: readonly StandingInstructionTarget[],
): RelatedStandingInstruction["relation"] | null {
  for (const a of of) {
    for (const b of relativeTo) {
      if (
        standingInstructionTargetKey(a) === standingInstructionTargetKey(b) &&
        a.accountId === b.accountId
      ) {
        return "same";
      }

      const relation = standingInstructionScopeRelation({ of: a, relativeTo: b });

      if (relation !== null) return relation;

      // They share mail without nesting, so opposing effects still conflict.
      if (standingInstructionScopesIntersect({ of: a, relativeTo: b })) return "overlaps";
    }
  }

  return null;
}

/**
 * Every active instruction of any stored version, as v2, newest first, with the version it is
 * stored in. A row of neither shape is skipped. Capture reads it inside its lock.
 */
async function readStoredStandingInstructions(
  userId: string,
  runner: DbRunner = db(),
  at?: CaptureClock,
): Promise<StoredStandingInstruction[]> {
  const facts = await selectActiveStandingInstructionFacts(userId, runner, at);

  return facts.flatMap((fact): StoredStandingInstruction[] => {
    const value = readStoredStandingInstruction(fact.value, fact.id);

    if (!value) return [];

    const storedVersion = standingInstructionValueV2Schema.safeParse(fact.value).success ? 2 : 1;

    return [{ factId: fact.id, value, validFrom: fact.validFrom, storedVersion }];
  });
}

/**
 * One capture, forget, or edit at a time for each user, so a revision and an exception see a stable
 * set. Do not change the key text: a rolling deploy would then run unserialized.
 */
async function lockStandingInstructionCapture(
  tx: DbTransaction,
  userId: string,
): Promise<CaptureClock> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${userId}:standing_instruction:capture`}, 0))`,
  );

  // `now()` is the transaction start, which can be before a row that a rival committed while
  // this one waited. Read the clock after the lock. Text keeps the microseconds a Date drops.
  const { rows } = await tx.execute(sql`select clock_timestamp()::text as at`);

  return captureClockSchema.parse(rows[0]).at;
}

const captureClockSchema = z.object({ at: z.string().min(1) });

// ─── Management (user-driven: list / forget / edit) ─────────────────────────
// Chat-only. Background inference never calls these, so it cannot edit or delete what
// the user said. Forget is a soft reject; edit supersedes. Each mutation appends a
// `user_standing_instruction` observation in the same transaction (ADR-0067).
//
// Triage and the briefing composer read an instruction as its words (triage slice 4a), and
// rows with the same words and mailbox bound are one instruction to them (`instructionKeyOf`). So
// forget and a words edit act on every active row with that key, else the old words stay in force.

/**
 * One active standing instruction as v2, for the model to reference. `schemaVersion` is the
 * stored shape. A v1 row is lifted: it takes `edit_instruction`, and it is no revision or
 * `exceptionOf` target for `system.remember`.
 */
export interface StandingInstructionSummary {
  factId: string;
  schemaVersion: 1 | 2;
  instruction: StandingInstructionValueV2;
  validFrom: Date;
  /**
   * The active rows, this one included, whose words are the same as this row's. Triage and the
   * briefing read them as one instruction. Forget and a words edit act on all of them.
   */
  sameWordsCount: number;
}

export interface StandingInstructionListResult {
  instructions: StandingInstructionSummary[];
  totalActive: number;
  truncated: boolean;
  limit: number;
}

export type ForgetStandingInstructionResult =
  | {
      ok: true;
      status: "forgotten";
      factId: string;
      instruction: StandingInstructionValueV2;
      /** Each row this call retired: `factId` and every active row with the same words. */
      retiredFactIds: string[];
    }
  | { ok: false; status: "not_found" };

export type EditStandingInstructionResult =
  | {
      ok: true;
      status: "edited";
      /** The successor of the named row, or the named row when only its siblings changed. */
      factId: string;
      previousFactId: string;
      instruction: StandingInstructionValue;
      /** The rows this call superseded: the named row and its v1 rows with the same words. */
      editedCount: number;
      /** Edits a class row cannot take. Empty on an address row. */
      droppedInputs: readonly StandingInstructionDroppedInput[];
      /**
       * Active schemaVersion 2 rows with the same words. This tool does not change them, so
       * their words stay in force until `system.remember` revises them.
       */
      sameWordsNotEdited: string[];
    }
  | {
      ok: true;
      status: "unchanged";
      factId: string;
      instruction: StandingInstructionValue;
      /** Edits the row could not take. */
      droppedInputs: readonly StandingInstructionDroppedInput[];
      sameWordsNotEdited: string[];
    }
  | { ok: false; status: "not_found" }
  | { ok: false; status: "revise_with_remember"; instructionId: string; message: string }
  /** No user chat turn started the run, so the edit is not the user's (ADR-0123). Nothing changed. */
  | { ok: false; status: "not_said_in_chat"; message: string };

export const editStandingInstructionArgsSchema = z.object({
  userId: z.string().min(1),
  factId: z.string().min(1),
  directive: z.string().nullish(),
  senderLabel: z.string().nullish(),
  source: memorySourceSchema.optional(),
});

/** `provenance` is the claim's evidence: the user's chat turn (ADR-0123). */
export type EditStandingInstructionArgs = z.infer<typeof editStandingInstructionArgsSchema> & {
  provenance: UserClaimProvenance;
};

/** Active standing instructions of any stored version, newest first, capped. */
export async function listStandingInstructions(
  userId: string,
): Promise<StandingInstructionListResult> {
  const rows = await readStoredStandingInstructions(userId);
  const countByWords = new Map<string, number>();

  for (const row of rows) {
    const key = instructionKeyOf(row.value);

    if (key !== null) countByWords.set(key, (countByWords.get(key) ?? 0) + 1);
  }

  const instructions = rows.map((row): StandingInstructionSummary => {
    const key = instructionKeyOf(row.value);

    return {
      factId: row.factId,
      schemaVersion: row.storedVersion,
      instruction: row.value,
      validFrom: row.validFrom,
      sameWordsCount: key === null ? 1 : (countByWords.get(key) ?? 1),
    };
  });

  const capped = instructions.slice(0, STANDING_INSTRUCTION_LIST_LIMIT);

  return {
    instructions: capped,
    totalActive: instructions.length,
    truncated: instructions.length > capped.length,
    limit: STANDING_INSTRUCTION_LIST_LIMIT,
  };
}

/** One active row as stored, with its v2 reading. `v1` is the stored v1 value, else null. */
interface ManagedStandingInstruction {
  factId: string;
  stored: unknown;
  value: StandingInstructionValueV2;
  v1: StandingInstructionValue | null;
}

/** Every active row at `at`. Read it under the capture lock. A row of neither shape is skipped. */
async function readManagedStandingInstructions(
  tx: DbTransaction,
  userId: string,
  at: CaptureClock,
): Promise<ManagedStandingInstruction[]> {
  const facts = await selectActiveStandingInstructionFacts(userId, tx, at);

  return facts.flatMap((fact): ManagedStandingInstruction[] => {
    const value = readStoredStandingInstruction(fact.value, fact.id);

    if (!value) return [];

    const v1 = standingInstructionValueV2Schema.safeParse(fact.value).success
      ? null
      : (standingInstructionValueSchema.safeParse(fact.value).data ?? null);

    return [{ factId: fact.id, stored: fact.value, value, v1 }];
  });
}

/** The active rows with the same words as `named`, `named` included. */
function sameWordsRows(
  rows: readonly ManagedStandingInstruction[],
  named: ManagedStandingInstruction,
): ManagedStandingInstruction[] {
  const key = instructionKeyOf(named.value);

  if (key === null) return [named];

  return rows.filter((row) => row.factId === named.factId || instructionKeyOf(row.value) === key);
}

/**
 * The per-row lock that a v1 edit from an older deploy takes without the capture lock. Sorted,
 * so two holders of many rows cannot deadlock.
 */
async function lockStandingInstructionRows(
  tx: DbTransaction,
  userId: string,
  factIds: readonly string[],
): Promise<void> {
  for (const factId of factIds.toSorted()) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`standing_instruction:${userId}:${factId}`}, 0))`,
    );
  }
}

/**
 * Retire the named instruction and every active row with the same words, so neither triage nor
 * the briefing reads those words again. Each retired row gets a rejection and an observation.
 */
export async function forgetStandingInstruction(args: {
  userId: string;
  factId: string;
  reason?: string | null | undefined;
  source?: MemorySource | undefined;
}): Promise<ForgetStandingInstructionResult> {
  const forgotten = await db().transaction(async (tx) => {
    // Wait for a capture that reads these rows as a revision or exception target.
    const at = await lockStandingInstructionCapture(tx, args.userId);
    const rows = await readManagedStandingInstructions(tx, args.userId, at);
    const named = rows.find((row) => row.factId === args.factId);

    if (!named) return null;

    const group = sameWordsRows(rows, named);

    await lockStandingInstructionRows(
      tx,
      args.userId,
      group.map((row) => row.factId),
    );

    // The `status = 'confirmed'` guard is the concurrency control: a row that another writer
    // closed since the read is not returned, and so it is not reported as retired.
    const retired = await tx
      .update(userFacts)
      .set({
        status: "rejected",
        validUntil: sql`${at}::timestamptz`,
        rowVersion: sql`${userFacts.rowVersion} + 1`,
      })
      .where(
        and(
          inArray(
            userFacts.id,
            group.map((row) => row.factId),
          ),
          activeStandingInstructionsWhere(args.userId, at),
        ),
      )
      .returning({ id: userFacts.id });

    const retiredIds = new Set(retired.map((row) => row.id));
    const retiredRows = group.filter((row) => retiredIds.has(row.factId));

    if (retiredRows.length === 0) return null;

    // The rejection signature keys on the stored value.
    await tx
      .insert(rejectedInferences)
      .values(
        retiredRows.map((row) => ({
          userId: args.userId,
          key: STANDING_INSTRUCTION_KEY,
          valueSignature: valueSignature(row.stored),
          proposedFactId: row.factId,
          reason: args.reason ?? null,
        })),
      )
      .onConflictDoNothing();

    for (const row of retiredRows) {
      await appendStandingInstructionObservation(
        {
          userId: args.userId,
          operation: "forget",
          factId: row.factId,
          instruction: row.value,
          reason:
            row.factId === args.factId
              ? (args.reason ?? null)
              : `same words as ${args.factId}${args.reason ? `: ${args.reason}` : ""}`,
          source: args.source,
        },
        tx,
      );
    }

    return { instruction: named.value, retiredFactIds: retiredRows.map((row) => row.factId) };
  });

  if (!forgotten) return { ok: false, status: "not_found" };

  emitReplicachePokes([args.userId]);

  return { ok: true, status: "forgotten", factId: args.factId, ...forgotten };
}

/**
 * A v1 value with the edit applied. `words` replaces the `phrasing`, which triage and the
 * briefing read, and the `directive` of an address row. A class row derives its directive from
 * its target and has no label.
 */
function editedV1Value(
  value: StandingInstructionValue,
  edit: { words: string | null; senderLabel: string | null | undefined },
): StandingInstructionValue {
  const target = value.target;
  const oneMailbox = targetNamesOneMailbox(target);

  return standingInstructionValueSchema.parse({
    ...value,
    phrasing: edit.words ?? value.phrasing,
    directive: oneMailbox
      ? (edit.words ?? value.directive)
      : renderStandingInstructionDirective(target),
    target:
      oneMailbox && edit.senderLabel !== undefined
        ? { ...target, label: normalizeOptionalLabel(edit.senderLabel) }
        : target,
  });
}

function v1Label(value: StandingInstructionValue): string | null {
  return targetNamesOneMailbox(value.target) ? (value.target.label ?? null) : null;
}

function sameV1Words(a: StandingInstructionValue, b: StandingInstructionValue): boolean {
  return a.phrasing === b.phrasing && a.directive === b.directive && v1Label(a) === v1Label(b);
}

/**
 * Change the words or the label of a v1 instruction by superseding its rows. New words go to
 * every active v1 row with the same words, so triage and the briefing read only the new words.
 * A label goes to the named row only.
 */
export async function editStandingInstruction(
  args: EditStandingInstructionArgs,
): Promise<EditStandingInstructionResult> {
  const parsed = editStandingInstructionArgsSchema.parse(args);
  const words = normalizeOptionalLabel(parsed.directive);

  const outcome = await db().transaction(async (tx): Promise<EditStandingInstructionResult> => {
    const at = await lockStandingInstructionCapture(tx, parsed.userId);
    const rows = await readManagedStandingInstructions(tx, parsed.userId, at);
    const named = rows.find((row) => row.factId === parsed.factId);

    if (!named) return { ok: false, status: "not_found" };

    if (named.v1 === null) {
      return {
        ok: false,
        status: "revise_with_remember",
        instructionId: named.value.instructionId,
        message:
          "This instruction is schemaVersion 2. Revise it with system.remember and this " +
          "instructionId.",
      };
    }

    const namedV1 = named.v1;

    // Report the refused edit, else `edited` or `unchanged` reads as if it applied.
    const droppedInputs: StandingInstructionDroppedInput[] =
      !targetNamesOneMailbox(namedV1.target) && parsed.senderLabel !== undefined
        ? ["senderLabel"]
        : [];

    const group = words === null ? [named] : sameWordsRows(rows, named);
    const sameWordsNotEdited = group.filter((row) => row.v1 === null).map((row) => row.factId);

    const planned = group.flatMap((row) => {
      if (row.v1 === null) return [];

      const next = editedV1Value(row.v1, {
        words,
        senderLabel: row.factId === named.factId ? parsed.senderLabel : undefined,
      });

      return sameV1Words(next, row.v1) ? [] : [{ factId: row.factId, previous: row.v1, next }];
    });

    if (planned.length === 0) {
      return {
        ok: true,
        status: "unchanged",
        factId: named.factId,
        instruction: namedV1,
        droppedInputs,
        sameWordsNotEdited,
      };
    }

    await lockStandingInstructionRows(
      tx,
      parsed.userId,
      planned.map((row) => row.factId),
    );

    let namedSuccessor: { factId: string; instruction: StandingInstructionValue } | null = null;
    let editedCount = 0;

    for (const row of planned) {
      const successorId = await supersedeStandingInstruction(tx, {
        userId: parsed.userId,
        factId: row.factId,
        nextValue: row.next,
        previousValue: row.previous,
        source: parsed.source,
        provenance: args.provenance,
        at,
      });

      if (successorId === null) continue;

      editedCount += 1;

      if (row.factId === named.factId) {
        namedSuccessor = { factId: successorId, instruction: row.next };
      }
    }

    if (editedCount === 0) return { ok: false, status: "not_found" };

    return {
      ok: true,
      status: "edited",
      factId: namedSuccessor?.factId ?? named.factId,
      previousFactId: named.factId,
      instruction: namedSuccessor?.instruction ?? namedV1,
      editedCount,
      droppedInputs,
      sameWordsNotEdited,
    };
  });

  if (outcome.ok && outcome.status === "edited") emitReplicachePokes([parsed.userId]);

  return outcome;
}

/**
 * Close one active row, insert its successor, and append the observation, in the caller's
 * transaction at the capture clock. Null when another writer closed the row first.
 */
async function supersedeStandingInstruction(
  tx: DbTransaction,
  args: {
    userId: string;
    factId: string;
    nextValue: StandingInstructionValue;
    previousValue: StandingInstructionValue;
    source?: MemorySource | undefined;
    provenance: UserClaimProvenance;
    at: CaptureClock;
  },
): Promise<string | null> {
  const [closed] = await tx
    .update(userFacts)
    .set({
      status: "edited",
      validUntil: sql`${args.at}::timestamptz`,
      rowVersion: sql`${userFacts.rowVersion} + 1`,
    })
    .where(
      and(eq(userFacts.id, args.factId), activeStandingInstructionsWhere(args.userId, args.at)),
    )
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
      author: args.provenance.author,
      evidence: [...args.provenance.evidence],
      producer: args.provenance.producer,
      validFrom: sql`${args.at}::timestamptz`,
      validUntil: null,
      supersedesId: args.factId,
    })
    .returning({ id: userFacts.id });

  if (!inserted) throw new Error("[memory.standing-instructions] edit insert returned no row");

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

  return inserted.id;
}
