import {
  assertNever,
  GATHER_PROVENANCE_MAX,
  GATHER_STALE_PROVENANCE_MAX,
  INTEGRATIONS,
  type BlockingGatherProvenance,
  type GatherInput,
  type GatherProvenance,
  type IntegrationActivityItem,
  type IntegrationHealth,
  type LiveProviderSlug,
} from "@alfred/contracts";
import { GoogleCredentialSelectionError, type GoogleCredential } from "@alfred/integrations/google";
import { logger } from "@alfred/logging";
import { readIntegrationAvailability } from "@alfred/assistant/connections";
import type {
  GithubMergedReadOutcome,
  VerifiedPullOutcome,
} from "@alfred/assistant/connections/verified-pull";

/** At least one statement. A producer cannot return an empty list for an input. */
export type StatedProvenance = readonly [GatherProvenance, ...GatherProvenance[]];

/**
 * A gather input's value and the statement of how Alfred got it (ADR-0117 decision 1). The
 * statement is non-empty, and the gather's table is total over `GATHER_INPUTS`, so each input
 * states at least one entry.
 */
export interface Sourced<T> {
  readonly value: T;
  readonly provenance: StatedProvenance;
}

export function live(input: GatherInput): GatherProvenance {
  return { input, state: "live" };
}

export function readFailed(input: GatherInput, reason: string): GatherProvenance {
  return { input, state: "unavailable", cause: "read_failed", reason, recovery: { kind: "retry" } };
}

/** No account for the input. No block row, because a deliberate disconnect leaves the same state. */
function notConnected(input: GatherInput, integration: LiveProviderSlug): GatherProvenance {
  return {
    input,
    state: "unavailable",
    cause: "not_connected",
    reason: `${INTEGRATIONS[integration].displayName} is not connected.`,
    recovery: { kind: "none" },
  };
}

/**
 * Who reads one entry (ADR-0117 decision 2). This is the one owner of that rule.
 *
 * - `blockRow`: the entry as a row in the connection block. The row also stops a quiet morning.
 *   `null`: no row.
 * - `composerFact`: the composer gets the entry as a fact, for an input that the composer reads.
 *   The composer keeps its own list of the inputs that it reads.
 * - `log`: the entry is a line in the operator log.
 */
export interface ProvenanceAudience {
  readonly blockRow: BlockingGatherProvenance | null;
  readonly composerFact: boolean;
  readonly log: boolean;
}

const NO_AUDIENCE: ProvenanceAudience = { blockRow: null, composerFact: false, log: false };

/** A statement that the composer and the operator read, but that is not a block row. */
const FACT_AND_LOG: ProvenanceAudience = { blockRow: null, composerFact: true, log: true };

export function provenanceAudience(entry: GatherProvenance): ProvenanceAudience {
  switch (entry.state) {
    case "live":
      return NO_AUDIENCE;
    // No surface can set the replaced fact, and an old item is not news, so neither is a row.
    case "fallback":
    case "stale":
      return FACT_AND_LOG;
    case "unavailable":
      switch (entry.cause) {
        // The user can reconnect, so the entry is a row.
        case "scope_missing":
        case "needs_reauth":
          return { blockRow: entry, composerFact: true, log: true };
        case "read_failed":
          return FACT_AND_LOG;
        // The composer says that the source is not connected. No row: a deliberate disconnect
        // leaves the same state (ADR-0100 amendment 2026-10-28, item 3).
        case "not_connected":
          return FACT_AND_LOG;
        case "no_place":
          return FACT_AND_LOG;
        default:
          return assertNever(entry, "unavailable provenance cause");
      }

    default:
      return assertNever(entry, "provenance state");
  }
}

/** The entries that are rows in the connection block. */
export function blockingProvenance(
  provenance: readonly GatherProvenance[],
): BlockingGatherProvenance[] {
  return provenance.flatMap((entry) => {
    const { blockRow } = provenanceAudience(entry);

    return blockRow ? [blockRow] : [];
  });
}

/**
 * A Google credential that does not select. `scope_required`: the account is connected without
 * this input's grant. `connection_required`: no active row. The availability read tells the two
 * cases apart: a row that is not active (`needs_reauth`) is a repair, and no row is the state
 * that a deliberate disconnect leaves (ADR-0100 amendment 2026-10-28, item 3).
 */
export async function googleSelectionProvenance(
  userId: string,
  input: GatherInput,
  integration: LiveProviderSlug,
  err: GoogleCredentialSelectionError,
): Promise<GatherProvenance> {
  const name = INTEGRATIONS[integration].displayName;

  switch (err.reason) {
    case "scope_required":
      return {
        input,
        state: "unavailable",
        cause: "scope_missing",
        reason: `${name} is connected, but without the permission that Alfred needs to read it.`,
        recovery: { kind: "connect", integration },
      };
    case "connection_required":
      return connectionRequiredProvenance(userId, input, integration);
    default:
      return assertNever(err.reason, "Google credential selection reason");
  }
}

async function connectionRequiredProvenance(
  userId: string,
  input: GatherInput,
  integration: LiveProviderSlug,
): Promise<GatherProvenance> {
  let health: IntegrationHealth | null;

  try {
    const snapshot = await readIntegrationAvailability(userId);

    health = snapshot.integrations.get(integration)?.health ?? null;
  } catch (err) {
    logger.warn({ err, userId, integration }, "[briefing.gather] availability read failed");

    return readFailed(
      input,
      `Alfred could not check the ${INTEGRATIONS[integration].displayName} connection.`,
    );
  }

  switch (health) {
    case null:
      return notConnected(input, integration);
    case "needs_reauth":
      return {
        input,
        state: "unavailable",
        cause: "needs_reauth",
        reason: `${INTEGRATIONS[integration].displayName} is connected, but its sign-in no longer works.`,
        recovery: { kind: "connect", integration },
      };
    // A row became active between the two reads. The next run reads it.
    case "active":
      return readFailed(
        input,
        `The ${INTEGRATIONS[integration].displayName} connection changed during the read.`,
      );
    default:
      return assertNever(health, "integration health");
  }
}

/**
 * The email input reads `email_triage`, not Gmail. A failed `email_triage` read throws and fails
 * the gather: the row is `failed`, the watermark does not move, and the next run reads the same
 * window. A stored email statement therefore always follows a completed read. A gather that
 * continued past a failed read would send or suppress, and so move the watermark past mail that
 * it never read.
 *
 * The statement then says whether the source that fills that table can read mail: a Gmail account
 * that selects. A delivery break is not part of it: the history poll still runs, and
 * `broken_connections` carries that fact (ADR-0100 amendment 2026-10-28, revision to item 1). A
 * fault of the credential check is `read_failed`, because Alfred cannot say whether the triaged
 * mail is current. That check must not fail the gather that it describes.
 */
export async function emailProvenance(
  userId: string,
  readCredential: () => Promise<GoogleCredential>,
): Promise<GatherProvenance> {
  try {
    await readCredential();

    return live("email");
  } catch (err) {
    if (err instanceof GoogleCredentialSelectionError) {
      return googleSelectionProvenance(userId, "email", "gmail", err);
    }

    logger.warn({ err, userId }, "[briefing.gather] Gmail credential read failed");

    return readFailed(
      "email",
      "Alfred could not check the Gmail account that fills the email list.",
    );
  }
}

/** `no_connection` is the miss; every other status but `completed` is a fault of the read. */
export function githubMergedProvenance(outcome: GithubMergedReadOutcome): GatherProvenance {
  switch (outcome.status) {
    case "completed":
      return live("github_merged");
    case "no_connection":
      return notConnected("github_merged", "github");
    case "truncated":
      return readFailed("github_merged", "The merged pull request read hit its bounds.");
    case "bad_shape":
      return readFailed(
        "github_merged",
        "The merged pull request read returned an unreadable result.",
      );
    case "failed":
      return readFailed("github_merged", "The merged pull request read failed.");
    default:
      return assertNever(outcome, "GitHub merged read status");
  }
}

/**
 * The verified pull's activity lines and their statement. A pull that faulted is `read_failed`,
 * because its empty list does not prove that nothing changed.
 *
 * An item is stale only when its time is the provider's event time and that time is before the
 * window start. Such an item is real but not news: it leaves the list, and its statement goes to
 * the log (ADR-0117 decision 2). A `delivered` or `observed` time is Alfred's clock, not the
 * event's, so it cannot prove that the event is old, and the item stays. An unreadable time stays
 * for the same reason.
 */
export function splitVerifiedPullActivity(
  outcomes: readonly VerifiedPullOutcome[],
  windowStart: Date,
): Sourced<IntegrationActivityItem[]> {
  const fresh: IntegrationActivityItem[] = [];
  const stale: GatherProvenance[] = [];
  const failed: string[] = [];

  for (const outcome of outcomes) {
    if (outcome.status === "failed") {
      failed.push(INTEGRATIONS[outcome.provider].displayName);
      continue;
    }

    for (const { item, clock } of outcome.items) {
      const occurredAt = Date.parse(item.occurredAt);

      if (
        clock !== "provider_event" ||
        Number.isNaN(occurredAt) ||
        occurredAt >= windowStart.getTime()
      ) {
        fresh.push(item);
        continue;
      }

      stale.push({
        input: "integration_activity",
        state: "stale",
        title: item.title,
        occurredAt: item.occurredAt,
        recovery: { kind: "none" },
      });
    }
  }

  const read: GatherProvenance =
    failed.length === 0
      ? live("integration_activity")
      : readFailed(
          "integration_activity",
          `The live deploy status read failed for ${failed.join(", ")}.`,
        );

  return { value: fresh, provenance: [read, ...stale] };
}

/**
 * The stored list, inside `GATHER_PROVENANCE_MAX`. Every entry that is not `stale` stays, then the
 * stale entries up to `GATHER_STALE_PROVENANCE_MAX`. A drop is a log line, so a long list cannot
 * fail the parse of the stored gather.
 */
export function boundProvenance(
  userId: string,
  provenance: readonly GatherProvenance[],
): GatherProvenance[] {
  const stated = provenance.filter((entry) => entry.state !== "stale");
  const stale = provenance.filter((entry) => entry.state === "stale");
  const kept = [...stated, ...stale.slice(0, GATHER_STALE_PROVENANCE_MAX)];
  const dropped = provenance.length - Math.min(kept.length, GATHER_PROVENANCE_MAX);

  if (dropped > 0) {
    logger.warn(
      { userId, dropped, stated: stated.length, stale: stale.length },
      "[briefing.gather] provenance over its bound; extra entries dropped",
    );
  }

  return kept.slice(0, GATHER_PROVENANCE_MAX);
}

/**
 * Write each entry that `provenanceAudience` gives to the log. The block rule and the composer
 * read the stored list; the log is for the operator (ADR-0117 decision 2).
 */
export function logProvenance(userId: string, provenance: readonly GatherProvenance[]): void {
  const logged = provenance.filter((entry) => provenanceAudience(entry).log);

  if (logged.length === 0) return;

  logger.info({ userId, provenance: logged }, "[briefing.gather] inputs not live");
}
