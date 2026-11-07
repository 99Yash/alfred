import {
  getObjectKindDef,
  gmailEmailInterpretationPayloadSchema,
  isBuiltInObjectStateProvider,
  isObjectStateProvider,
  todoSourcesSchema,
  type GmailEmailInterpretationPayload,
  type ObjectIdentity,
  type ObjectStateProvider,
  type TriageCategory,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { observationFamilyHeads, observations, todos } from "@alfred/db/schemas";
import { logger } from "@alfred/logging";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  candidateIdentity,
  identityProbeFromGatedLinks,
  objectStateStore,
  reconcileEvidence,
  type CandidateKey,
  type ObjectState,
  type ReconcileCandidates,
} from "@alfred/assistant/connections";
import { loopVerifierForKey, type LoopVerifier } from "@alfred/assistant/connections/verified-pull";
import type { ExtraLoopMail } from "./loops";
import { liveObservationHeadJoin } from "./observations";

/**
 * The verify set of `verifyLoops` (ADR-0120 decision 4): the mails in the window, the open todos,
 * and the things that their keys and links point to.
 */

/** The triage categories whose mails open a loop (decision 4). */
const LOOP_CATEGORIES: ReadonlySet<TriageCategory> = new Set<TriageCategory>([
  "urgent",
  "action_needed",
  "follow_up",
]);

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
export interface LoopThing {
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
  /** The oldest mail that points to the thing. An `unverified` thing holds the next window here. */
  oldestMailAt: Date | null;
}

/**
 * The live head of each `email_interpretation` family in the window, in a loop category. The
 * category filter runs in SQL, so a mail in another category never leaves the database.
 * `unreadable` counts the rows in a loop category whose payload this build cannot parse.
 */
export async function readLoopMails(
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
        inArray(sql<string>`(${observations.payload} ->> 'category')`, [...LOOP_CATEGORIES]),
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
export function withExtraMails(
  stored: readonly LoopMail[],
  extra: readonly ExtraLoopMail[],
): LoopMail[] {
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
export async function readOpenTodoIdentities(userId: string): Promise<ObjectIdentity[]> {
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
export async function collectThings(args: {
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

    if (thing.oldestMailAt === null || mail.occurredAt < thing.oldestMailAt) {
      thing.oldestMailAt = mail.occurredAt;
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

    // The candidate keys that resolved. A link proved by identity or nomination is no key.
    const resolvedKeys = new Set(
      linked.flatMap(({ key }) =>
        key.match === "exact" || key.match === "prefix"
          ? [candidateIdentity({ ...key, match: key.match })]
          : [],
      ),
    );

    for (const { state } of authoritative) {
      if (!isLoopKind(state.provider, state.kind)) continue;

      const thing = byObject.get(state.objectId) ?? newThing(state);

      byObject.set(state.objectId, thing);
      point(thing, mail);
    }

    // Case 3: an exact key with a reader and no row. A mail with a built-in thing still adds it,
    // because one mail can be about more than one thing.
    for (const key of mail.storedKeys) {
      if (key.match !== "exact") continue;

      const ref = candidateIdentity({ ...key, reading: "about" });

      if (resolvedKeys.has(ref)) continue;

      const reader = loopVerifierForKey(key.provider, key.keyKind);

      if (!reader || !isLoopKind(key.provider, reader.kind)) continue;

      const thing = byKey.get(ref) ?? {
        provider: key.provider,
        kind: reader.kind,
        state: null,
        keyRead: { verifier: reader.verifier, key },
        keyUrl: key.keyValue.startsWith("https://") ? key.keyValue : null,
        documentIds: new Set<string>(),
        newestMailAt: null,
        oldestMailAt: null,
      };

      byKey.set(ref, thing);
      point(thing, mail);
    }
  }

  logSoftEdgeLoops(softEdge);

  const todoStates = await objectStateStore.getByIdentities(args.userId, args.todoIdentities);

  for (const state of todoStates.values()) {
    if (byObject.has(state.objectId)) continue;

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
    oldestMailAt: null,
  };
}

/**
 * The time of a fact for the current state: the provider time of its newest timed fact, else the
 * receipt time of the last applied fact. The store clears `providerEventAt` when a fact with no
 * provider time sets a new native state, so this never gives the time of an older state.
 */
export function factTime(state: ObjectState): Date | null {
  return state.providerEventAt ?? state.stateDeliveredAt;
}
