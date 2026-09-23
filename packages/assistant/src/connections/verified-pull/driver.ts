import type { IntegrationActivityItem, ObjectStateProvider } from "@alfred/contracts";
import { deliveryInstantNow, objectStateStore, type ObjectState } from "../object-state";

/**
 * The verified pull (#1094, generalized by #1192) — the second named closure
 * source beside the verified push (ADR-0062 amendment 2026-09-20).
 *
 * A failure-only provider mails a failure and stays silent on success, so
 * email evidence can observe the failure and can never observe the recovery.
 * The pull takes an authenticated read of CURRENT state at gather time
 * instead: one read holds the whole answer, and a read proving a later
 * success folds through the same store guards every push travels (unknown
 * kind/unknown token no-write, per-kind absorbing, the
 * `(providerEventTime, deliveredAt)` recency rule).
 *
 * This file is the provider-agnostic half: the trigger order, the target cap,
 * the dedup by attempt identity, the fold, and the stale-read re-read. A
 * {@link VerifiedPullProvider} is the irreducible half — which rows are its
 * targets, how to discover them, how to read one over the user's grant, and
 * how to phrase the verdict. The provider's session is opaque here, so an
 * MCP-backed read and a REST-backed read plug in the same way.
 *
 * Approval floors gate AGENT discretion; this deterministic gather-time read
 * over a user-connected grant is the calendar/weather gatherer pattern, so it
 * bypasses staging/approval by construction and holds no write tool.
 */

/** The three-state outcome vocabulary a pull-folded row holds. */
export type VerifiedPullStatus = "success" | "failure" | "pending";

/**
 * What one authenticated read proved, parsed from `unknown` at the transport
 * boundary. `null` from the reader means the read failed, timed out, or
 * returned an unknown state — the driver mints nothing, so the loop stays
 * live (ADR-0048-D). A null is never a close.
 */
export interface VerifiedPullReading {
  status: VerifiedPullStatus;
  /** The attempt identity (a deployment id) the dedup key is written under. */
  attemptId: string;
  /** Provider-clock instant of the attempt, absent when the API names none. */
  providerEventTime: Date | null;
  url: string | null;
}

/**
 * A minted pull receipt: the structured body the provider's reducer folds.
 * Named (not anonymous) so the mint's return type keeps its evidence.
 */
export interface VerifiedPullReceipt {
  eventType: string;
  payload: unknown;
}

/** A surfaced digest item, the email half of the gather trigger. */
export interface VerifiedPullTriggerItem {
  subject?: string | null;
  from?: string | null;
  snippet?: string | null;
}

/** One pulled target's verdict for the gather step. */
export interface VerifiedPullResult<Target, Names> {
  target: Target;
  targetId: string;
  names: Names | null;
  /**
   * The stored row's state after folding this read — the verdict the briefing
   * prints. Null when the read failed, timed out, or puzzled, or when the row
   * holds a token outside the three-state vocabulary.
   */
  status: VerifiedPullStatus | null;
  /**
   * `applied` — the read folded and the row holds what it proved (a later
   * success advances the target row, a later failure reopens it, per the
   * store's recency rule).
   * `duplicate` — this exact attempt already folded (its attempt key
   * exists), so redeliveries, retries, and identical consecutive reads mint
   * nothing. `stale` — the read was verified but
   * older than the stored row, so the store kept the row; `status` and
   * `occurredAt` carry the row, not the read. `unverified` — the read proved
   * nothing; the loop stays live.
   */
  outcome: "applied" | "duplicate" | "stale" | "unverified";
  attemptId: string | null;
  url: string | null;
  occurredAt: string | null;
}

/**
 * One failure-only provider's half of the verified pull. `Session` is
 * whatever authenticated handle the provider reads through; the driver only
 * threads it from {@link openSession} to the reads.
 */
export interface VerifiedPullProvider<Target, Session, Names> {
  provider: ObjectStateProvider;
  /** The object kind whose rows are pull targets (the succession target). */
  targetKind: string;
  /** The key kind the reducer writes once per folded attempt. */
  attemptKeyKind: string;
  /**
   * Whether a surfaced digest item signals a failure — trigger-only: it
   * causes a verified read, never an assertion.
   */
  digestSignalsFailure(items: readonly VerifiedPullTriggerItem[]): boolean;
  /** Read a target back off a stored row, or null for a row this build did not write. */
  targetFromRow(row: ObjectState): Target | null;
  /** The target's canonical external id, or null when it has none. */
  canonicalTargetId(target: Target): string | null;
  /**
   * Bootstrap targets from the provider's own lists, before any target row
   * exists, at most `limit`. A transport fault discovers nothing.
   */
  discoverTargets(userId: string, limit: number): Promise<Target[]>;
  /** Open the authenticated read, or null when the user has no usable grant. */
  openSession(userId: string): Promise<Session | null>;
  /** Best-effort display names keyed by canonical target id. Never identity. */
  resolveNames(session: Session): Promise<Map<string, Names>>;
  /** Read current state for one target. Unknown output is null, never a guess. */
  readStatus(session: Session, target: Target): Promise<VerifiedPullReading | null>;
  /** The only constructor of the receipt body the provider's reducer folds. */
  mintReceipt(target: Target, reading: VerifiedPullReading): VerifiedPullReceipt;
  /** Phrase one result as a briefing activity item. */
  toActivityItem(result: VerifiedPullResult<Target, Names>): IntegrationActivityItem;
}

/** A provider bound to the driver, with its type parameters closed over. */
export interface VerifiedPull {
  provider: ObjectStateProvider;
  gather(args: {
    userId: string;
    digestItems: readonly VerifiedPullTriggerItem[];
  }): Promise<IntegrationActivityItem[]>;
}

/** How many targets one gather reads per provider. */
export const MAX_VERIFIED_PULL_TARGETS = 5;

/**
 * Pull current state for each target and fold it. The dedup is by attempt
 * identity, not by outcome: when this exact attempt already folded (its
 * attempt key exists), nothing is minted — so redeliveries, retries, and
 * identical consecutive reads cannot move the row. A second, different
 * attempt with the SAME status still folds, so the row advances to the new
 * attempt id, url, and provider instant instead of keeping the old ones. When
 * the outcome differs, the store's own recency rule decides the write (a stale
 * read loses to the row), and the verdict is re-read off the row — so the
 * briefing prints what the projection holds, never what a losing read claimed.
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

    // Duplicate iff this exact attempt folded before — the reducer writes one
    // attempt key per folded attempt beside the target row, so the key is the
    // folded set. A same-status check here would skip a second, different
    // failed attempt and leave the row pointing at the old attempt id, url,
    // and provider instant.
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

    // A same-status row for an OLDER attempt is not a duplicate: the mint
    // below re-asserts the status with the new attempt's identity, and the
    // store's recency rule advances the row (or keeps it, re-read below).
    const receipt = source.mintReceipt(target, reading);

    await objectStateStore.applyEvent({
      userId,
      provider: source.provider,
      eventType: receipt.eventType,
      action: null,
      payload: receipt.payload,
      // A pull mints no receipt row, so this instant comes from a JavaScript
      // clock and is honestly millisecond-true with zero microseconds.
      deliveredAt: deliveryInstantNow(),
    });

    // The store's recency guard may refuse a stale read — a SUCCESS for an
    // older attempt loses to the failed row — so the verdict is re-read off
    // the row, never the parsed read. Otherwise the briefing prints a success
    // the projection refused to write.
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
 * The gather-time hook for one provider: a surfaced failure triggers a live
 * status read, and the read's verdicts return as activity lines.
 *
 * Trigger, in order: failed target rows (the loop is live — re-verify),
 * active target rows (a pull is in flight — follow it to its outcome),
 * zero target rows (bootstrap from the provider's own lists), or a failure
 * mail over rows that all read resolved (the failure is new — re-verify).
 * All-resolved rows with no mail: quiet, no pull.
 *
 * Never throws: any fault — no credential, no transport, no rows, a DB
 * blip — resolves to no lines, and every loop stays live. A failed read is
 * an absence, never evidence (ADR-0048-D).
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

/** Bind a provider to the driver, closing over its type parameters for the registry. */
export function defineVerifiedPull<Target, Session, Names>(
  source: VerifiedPullProvider<Target, Session, Names>,
): VerifiedPull {
  return {
    provider: source.provider,
    gather: (args) => gatherVerifiedPull(source, args),
  };
}
