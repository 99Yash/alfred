import {
  BRIEFING_LOOP_DOCUMENTS_MAX,
  BRIEFING_LOOP_TITLE_MAX,
  briefingLoopSchema,
  closesOpenAsk,
  getObjectKindDef,
  gmailEmailInterpretationPayloadSchema,
  isAbsorbingState,
  isBuiltInObjectStateProvider,
  isObjectStateProvider,
  sanitizeErrorMessage,
  sourceIdentitySchema,
  todoSourcesSchema,
  type BriefingLoop,
  type ClosureProof,
  type GmailEmailInterpretationPayload,
  type LoopEvidenceTier,
  type ObjectIdentity,
  type ObjectStateProvider,
  type SourceIdentity,
  type TriageCategory,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import {
  loopVerificationRuns,
  mcpConnections,
  observationFamilyHeads,
  observations,
  todos,
} from "@alfred/db/schemas";
import { logger } from "@alfred/logging";
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import {
  deliveryInstantNow,
  identityProbeFromGatedLinks,
  objectStateStore,
  readActivityCoverage,
  reconcileEvidence,
  type ActivityCoverage,
  type CandidateKey,
  type ObjectState,
  type ReconcileCandidates,
} from "@alfred/assistant/connections";
import {
  loopVerifierFor,
  loopVerifierForKey,
  type LoopReadBatch,
  type LoopVerifier,
  type LoopVerifierRead,
} from "@alfred/assistant/connections/verified-pull";
import { liveObservationHeadJoin, readObservationFamilyHeads } from "./observations";

/**
 * `verifyLoops` (ADR-0120 decisions 4 to 8). A loop is a thing, an `integration_objects` row, that
 * a priority mail or an open todo points to. The stored state is the verdict. A live read runs
 * only when the stored state is ambiguous. All reads run first, and then one transaction folds
 * every fact and records the run. The result has one item for each loop, with the verdict `open`,
 * `closed`, or `unverified`.
 */

/** The triage categories whose mails open a loop (decision 4). */
const LOOP_CATEGORIES: ReadonlySet<TriageCategory> = new Set<TriageCategory>([
  "urgent",
  "action_needed",
  "follow_up",
]);

const DAY_MS = 24 * 60 * 60 * 1000;

/** The window of the first run (decision 4). */
const FIRST_RUN_WINDOW_MS = 30 * DAY_MS;

/** Each later run reads at least this far back, so a gap in the briefings does not lose a loop. */
const MIN_WINDOW_MS = 3 * DAY_MS;

/**
 * The live reads of one run (decision 5). It replaces the three caps of 5 of the old passes. The
 * things with the newest evidence come first. A thing over the cap is `unverified`.
 */
const MAX_LIVE_READS = 10;

/** The providers whose deliveries an activity source records, so a coverage read can see a gap. */
const COVERED_PROVIDERS: ReadonlySet<ObjectStateProvider> = new Set(["github"]);

export interface VerifyLoopsArgs {
  userId: string;
  /** The time of the run. The window ends here. */
  clock: Date;
  /**
   * Mails that a read before this run pointed at a thing: the approved MCP health read (ADR-0120
   * slice 2). Such a mail often names no key, so triage stored no row for it.
   */
  extraMails?: readonly ExtraLoopMail[] | undefined;
}

/** A mail and the keys that a read before this run gave it. */
export interface ExtraLoopMail {
  documentId: string;
  occurredAt: Date;
  /** The current triage verdict. Only a loop category counts, as for a stored row. */
  category: TriageCategory;
  keys: readonly CandidateKey<"about">[];
}

export interface VerifyLoopsResult {
  /** One item for each loop, newest evidence first. */
  loops: BriefingLoop[];
  windowStart: Date;
  /** Stored rows whose payload this build cannot parse. Their mails point to nothing. */
  unreadableRows: number;
}

/** One mail of the verify set. */
interface LoopMail {
  documentId: string;
  occurredAt: Date;
  /** The keys that triage stored. Only these can name a thing with no row (case 3). */
  storedKeys: GmailEmailInterpretationPayload["objects"]["keys"];
  /** The stored keys, and the keys of a read before this run. */
  candidates: CandidateKey<"about">[];
  links: GmailEmailInterpretationPayload["objects"]["links"];
}

/** One thing of the verify set, before the verdict. */
interface LoopThing {
  provider: ObjectStateProvider;
  kind: string;
  /** The stored row. `null`: a key names the thing, but no row exists (case 3). */
  state: ObjectState | null;
  /** The verifier and the target of a case-3 thing. */
  keyRead: { verifier: LoopVerifier; key: { keyKind: string; keyValue: string } } | null;
  /** The URL that the key names, for a case-3 item. */
  keyUrl: string | null;
  documentIds: Set<string>;
  /** The newest mail that points to the thing. `null` for a todo-only thing. */
  newestMailAt: Date | null;
}

/** What one thing became in this run. */
interface ThingOutcome {
  state: ObjectState | null;
  evidence: LoopEvidenceTier;
  /** `true`: a read was due and gave no fact, or the commit failed. */
  readFailed: boolean;
}

export async function verifyLoops(args: VerifyLoopsArgs): Promise<VerifyLoopsResult> {
  const { userId, clock } = args;
  const windowStart = await readWindowStart(userId, clock);

  const [mailRead, todoIdentities] = await Promise.all([
    readLoopMails(userId, windowStart, clock),
    readOpenTodoIdentities(userId),
  ]);

  const things = await collectThings({
    userId,
    mails: withExtraMails(mailRead.mails, args.extraMails ?? []),
    todoIdentities,
  });

  const ambiguous = await findAmbiguous({ userId, clock, things });
  const outcomes = await readAndCommit({ userId, clock, windowStart, things, ambiguous });
  const loops = await toLoopItems(userId, things, outcomes);

  logger.info(
    {
      userId,
      windowStart: windowStart.toISOString(),
      mails: mailRead.mails.length,
      unreadableRows: mailRead.unreadable,
      things: things.length,
      ambiguous: ambiguous.size,
      verdicts: countVerdicts(loops),
    },
    "[loops] verified",
  );

  return { loops, windowStart, unreadableRows: mailRead.unreadable };
}

/** Decision 4: the last committed run, at least 3 days back. The first run reads 30 days. */
async function readWindowStart(userId: string, clock: Date): Promise<Date> {
  const [last] = await db()
    .select({ ranAt: loopVerificationRuns.ranAt })
    .from(loopVerificationRuns)
    .where(eq(loopVerificationRuns.userId, userId))
    .orderBy(desc(loopVerificationRuns.ranAt))
    .limit(1);

  const minimum = clock.getTime() - MIN_WINDOW_MS;

  if (!last) return new Date(clock.getTime() - FIRST_RUN_WINDOW_MS);

  return new Date(Math.min(last.ranAt.getTime(), minimum));
}

/** The live head of each `email_interpretation` family in the window, in a loop category. */
async function readLoopMails(
  userId: string,
  windowStart: Date,
  clock: Date,
): Promise<{ mails: LoopMail[]; unreadable: number }> {
  const rows = await db()
    .select({ occurredAt: observations.occurredAt, payload: observations.payload })
    .from(observations)
    .innerJoin(observationFamilyHeads, liveObservationHeadJoin())
    .where(
      and(
        eq(observations.userId, userId),
        eq(observations.source, "gmail"),
        eq(observations.kind, "email_interpretation"),
        gte(observations.occurredAt, windowStart),
        lte(observations.occurredAt, clock),
      ),
    )
    .orderBy(desc(observations.occurredAt));

  const mails: LoopMail[] = [];
  let unreadable = 0;

  for (const row of rows) {
    const parsed = gmailEmailInterpretationPayloadSchema.safeParse(row.payload);

    if (!parsed.success) {
      unreadable += 1;
      continue;
    }

    if (!LOOP_CATEGORIES.has(parsed.data.category)) continue;

    const { keys, links } = parsed.data.objects;

    mails.push({
      documentId: parsed.data.documentId,
      occurredAt: row.occurredAt,
      storedKeys: keys,
      candidates: keys.map((key) => ({ ...key, reading: "about" })),
      links,
    });
  }

  return { mails, unreadable };
}

/** Add the keys of each extra mail to its stored row, or add the mail when it has no row. */
function withExtraMails(stored: readonly LoopMail[], extra: readonly ExtraLoopMail[]): LoopMail[] {
  const byDocument = new Map(stored.map((mail) => [mail.documentId, { ...mail }]));

  for (const mail of extra) {
    if (!LOOP_CATEGORIES.has(mail.category) || mail.keys.length === 0) continue;

    const known = byDocument.get(mail.documentId);

    if (known) {
      known.candidates = [...known.candidates, ...mail.keys];
      continue;
    }

    byDocument.set(mail.documentId, {
      documentId: mail.documentId,
      occurredAt: mail.occurredAt,
      storedKeys: [],
      candidates: [...mail.keys],
      links: [],
    });
  }

  return [...byDocument.values()];
}

/** The object identities that the user's open todos carry (decision 4). No time limit. */
async function readOpenTodoIdentities(userId: string): Promise<ObjectIdentity[]> {
  const rows = await db()
    .select({ sources: todos.sources })
    .from(todos)
    .where(and(eq(todos.userId, userId), eq(todos.status, "open")));

  const identities: ObjectIdentity[] = [];

  for (const row of rows) {
    const parsed = todoSourcesSchema.safeParse(row.sources);

    if (!parsed.success) continue;

    for (const source of parsed.data) {
      if (!isObjectStateProvider(source.provider)) continue;

      if (!isLoopKind(source.provider, source.kind)) continue;

      identities.push({ provider: source.provider, kind: source.kind, externalId: source.id });
    }
  }

  return identities;
}

/** A kind that can close an ask. An attempt never resolves, so it is never a loop. */
function isLoopKind(provider: ObjectStateProvider, kind: string): boolean {
  return (getObjectKindDef(provider, kind)?.closesAskOn.length ?? 0) > 0;
}

/**
 * Resolve the stored keys and links of each mail against the store now (decision 3). A built-in
 * thing wins over an MCP thing, and a soft edge (`nomination`) points to nothing. A key that
 * resolves to no row and has a reader is a case-3 thing.
 */
async function collectThings(args: {
  userId: string;
  mails: readonly LoopMail[];
  todoIdentities: readonly ObjectIdentity[];
}): Promise<LoopThing[]> {
  const subjects: ReconcileCandidates<"about">[] = args.mails.map((mail) => ({
    id: mail.documentId,
    keys: mail.candidates,
    probe: identityProbeFromGatedLinks(mail.links, "about"),
  }));

  const reconciled = await reconcileEvidence({ userId: args.userId, subjects });
  const byObject = new Map<string, LoopThing>();
  const byKey = new Map<string, LoopThing>();
  const softEdge: { documentId: string; providers: ObjectStateProvider[] }[] = [];

  const point = (thing: LoopThing, mail: LoopMail): void => {
    thing.documentIds.add(mail.documentId);

    if (thing.newestMailAt === null || mail.occurredAt > thing.newestMailAt) {
      thing.newestMailAt = mail.occurredAt;
    }
  };

  for (const mail of args.mails) {
    const linked = (reconciled.get(mail.documentId) ?? []).filter(
      (object) => object.key.match !== "nomination",
    );

    // The stored links passed the sender gate, so a mail with links came from a provider.
    if (linked.length === 0 && mail.links.length > 0) {
      softEdge.push({
        documentId: mail.documentId,
        providers: [...new Set(mail.links.map((link) => link.provider))],
      });
    }

    const builtIn = linked.filter((object) => isBuiltInObjectStateProvider(object.state.provider));
    const authoritative = builtIn.length > 0 ? builtIn : linked;
    const resolvedKeys = new Set(linked.map((object) => keyRef(object.key)));

    for (const { state } of authoritative) {
      if (!isLoopKind(state.provider, state.kind)) continue;

      const thing = byObject.get(state.objectId) ?? newThing(state);

      byObject.set(state.objectId, thing);
      point(thing, mail);
    }

    // Case 3: an exact key with a reader and no row. A mail with a built-in thing still adds it,
    // because one mail can be about more than one thing.
    for (const key of mail.storedKeys) {
      if (key.match !== "exact" || resolvedKeys.has(keyRef(key))) continue;

      const reader = loopVerifierForKey(key.provider, key.keyKind);

      if (!reader || !isLoopKind(key.provider, reader.kind)) continue;

      const ref = keyRef(key);

      const thing = byKey.get(ref) ?? {
        provider: key.provider,
        kind: reader.kind,
        state: null,
        keyRead: { verifier: reader.verifier, key },
        keyUrl: key.keyValue.startsWith("https://") ? key.keyValue : null,
        documentIds: new Set<string>(),
        newestMailAt: null,
      };

      byKey.set(ref, thing);
      point(thing, mail);
    }
  }

  logSoftEdgeLoops(softEdge);

  for (const identity of args.todoIdentities) {
    const state = await objectStateStore.getByIdentity(args.userId, identity);

    if (!state || byObject.has(state.objectId)) continue;

    byObject.set(state.objectId, newThing(state));
  }

  return [...byObject.values(), ...byKey.values()].toSorted(
    (a, b) => (b.newestMailAt?.getTime() ?? 0) - (a.newestMailAt?.getTime() ?? 0),
  );
}

/**
 * The mails from a provider's own sender that point to no thing by a hard edge (ADR-0109). A mail
 * with only a `nomination` counts. The runtime closure verifier of ADR-0109 waits until this line
 * names a mail whose object a read can close. It logs a run with no such mail too, so the series
 * shows that the pass ran.
 */
function logSoftEdgeLoops(
  softEdge: readonly { documentId: string; providers: ObjectStateProvider[] }[],
): void {
  const byProvider: Partial<Record<ObjectStateProvider, number>> = {};

  for (const { providers } of softEdge) {
    for (const provider of providers) byProvider[provider] = (byProvider[provider] ?? 0) + 1;
  }

  logger.info(
    {
      softEdgeLoops: softEdge.length,
      byProvider,
      documentIds: softEdge.map(({ documentId }) => documentId),
    },
    "[loops] soft-edge loops with no hard edge",
  );
}

function newThing(state: ObjectState): LoopThing {
  return {
    provider: state.provider,
    kind: state.kind,
    state,
    keyRead: null,
    keyUrl: null,
    documentIds: new Set(),
    newestMailAt: null,
  };
}

function keyRef(key: { provider: string; keyKind: string; keyValue: string }): string {
  return JSON.stringify([key.provider, key.keyKind, key.keyValue]);
}

/** The time of the fact that set the state: the provider time, else the delivery time. */
function factTime(state: ObjectState): Date | null {
  return state.providerEventAt ?? state.stateDeliveredAt;
}

/**
 * Decision 5: the things whose stored state is ambiguous. An absorbing state is never ambiguous: no
 * later fact can move it. The three cases: no row, a mail newer than the fact, a blind source.
 */
async function findAmbiguous(args: {
  userId: string;
  clock: Date;
  things: readonly LoopThing[];
}): Promise<Set<LoopThing>> {
  const ambiguous = new Set<LoopThing>();
  const blindCheck: { thing: LoopThing; state: ObjectState; at: Date }[] = [];

  for (const thing of args.things) {
    const { state } = thing;

    // Case 3.
    if (state === null) {
      ambiguous.add(thing);
      continue;
    }

    if (isAbsorbingState(state.provider, state.kind, state.stateCategory)) continue;

    const at = factTime(state);

    // Case 1. A state with no time cannot be older than nothing, so it is read.
    if (at === null || (thing.newestMailAt !== null && thing.newestMailAt > at)) {
      ambiguous.add(thing);
      continue;
    }

    // A fold of this run (the MCP health read just before it) leaves no time for a gap.
    if (state.stateDeliveredAt !== null && state.stateDeliveredAt >= args.clock) continue;

    // Case 2, for a provider with no activity source: nothing can show that it was not blind.
    if (!COVERED_PROVIDERS.has(state.provider)) {
      ambiguous.add(thing);
      continue;
    }

    blindCheck.push({ thing, state, at });
  }

  if (blindCheck.length === 0) return ambiguous;

  const oldest = blindCheck.reduce((min, { at }) => (at < min ? at : min), args.clock);
  const coverage = await readCoverage(args.userId, { start: oldest, end: args.clock }, args.clock);

  for (const { thing, state, at } of blindCheck) {
    if (isBlindAfter(coverage, state.provider, at)) ambiguous.add(thing);
  }

  return ambiguous;
}

/** The coverage entries, or `null` when the read faulted: then each source counts as blind. */
async function readCoverage(
  userId: string,
  window: { start: Date; end: Date },
  clock: Date,
): Promise<readonly ActivityCoverage[] | null> {
  try {
    const read = await readActivityCoverage({
      userId,
      window,
      clock,
      readFamilyHeads: readObservationFamilyHeads,
    });

    return read.entries;
  } catch (err) {
    logger.warn({ err, userId }, "[loops] coverage read failed; covered things count as blind");

    return null;
  }
}

/**
 * Case 2: the coverage of the source is not `live` between the fact and now. A silent gap that
 * ended before the fact does not matter. Every other failure makes the whole window blind.
 */
function isBlindAfter(
  coverage: readonly ActivityCoverage[] | null,
  provider: ObjectStateProvider,
  at: Date,
): boolean {
  const entry = coverage?.find(
    (candidate) => candidate.source.kind === "integration" && candidate.source.slug === provider,
  );

  if (!entry) return true;

  if (entry.state === "live") return false;

  const { failure } = entry;

  if (failure.cause !== "silent") return true;

  if ("gap" in failure) return true;

  return failure.gaps.some((gap) => gap.to > at);
}

/** One read that this run admitted, with its verifier batch and its target id. */
interface PlannedRead {
  thing: LoopThing;
  batch: LoopReadBatch;
  targetId: string;
}

/**
 * Decision 7: read all, then one commit. The admitted reads run first, outside any transaction.
 * Then one transaction folds every fact and records the run. A commit fault makes each read thing
 * `unverified`, and the run has no row, so the next run reads the same window again.
 */
async function readAndCommit(args: {
  userId: string;
  clock: Date;
  windowStart: Date;
  things: readonly LoopThing[];
  ambiguous: ReadonlySet<LoopThing>;
}): Promise<Map<LoopThing, ThingOutcome>> {
  const batches = new Map<LoopVerifier, LoopReadBatch>();
  const planned: PlannedRead[] = [];
  // The distinct targets of each batch. Two things can name one target, so one read serves both.
  const idsByBatch = new Map<LoopReadBatch, Set<string>>();
  let liveReads = 0;

  const batchOf = (verifier: LoopVerifier): LoopReadBatch => {
    const batch = batches.get(verifier) ?? verifier.batch();

    batches.set(verifier, batch);

    return batch;
  };

  // `things` is newest evidence first, so the cap keeps the newest.
  for (const thing of args.things) {
    if (!args.ambiguous.has(thing)) continue;

    const verifier = thing.state
      ? loopVerifierFor(thing.state.provider, thing.state.kind)
      : (thing.keyRead?.verifier ?? null);

    if (!verifier) continue;

    const batch = batchOf(verifier);

    const targetId = thing.state
      ? batch.planState(thing.state)
      : thing.keyRead
        ? batch.planKey(thing.keyRead.key)
        : null;

    if (targetId === null) continue;

    const ids = idsByBatch.get(batch) ?? new Set<string>();

    if (!ids.has(targetId)) {
      if (liveReads >= MAX_LIVE_READS) continue;

      ids.add(targetId);
      liveReads += 1;
    }

    idsByBatch.set(batch, ids);
    planned.push({ thing, batch, targetId });
  }

  const readsByBatch = new Map<LoopReadBatch, ReadonlyMap<string, LoopVerifierRead>>(
    await Promise.all(
      [...idsByBatch].map(
        async ([batch, ids]) => [batch, await batch.read(args.userId, [...ids])] as const,
      ),
    ),
  );

  const readByThing = new Map<LoopThing, LoopVerifierRead>();
  const facts = new Map<string, LoopVerifierRead>();

  for (const { thing, batch, targetId } of planned) {
    const read = readsByBatch.get(batch)?.get(targetId);

    if (!read) continue;

    readByThing.set(thing, read);
    facts.set(identityRef(read.identity), read);
  }

  const outcomes = new Map<LoopThing, ThingOutcome>();
  let committed = true;

  try {
    const deliveredAt = deliveryInstantNow();

    await objectStateStore.applyEvents({
      userId: args.userId,
      facts: [...facts.values()].map((read) => ({ event: read.fact, deliveredAt })),
      inTransaction: async (tx) => {
        await tx.insert(loopVerificationRuns).values({
          userId: args.userId,
          ranAt: args.clock,
          windowStart: args.windowStart,
          things: args.things.length,
          liveReads,
          facts: facts.size,
        });
      },
    });
  } catch (err) {
    committed = false;
    logger.warn({ err, userId: args.userId }, "[loops] commit failed; read things stay unverified");
  }

  // The rows after the fold. The recency guard can refuse an older fact, so the row is the truth.
  const after = new Map<string, ObjectState | null>();

  if (committed) {
    await Promise.all(
      [...facts.entries()].map(async ([ref, read]) => {
        after.set(ref, await objectStateStore.getByIdentity(args.userId, read.identity));
      }),
    );
  }

  for (const thing of args.things) {
    if (!args.ambiguous.has(thing)) {
      outcomes.set(thing, { state: thing.state, evidence: "stored_state", readFailed: false });
      continue;
    }

    const read = readByThing.get(thing);
    const state = read ? after.get(identityRef(read.identity)) : undefined;

    outcomes.set(
      thing,
      state
        ? { state, evidence: "live_read", readFailed: false }
        : { state: thing.state, evidence: "stored_state", readFailed: true },
    );
  }

  return outcomes;
}

function identityRef(identity: ObjectIdentity): string {
  return JSON.stringify([identity.provider, identity.kind, identity.externalId]);
}

/** Decision 8. An item that the contract rejects is dropped and logged, never repaired. */
async function toLoopItems(
  userId: string,
  things: readonly LoopThing[],
  outcomes: ReadonlyMap<LoopThing, ThingOutcome>,
): Promise<BriefingLoop[]> {
  const serverIds = await readMcpServerIds(userId, things);
  const items: BriefingLoop[] = [];

  for (const { thing, outcome } of mergeByObject(things, outcomes)) {
    const source = sourceOf(thing.provider, outcome.state, serverIds);

    if (!source) continue;

    const { state } = outcome;

    const parsed = briefingLoopSchema.safeParse({
      verdict: verdictOf(outcome),
      evidence: outcome.evidence,
      source,
      kind: thing.kind,
      stateCategory: state?.stateCategory ?? null,
      nativeState: state?.nativeState ?? null,
      stateAt: state ? (factTime(state)?.toISOString() ?? null) : null,
      title: state?.title ? sanitizeErrorMessage(state.title, BRIEFING_LOOP_TITLE_MAX) : null,
      url: httpsUrlOrNull(state?.url ?? thing.keyUrl),
      documentIds: [...thing.documentIds].slice(0, BRIEFING_LOOP_DOCUMENTS_MAX),
    });

    if (parsed.success) {
      items.push(parsed.data);
    } else {
      logger.warn({ userId, issues: parsed.error.issues }, "[loops] contract rejected an item");
    }
  }

  return items;
}

/**
 * One entry for each stored row. A case-3 read can fold into a row that a mail already resolved,
 * for example when two URL spellings name one pull request. The entries then join: the first one
 * stays, it takes the mails of the second, and it takes the outcome of a read that succeeded.
 */
function mergeByObject(
  things: readonly LoopThing[],
  outcomes: ReadonlyMap<LoopThing, ThingOutcome>,
): { thing: LoopThing; outcome: ThingOutcome }[] {
  const merged = new Map<string, { thing: LoopThing; outcome: ThingOutcome }>();

  things.forEach((thing, index) => {
    const outcome = outcomes.get(thing);

    if (!outcome) return;

    const key = outcome.state?.objectId ?? `unread:${String(index)}`;
    const known = merged.get(key);

    if (!known) {
      merged.set(key, { thing: { ...thing, documentIds: new Set(thing.documentIds) }, outcome });

      return;
    }

    for (const documentId of thing.documentIds) known.thing.documentIds.add(documentId);

    if (known.outcome.readFailed && !outcome.readFailed) known.outcome = outcome;
  });

  return [...merged.values()];
}

/**
 * A closing state needs the proof that its kind demands (ADR-0103). A stored row of a kind that
 * needs a live confirmation is always a blind read (case 2), so it reaches here only after a read.
 */
function verdictOf(outcome: ThingOutcome): BriefingLoop["verdict"] {
  const { state } = outcome;

  if (outcome.readFailed || !state) return "unverified";

  if (state.stateCategory === "active" || state.stateCategory === "failed") return "open";

  const proof: ClosureProof =
    outcome.evidence === "live_read" ? "live_confirmation" : "stored_projection";

  return closesOpenAsk(state.provider, state.kind, state.stateCategory, proof)
    ? "closed"
    : "unverified";
}

function httpsUrlOrNull(value: string | null): string | null {
  return value?.startsWith("https://") ? value : null;
}

/** The server of each MCP thing, from the connection that its external id names. */
async function readMcpServerIds(
  userId: string,
  things: readonly LoopThing[],
): Promise<ReadonlyMap<string, string>> {
  const connectionIds = things.flatMap((thing) =>
    thing.state?.provider === "mcp" ? [mcpConnectionIdOf(thing.state.externalId)] : [],
  );

  if (connectionIds.length === 0) return new Map();

  const rows = await db()
    .select({ id: mcpConnections.id, serverId: mcpConnections.serverId })
    .from(mcpConnections)
    .where(and(eq(mcpConnections.userId, userId), inArray(mcpConnections.id, connectionIds)));

  return new Map(rows.map((row) => [row.id, row.serverId]));
}

/** `approvedMcpHealthExternalId` joins the connection and the loop key with `|`. */
function mcpConnectionIdOf(externalId: string): string {
  return externalId.split("|")[0] ?? externalId;
}

function sourceOf(
  provider: ObjectStateProvider,
  state: ObjectState | null,
  serverIds: ReadonlyMap<string, string>,
): SourceIdentity | null {
  const candidate =
    provider === "mcp"
      ? {
          kind: "custom_mcp",
          serverId: state ? serverIds.get(mcpConnectionIdOf(state.externalId)) : undefined,
        }
      : { kind: "integration", slug: provider };

  const parsed = sourceIdentitySchema.safeParse(candidate);

  return parsed.success ? parsed.data : null;
}

function countVerdicts(loops: readonly BriefingLoop[]) {
  const counts = { open: 0, closed: 0, unverified: 0 } satisfies Record<
    BriefingLoop["verdict"],
    number
  >;

  for (const loop of loops) counts[loop.verdict] += 1;

  return counts;
}
