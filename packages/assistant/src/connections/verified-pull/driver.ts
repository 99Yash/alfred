import type { IntegrationActivityItem, ObjectStateProvider } from "@alfred/contracts";
import { deliveryInstantNow, objectStateStore, type ObjectState } from "../object-state";

/**
 * The verified pull (#1094, #1192; ADR-0062 amendment 2026-09-20).
 * A failure-only provider mails failures but not recoveries, so read current state at gather time.
 * The read folds through the same store guards as a push.
 * It is a deterministic read over a user grant, so no approval step applies.
 */
export type VerifiedPullStatus = "success" | "failure" | "pending";

/** What one read proved. A `null` read mints nothing and never closes a loop (ADR-0048-D). */
export interface VerifiedPullReading {
  status: VerifiedPullStatus;
  /** The dedup key, such as a deployment id. */
  attemptId: string;
  providerEventTime: Date | null;
  url: string | null;
}

/** The body the provider's reducer folds. */
export interface VerifiedPullReceipt {
  eventType: string;
  payload: unknown;
}

export interface VerifiedPullTriggerItem {
  subject?: string | null;
  from?: string | null;
  snippet?: string | null;
}

export interface VerifiedPullResult<Target, Names> {
  target: Target;
  targetId: string;
  names: Names | null;
  /** The row's state after the fold, which the briefing prints. */
  status: VerifiedPullStatus | null;
  /** `duplicate`: this attempt already folded. `stale`: the store kept a newer row, and the fields show the row. */
  outcome: "applied" | "duplicate" | "stale" | "unverified";
  attemptId: string | null;
  url: string | null;
  occurredAt: string | null;
}

/** One provider's half of the verified pull. `Session` is opaque to the driver. */
export interface VerifiedPullProvider<Target, Session, Names> {
  provider: ObjectStateProvider;
  targetKind: string;
  attemptKeyKind: string;
  /** Only triggers a read, never asserts a state. */
  digestSignalsFailure(items: readonly VerifiedPullTriggerItem[]): boolean;
  /** `null` for a row this build did not write. */
  targetFromRow(row: ObjectState): Target | null;
  canonicalTargetId(target: Target): string | null;
  /** Bootstrap targets before any row exists. */
  discoverTargets(userId: string, limit: number): Promise<Target[]>;
  openSession(userId: string): Promise<Session | null>;
  /** Display names only, never identity. */
  resolveNames(session: Session): Promise<Map<string, Names>>;
  readStatus(session: Session, target: Target): Promise<VerifiedPullReading | null>;
  mintReceipt(target: Target, reading: VerifiedPullReading): VerifiedPullReceipt;
  toActivityItem(result: VerifiedPullResult<Target, Names>): IntegrationActivityItem;
}

/** The verdict half of an activity line. The provider adds the rest. */
export interface VerifiedPullVerdict extends Pick<
  IntegrationActivityItem,
  "status" | "severity" | "occurredAt" | "url"
> {
  word: string;
}

const VERDICT_BY_STATUS = {
  success: { word: "succeeded", status: "succeeded", severity: "info" },
  failure: { word: "failed", status: "failed", severity: "warning" },
  pending: { word: "building", status: "open", severity: "info" },
} as const satisfies Record<
  VerifiedPullStatus,
  Pick<VerifiedPullVerdict, "word" | "status" | "severity">
>;

const UNVERIFIED_VERDICT = {
  word: "unverified",
  status: "needs_attention",
  severity: "info",
} as const satisfies Pick<VerifiedPullVerdict, "word" | "status" | "severity">;

export function verifiedPullVerdict<Target, Names>(
  result: VerifiedPullResult<Target, Names>,
): VerifiedPullVerdict {
  return {
    ...(result.status ? VERDICT_BY_STATUS[result.status] : UNVERIFIED_VERDICT),
    occurredAt: result.occurredAt ?? new Date().toISOString(),
    ...(result.url && result.url.startsWith("https://") ? { url: result.url } : {}),
  };
}

export interface VerifiedPull {
  provider: ObjectStateProvider;
  gather(args: {
    userId: string;
    digestItems: readonly VerifiedPullTriggerItem[];
  }): Promise<IntegrationActivityItem[]>;
}

export const MAX_VERIFIED_PULL_TARGETS = 5;

/**
 * Read and fold each target. Dedup is by attempt, not by outcome, so a new
 * attempt with the same status still advances the row. The verdict is re-read
 * from the row, so a stale read that lost never prints.
 */
export async function pullVerifiedTargets<Target, Session, Names>(
  source: VerifiedPullProvider<Target, Session, Names>,
  userId: string,
  targets: readonly Target[],
): Promise<VerifiedPullResult<Target, Names>[]> {
  const session = await source.openSession(userId).catch(() => null);

  const names = session
    ? await source.resolveNames(session).catch(() => new Map<string, Names>())
    : new Map<string, Names>();

  const results: VerifiedPullResult<Target, Names>[] = [];

  for (const target of targets.slice(0, MAX_VERIFIED_PULL_TARGETS)) {
    const targetId = source.canonicalTargetId(target);

    if (!targetId) {
      results.push({
        target,
        targetId: "",
        names: null,
        status: null,
        outcome: "unverified",
        attemptId: null,
        url: null,
        occurredAt: null,
      });
      continue;
    }

    const reading = session ? await source.readStatus(session, target).catch(() => null) : null;

    if (!reading) {
      results.push({
        target,
        targetId,
        names: names.get(targetId) ?? null,
        status: null,
        outcome: "unverified",
        attemptId: null,
        url: null,
        occurredAt: null,
      });
      continue;
    }

    const result: VerifiedPullResult<Target, Names> = {
      target,
      targetId,
      names: names.get(targetId) ?? null,
      status: reading.status,
      outcome: "applied",
      attemptId: reading.attemptId,
      url: reading.url,
      occurredAt: reading.providerEventTime?.toISOString() ?? null,
    };

    // The reducer writes one attempt key per folded attempt.
    const folded = await objectStateStore.resolveByKey(
      userId,
      source.provider,
      source.attemptKeyKind,
      reading.attemptId,
    );

    if (folded) {
      result.outcome = "duplicate";
      results.push(result);
      continue;
    }

    const receipt = source.mintReceipt(target, reading);

    await objectStateStore.applyEvent({
      userId,
      provider: source.provider,
      eventType: receipt.eventType,
      action: null,
      payload: receipt.payload,
      // No receipt row, so a JS clock instant (zero microseconds).
      deliveredAt: deliveryInstantNow(),
    });

    // The recency guard may refuse a stale read, so trust the row, not the read.
    const stored = await objectStateStore.getByIdentity(userId, {
      provider: source.provider,
      kind: source.targetKind,
      externalId: targetId,
    });

    const storedStatus =
      stored?.nativeState === "success" ||
      stored?.nativeState === "failure" ||
      stored?.nativeState === "pending"
        ? stored.nativeState
        : null;

    if (!stored || storedStatus === reading.status) {
      results.push(result);
      continue;
    }

    results.push({
      ...result,
      status: storedStatus,
      outcome: "stale",
      attemptId: null,
      url: stored.url,
      occurredAt: stored.stateDeliveredAt?.toISOString() ?? result.occurredAt,
    });
  }

  return results;
}

/**
 * Pick targets in order: failed rows, active rows, a bootstrap when there are no rows,
 * or all rows when a failure mail arrived. Otherwise do nothing.
 * Never throws; a fault returns no lines (ADR-0048-D).
 */
async function gatherVerifiedPull<Target, Session, Names>(
  source: VerifiedPullProvider<Target, Session, Names>,
  args: { userId: string; digestItems: readonly VerifiedPullTriggerItem[] },
): Promise<IntegrationActivityItem[]> {
  try {
    const failed = await objectStateStore.list(args.userId, source.provider, {
      kind: source.targetKind,
      stateCategory: "failed",
      limit: MAX_VERIFIED_PULL_TARGETS,
    });

    const active =
      failed.length < MAX_VERIFIED_PULL_TARGETS
        ? await objectStateStore.list(args.userId, source.provider, {
            kind: source.targetKind,
            stateCategory: "active",
            limit: MAX_VERIFIED_PULL_TARGETS - failed.length,
          })
        : [];

    let targets = rowsToTargets(source, [...failed, ...active]);

    if (targets.length === 0) {
      const known = await objectStateStore.list(args.userId, source.provider, {
        kind: source.targetKind,
        limit: MAX_VERIFIED_PULL_TARGETS,
      });

      if (known.length === 0) {
        targets = await source.discoverTargets(args.userId, MAX_VERIFIED_PULL_TARGETS);
      } else if (source.digestSignalsFailure(args.digestItems)) {
        targets = rowsToTargets(source, known);
      } else {
        return [];
      }
    }

    if (targets.length === 0) return [];

    const results = await pullVerifiedTargets(source, args.userId, targets);

    return results.map((result) => source.toActivityItem(result));
  } catch {
    return [];
  }
}

function rowsToTargets<Target, Session, Names>(
  source: VerifiedPullProvider<Target, Session, Names>,
  rows: readonly ObjectState[],
): Target[] {
  const targets: Target[] = [];

  for (const row of rows) {
    const target = source.targetFromRow(row);

    if (target) targets.push(target);
  }

  return targets;
}

/** Bind a provider to the driver for the registry. */
export function defineVerifiedPull<Target, Session, Names>(
  source: VerifiedPullProvider<Target, Session, Names>,
): VerifiedPull {
  return {
    provider: source.provider,
    gather: (args) => gatherVerifiedPull(source, args),
  };
}
