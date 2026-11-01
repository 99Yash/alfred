import {
  assertNever,
  INTEGRATIONS,
  type GatherInput,
  type GatherProvenance,
  type IntegrationActivityItem,
  type LiveProviderSlug,
} from "@alfred/contracts";
import { GoogleCredentialSelectionError, type GoogleCredential } from "@alfred/integrations/google";
import { logger } from "@alfred/logging";
import type { GithubMergedReadOutcome } from "@alfred/assistant/connections/verified-pull";

/**
 * A gather input's value and the statement of how Alfred got it (ADR-0117 decision 1). The gather
 * stores every statement, so a new input cannot reach the composer without one.
 */
export interface Sourced<T> {
  readonly value: T;
  readonly provenance: readonly GatherProvenance[];
}

export function live(input: GatherInput): GatherProvenance {
  return { input, state: "live" };
}

export function readFailed(input: GatherInput, reason: string): GatherProvenance {
  return { input, state: "unavailable", cause: "read_failed", reason, recovery: { kind: "retry" } };
}

/** No account for the input. Silent, because a deliberate disconnect leaves the same state. */
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
 * A Google credential that does not select. `scope_required`: the account is connected without
 * this input's grant, so the user can repair it. `connection_required`: no account, which is also
 * what a deliberate disconnect leaves, so it is silent (ADR-0100 amendment 2026-10-28, item 3).
 */
export function googleSelectionProvenance(
  input: GatherInput,
  integration: LiveProviderSlug,
  err: GoogleCredentialSelectionError,
): GatherProvenance {
  return err.reason === "scope_required"
    ? {
        input,
        state: "unavailable",
        cause: "scope_missing",
        reason: `${INTEGRATIONS[integration].displayName} is connected, but without the permission that Alfred needs to read it.`,
        recovery: { kind: "connect", integration },
      }
    : notConnected(input, integration);
}

/**
 * The email input reads `email_triage`, not Gmail. A Gmail account that can read mail is what
 * fills that table, so it is the evidence. A delivery break is not: the history poll still runs,
 * and `broken_connections` carries that fact (ADR-0100 amendment 2026-10-28, revision to item 1).
 * Any other fault is `read_failed`: this check must not fail the gather that it describes.
 */
export async function emailProvenance(
  readCredential: () => Promise<GoogleCredential>,
): Promise<GatherProvenance> {
  try {
    await readCredential();

    return live("email");
  } catch (err) {
    if (err instanceof GoogleCredentialSelectionError) {
      return googleSelectionProvenance("email", "gmail", err);
    }

    logger.warn({ err }, "[briefing.gather] Gmail credential read failed");

    return readFailed("email", "The Gmail credential read failed.");
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
 * Split the activity list at the window start. An item that occurred before the window is real
 * but not news: it leaves the list, and its statement goes to the log (ADR-0117 decision 2).
 * An item with an unreadable time stays, because the reader cannot prove that it is old.
 */
export function splitStaleActivity(
  items: readonly IntegrationActivityItem[],
  windowStart: Date,
): Sourced<IntegrationActivityItem[]> {
  const fresh: IntegrationActivityItem[] = [];
  const provenance: GatherProvenance[] = [live("integration_activity")];

  for (const item of items) {
    const occurredAt = Date.parse(item.occurredAt);

    if (Number.isNaN(occurredAt) || occurredAt >= windowStart.getTime()) {
      fresh.push(item);
      continue;
    }

    provenance.push({
      input: "integration_activity",
      state: "stale",
      item: item.title,
      occurredAt: item.occurredAt,
      recovery: { kind: "none" },
    });
  }

  return { value: fresh, provenance };
}

/**
 * Write every statement that is not `live` to the log. Only the block rule shows a statement to
 * the user; the rest are operator facts (ADR-0117 decision 2).
 */
export function logProvenance(userId: string, provenance: readonly GatherProvenance[]): void {
  const notLive = provenance.filter((entry) => entry.state !== "live");

  if (notLive.length === 0) return;

  logger.info({ userId, provenance: notLive }, "[briefing.gather] inputs not live");
}
