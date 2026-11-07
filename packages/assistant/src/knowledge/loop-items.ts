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

/** Decision 8. An item that the contract rejects is dropped and logged, never repaired. */
export async function toLoopItems(
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
