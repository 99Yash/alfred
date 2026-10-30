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
  standingInstructionScopesIntersect,
  memorySourceSchema,
  readStoredStandingInstruction,
  STANDING_INSTRUCTION_SCHEMA_VERSION_V2,
  standingInstructionValueSchema,
  standingInstructionValueV2Schema,
  type rememberInput,
  type StandingInstructionEffect,
  SUPPRESSION_EFFECTS,
  targetMatchesSender,
  targetNamesOneMailbox,
  type StandingInstructionValueV2,
  type MemorySource,
  type ObservationSource,
  type StandingInstructionDroppedInput,
  type StandingInstructionOverlap,
  type StandingInstructionScopeNarrowing,
  type StandingInstructionTarget,
  type StandingInstructionTargetKind,
  type StandingInstructionValue,
} from "@alfred/contracts";
import { db, type DbTransaction } from "@alfred/db";
import { sha256Canonical } from "@alfred/db/hash";
import { createId, type DbRunner } from "@alfred/db/helpers";
import { rejectedInferences, standingInstructionSetRevisions, userFacts } from "@alfred/db/schemas";
import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { emitReplicachePokes } from "@alfred/assistant/triggers";
import { insertObservation } from "./observations";
import { valueSignature } from "./signature";

export const STANDING_INSTRUCTION_LIST_LIMIT = 100;

/** A stored v1 row, for the v1 writer and `edit_instruction`. Both leave with plan PR 5. */
export interface ActiveStandingInstructionV1 {
  factId: string;
  value: StandingInstructionValue;
  validFrom: Date;
}

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

/** One message's sender, as the consumer holds it. */
interface SenderLookup {
  /** A bare address or a raw `From` header. An unparseable value matches nothing. */
  sender: string | null | undefined;
  /** The mailbox the message reached. A per-account instruction matches only its own mailbox. */
  accountId: string | null;
}

/** An instruction whose sender-wide target hits one mail. A target hit covers the whole mail. */
export type StandingInstructionTargetHit = ActiveStandingInstruction & {
  matchedVia: StandingInstructionTargetKind;
};

/**
 * The instructions that can apply to one mail (ADR-0113). `targetHits` are decided in code.
 * `scoped` go to the triage model for the scope match: each has a `scope`, and its
 * `senderFilter` is absent or hits the sender. A filter alone never matches.
 */
export type MailStandingInstructions =
  | {
      kind: "loaded";
      /** The per-user set revision, read before the instructions. */
      setRevision: number;
      targetHits: StandingInstructionTargetHit[];
      scoped: ActiveStandingInstruction[];
    }
  | { kind: "read_failed"; error: unknown };

export type LoadedMailStandingInstructions = Extract<MailStandingInstructions, { kind: "loaded" }>;

/** A user's active standing instructions, read once. The match methods are pure, so one read serves a loop. */
interface StandingInstructionSet<Mail extends MailStandingInstructions> {
  /** No active instruction. A failed read is never empty, so `forMail` still reports it. */
  readonly isEmpty: boolean;
  /**
   * Every target hit and every scoped candidate for one mail. Each consumer derives its
   * result from these with `deriveEffectiveTriage` (ADR-0113).
   */
  forMail(sender: SenderLookup): Mail;
}

/** A set that loaded. `setRevision` is the per-user set revision, read before the instructions. */
interface LoadedStandingInstructionSet extends StandingInstructionSet<LoadedMailStandingInstructions> {
  readonly setRevision: number;
}

/**
 * A `"report"` load. The `onReadFailure: "report"` key rejects a `"throw"`
 * load and a value without the key where the todo lane needs fail-closed
 * reporting. A value that writes the key by hand still compiles. Review owns
 * that case.
 */
export interface ReportedStandingInstructionSet extends StandingInstructionSet<MailStandingInstructions> {
  readonly onReadFailure: "report";
}

/**
 * Each consumer owns its read-failure policy, so the caller must state it:
 * - `"throw"`: the returned promise rejects with the read error. No method reports `read_failed`.
 * - `"report"`: the promise always resolves. On a failed read, every method returns `read_failed`.
 */
export function standingInstructions(args: {
  userId: string;
  onReadFailure: "throw";
}): Promise<LoadedStandingInstructionSet>;
export function standingInstructions(args: {
  userId: string;
  onReadFailure: "report";
}): Promise<ReportedStandingInstructionSet>;
export async function standingInstructions(args: {
  userId: string;
  onReadFailure: "throw" | "report";
}): Promise<ReportedStandingInstructionSet | LoadedStandingInstructionSet> {
  if (args.onReadFailure === "throw") return loadStandingInstructionSet(args.userId);

  try {
    return {
      ...(await loadStandingInstructionSet(args.userId)),
      onReadFailure: "report" as const,
    };
  } catch (error) {
    return {
      isEmpty: false,
      onReadFailure: "report" as const,
      forMail: () => ({ kind: "read_failed", error }),
    };
  }
}

/**
 * The set revision first, then the instructions. A write between the two reads leaves the
 * stored revision older than the instructions, so a later reader sees a change and reads
 * `unknown`. The other order could claim a newer revision for older instructions.
 */
async function loadStandingInstructionSet(userId: string) {
  const setRevision = await readStandingInstructionSetRevision(userId);

  return standingInstructionsOf(await listActiveStandingInstructions(userId), setRevision);
}

/** Pure, for tests that build the instructions by hand. Consumers read with `standingInstructions`. */
export function standingInstructionsOf(
  instructions: readonly ActiveStandingInstruction[],
  setRevision = 0,
): LoadedStandingInstructionSet {
  return {
    isEmpty: instructions.length === 0,
    setRevision,
    forMail(sender) {
      const email = normalizeEmailAddress(sender.sender);

      const hits = (targets: readonly StandingInstructionTarget[] | undefined) =>
        email === null
          ? undefined
          : targets?.find((target) => targetMatchesSender(target, email, sender.accountId));

      const targetHits: StandingInstructionTargetHit[] = [];
      const scoped: ActiveStandingInstruction[] = [];

      for (const instruction of instructions) {
        const hit = hits(instruction.value.targets);

        // A target hit decides the match. The scope adds nothing for this mail.
        if (hit) {
          targetHits.push({ ...instruction, matchedVia: hit.kind });
          continue;
        }

        if (instruction.value.scope === undefined) continue;

        // A scope bound to one mailbox never matches mail of another.
        if (
          instruction.value.accountId !== undefined &&
          instruction.value.accountId !== sender.accountId
        ) {
          continue;
        }

        const filter = instruction.value.senderFilter;

        if (filter !== undefined && !hits(filter)) continue;

        scoped.push(instruction);
      }

      return { kind: "loaded", setRevision, targetHits, scoped };
    },
  };
}

/** No row reads as 0. */
async function readStandingInstructionSetRevision(userId: string): Promise<number> {
  const [row] = await db()
    .select({ revision: standingInstructionSetRevisions.revision })
    .from(standingInstructionSetRevisions)
    .where(eq(standingInstructionSetRevisions.userId, userId))
    .limit(1);

  return row?.revision ?? 0;
}

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

// ─── Capture (v2, ADR-0113) ─────────────────────────────────────────────────

/** The parsed `system.remember` input, after the user confirmed it on its card. */
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

/** The stored value for one parsed input at one identity. Capture and its preview share it. */
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

/**
 * The value that capture would store for this input as a new instruction, with no read and no
 * write. A review tool matches it over stored mail before the owner stores it. The caller
 * names the id, so an `exceptionOf` between two previews can point at a preview.
 */
export function previewStandingInstructionValue(
  input: SaveStandingInstructionInput,
  instructionId: string,
):
  | { ok: true; value: StandingInstructionValueV2 }
  | Extract<SaveStandingInstructionResult, { status: "invalid_sender" }> {
  const parsed = parseCaptureInput(input);

  if (!parsed.ok) return parsed;

  return { ok: true, value: captureValue(input, parsed, { instructionId, revision: 0 }) };
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
 * close the rows it replaces, and it still sweeps todos.
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
 * nothing. A repeat of a finished capture then plans `existing`, and its todo sweep runs again.
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
        "Nothing was stored: the instruction changed after this card was proposed. List the " +
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
 * Store a v2 standing instruction, or revise one (ADR-0113 capture). The user already
 * confirmed the input on its card. Code mints the instruction id; a revision keeps it and
 * adds 1 to `revision`. The `user_facts` trigger raises the set revision with the write.
 */
export async function saveStandingInstruction(args: {
  userId: string;
  input: SaveStandingInstructionInput;
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

        // Each app writer of a v2 row takes the capture lock, but a v1 edit does not. Roll back.
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
            source,
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

/** A prompt-budget cap, not a correctness one. `overlapCount` and `relatedCount` keep the true total. */
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

function selectActiveStandingInstructionFacts(
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

/** Every active instruction of any stored version, as v2. */
function listActiveStandingInstructions(userId: string): Promise<ActiveStandingInstruction[]> {
  return readStoredStandingInstructions(userId);
}

/**
 * One capture or forget at a time for each user, so a revision and an exception see a stable
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

/** The wall clock after the capture lock, as Postgres text. Bind it as `${at}::timestamptz`. */
type CaptureClock = string;

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

// ─── Management (user-driven: list / forget / edit) ─────────────────────────
// Chat-only. Background inference never calls these, so it cannot edit or delete what
// the user said. Forget is a soft reject; edit supersedes. Each mutation appends a
// `user_standing_instruction` observation in the same transaction (ADR-0067).

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
}

export interface StandingInstructionListResult {
  instructions: StandingInstructionSummary[];
  totalActive: number;
  truncated: boolean;
  limit: number;
}

export type ForgetStandingInstructionResult =
  | { ok: true; status: "forgotten"; factId: string; instruction: StandingInstructionValueV2 }
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
  | { ok: false; status: "not_found" }
  | { ok: false; status: "revise_with_remember"; instructionId: string; message: string };

export const editStandingInstructionArgsSchema = z.object({
  userId: z.string().min(1),
  factId: z.string().min(1),
  directive: z.string().nullish(),
  senderLabel: z.string().nullish(),
  source: memorySourceSchema.optional(),
});

export type EditStandingInstructionArgs = z.infer<typeof editStandingInstructionArgsSchema>;

/** Active standing instructions of any stored version, newest first, capped. */
export async function listStandingInstructions(
  userId: string,
): Promise<StandingInstructionListResult> {
  const instructions = (await readStoredStandingInstructions(userId)).map(
    (row): StandingInstructionSummary => ({
      factId: row.factId,
      schemaVersion: row.storedVersion,
      instruction: row.value,
      validFrom: row.validFrom,
    }),
  );

  const capped = instructions.slice(0, STANDING_INSTRUCTION_LIST_LIMIT);

  return {
    instructions: capped,
    totalActive: instructions.length,
    truncated: instructions.length > capped.length,
    limit: STANDING_INSTRUCTION_LIST_LIMIT,
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

/**
 * Null for an unknown, foreign, non-instruction, or retired id. A v2 row is `v2`: only
 * `system.remember` revises it, behind the confirmation card.
 */
async function loadOwnedStandingInstruction(
  userId: string,
  factId: string,
): Promise<
  { kind: "v1"; value: StandingInstructionValue } | { kind: "v2"; instructionId: string } | null
> {
  const [row] = await db()
    .select({ value: userFacts.value })
    .from(userFacts)
    .where(activeStandingInstructionWhere(userId, factId))
    .limit(1);

  if (!row) return null;

  const v2 = standingInstructionValueV2Schema.safeParse(row.value);

  if (v2.success) return { kind: "v2", instructionId: v2.data.instructionId };

  const parsed = standingInstructionValueSchema.safeParse(row.value);

  return parsed.success ? { kind: "v1", value: parsed.data } : null;
}

export async function forgetStandingInstruction(args: {
  userId: string;
  factId: string;
  reason?: string | null | undefined;
  source?: MemorySource | undefined;
}): Promise<ForgetStandingInstructionResult> {
  const forgotten = await db().transaction(async (tx) => {
    // Wait for a capture that reads this row as a revision or exception target.
    const at = await lockStandingInstructionCapture(tx, args.userId);

    // The `status = 'confirmed'` guard is the concurrency control; the lock lets the loser see the retired row.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`standing_instruction:${args.userId}:${args.factId}`}, 0))`,
    );

    const [old] = await tx
      .select({ value: userFacts.value })
      .from(userFacts)
      .where(activeStandingInstructionWhere(args.userId, args.factId, at))
      .limit(1);

    if (!old) return null;

    // Any stored version. The rejection signature keys on the stored value.
    const instruction = readStoredStandingInstruction(old.value, args.factId);

    if (!instruction) return null;

    const [row] = await tx
      .update(userFacts)
      .set({
        status: "rejected",
        validUntil: sql`${at}::timestamptz`,
        rowVersion: sql`${userFacts.rowVersion} + 1`,
      })
      .where(activeStandingInstructionWhere(args.userId, args.factId, at))
      .returning({ id: userFacts.id });

    if (!row) return null;

    await tx
      .insert(rejectedInferences)
      .values({
        userId: args.userId,
        key: STANDING_INSTRUCTION_KEY,
        valueSignature: valueSignature(old.value),
        proposedFactId: args.factId,
        reason: args.reason ?? null,
      })
      .onConflictDoNothing();

    await appendStandingInstructionObservation(
      {
        userId: args.userId,
        operation: "forget",
        factId: args.factId,
        instruction,
        reason: args.reason ?? null,
        source: args.source,
      },
      tx,
    );

    return instruction;
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

  if (existing.kind === "v2") {
    return {
      ok: false,
      status: "revise_with_remember",
      instructionId: existing.instructionId,
      message:
        "This instruction is schemaVersion 2. Revise it with system.remember and this " +
        "instructionId, so the user confirms the change on its card.",
    };
  }

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

function activeStandingInstructionWhere(userId: string, factId: string, at?: CaptureClock) {
  return and(eq(userFacts.id, factId), activeStandingInstructionsWhere(userId, at));
}

/** Active at `at`, the capture clock, or else at the transaction start. */
function activeStandingInstructionsWhere(userId: string, at?: CaptureClock) {
  const clock = at === undefined ? sql`now()` : sql`${at}::timestamptz`;

  return and(
    eq(userFacts.userId, userId),
    eq(userFacts.key, STANDING_INSTRUCTION_KEY),
    eq(userFacts.status, "confirmed"),
    lte(userFacts.validFrom, clock),
    or(isNull(userFacts.validUntil), gt(userFacts.validUntil, clock)),
  );
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

type StandingInstructionObservationOperation = "remember" | "edit" | "forget";

async function appendStandingInstructionObservation(
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
