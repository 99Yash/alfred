import {
  BRIEFING_LOOP_DOCUMENTS_MAX,
  BRIEFING_LOOP_TITLE_MAX,
  briefingLoopSchema,
  closesOpenAsk,
  sanitizeErrorMessage,
  sourceIdentitySchema,
  type BriefingLoop,
  type ClosureProof,
  type ObjectStateProvider,
  type SourceIdentity,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { mcpConnections } from "@alfred/db/schemas";
import { logger } from "@alfred/logging";
import { and, eq, inArray } from "drizzle-orm";
import type { ObjectState } from "@alfred/assistant/connections";
import { factTime, type LoopThing } from "./loop-set";
import type { ThingOutcome } from "./loops";

/** The items of `verifyLoops` (ADR-0120 decision 8): one checked `BriefingLoop` for each thing. */

/** A `closed` item. Its type holds the closing category. */
export type ClosedLoopItem = Extract<BriefingLoop, { verdict: "closed" }>;

export interface LoopItems {
  /**
   * One checked item for each thing. A `closed` thing that no mail points to is here only when the
   * fact that closed it is in the window (decision 8): a todo of a thing that closed long ago is
   * not news. A closed thing with a mail stays, because `list_emails_since` reads the mails from
   * the store and this item is how the composer knows that the mail is closed.
   */
  loops: BriefingLoop[];
  /**
   * Each mail whose every thing is `closed`, with the item of its first thing. It reads every mail
   * of each thing, with no cap, and it holds a thing that closed before the window too. A thing
   * with no checked item counts as not closed, so its mails stay.
   */
  closedMails: Map<string, ClosedLoopItem>;
}

/** Decision 8. An item that the contract rejects is dropped and logged, never repaired. */
export async function toLoopItems(args: {
  userId: string;
  things: readonly LoopThing[];
  outcomes: ReadonlyMap<LoopThing, ThingOutcome>;
  windowStart: Date;
}): Promise<LoopItems> {
  const { userId } = args;
  const serverIds = await readMcpServerIds(userId, args.things);
  const loops: BriefingLoop[] = [];
  // Each mail, and for each thing that it points to the closed item or `null`.
  const pointed = new Map<string, (ClosedLoopItem | null)[]>();

  for (const { thing, outcome } of mergeByObject(args.things, args.outcomes)) {
    const item = checkedItem(userId, thing, outcome, serverIds);
    const closing = item?.verdict === "closed" ? item : null;

    for (const documentId of thing.documentIds) {
      pointed.set(documentId, [...(pointed.get(documentId) ?? []), closing]);
    }

    if (!item) continue;

    if (closing && thing.documentIds.size === 0 && !closedInWindow(closing, args.windowStart)) {
      continue;
    }

    loops.push(item);
  }

  const closedMails = new Map<string, ClosedLoopItem>();

  for (const [documentId, closings] of pointed) {
    const closed = closings.filter((closing) => closing !== null);
    const [first] = closed;

    if (first && closed.length === closings.length) closedMails.set(documentId, first);
  }

  return { loops, closedMails };
}

/** An item with no state time cannot show that it closed in the window. */
function closedInWindow(item: ClosedLoopItem, windowStart: Date): boolean {
  return item.stateAt !== null && new Date(item.stateAt) >= windowStart;
}

/** The checked item of one thing, or `null` when it has no source or the contract rejects it. */
function checkedItem(
  userId: string,
  thing: LoopThing,
  outcome: ThingOutcome,
  serverIds: ReadonlyMap<string, string>,
): BriefingLoop | null {
  const { state } = outcome;
  const source = sourceOf(thing.provider, state, serverIds);

  if (!source) {
    logger.warn(
      { userId, provider: thing.provider, kind: thing.kind, objectId: state?.objectId ?? null },
      "[loops] thing has no source; no item, and its mails stay",
    );

    return null;
  }

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

  if (!parsed.success) {
    logger.warn(
      { userId, issues: parsed.error.issues },
      "[loops] contract rejected an item; its mails stay",
    );

    return null;
  }

  return parsed.data;
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

    if (known.outcome.unverified !== null && outcome.unverified === null) known.outcome = outcome;
  });

  return [...merged.values()];
}

/**
 * A closing state needs the proof that its kind demands (ADR-0103). A kind that needs a live
 * confirmation gets it only from a read of this run: a read of `verifyLoops`, or a pull that folded
 * just before it. A stored row of such a kind is always a blind read (case 2).
 */
function verdictOf(outcome: ThingOutcome): BriefingLoop["verdict"] {
  const { state } = outcome;

  if (outcome.unverified !== null || !state) return "unverified";

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
