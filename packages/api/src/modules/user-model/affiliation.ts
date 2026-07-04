/**
 * Connect-time `user_org_affiliation` emitter (ADR-0080 §4a, #342 slice 1a).
 *
 * When a Google account is connected (or back-filled), the account itself is a
 * FIRST-PARTY, user-subject grounding for the user's org affiliation: the
 * connected mailbox's domain is structurally about the user, not a third party
 * mentioned in inbound content. So a connect appends a `user_org_affiliation`
 * observation (`source = google_account`, `subjectIdentity = { kind: "user" }`)
 * onto the ADR-0067 log; the identity-facts projection (PR B) folds it into
 * `employer`. A disconnect appends a `status = "disconnected"` row in the SAME
 * account/domain family so the projection derives currentness from observation
 * history, never from ambient credential state (replay stays pure).
 *
 * Two correctness rails this module owns (the rest is in the deterministic core
 * and the observation write boundary):
 *
 *   - REPLAY PURITY + BACKFILL IDEMPOTENCY share one mechanism: a connect's
 *     `occurredAt` is the credential's `createdAt`, NOT `now()`. A re-auth
 *     (`upsertCredential` keeps the row, so `createdAt` is stable) re-derives the
 *     same `evidenceHash` and DEDUPS; the dry/commit backfill re-runs to the same
 *     no-op; and replaying the log converges. Disconnect/reconnect DO advance:
 *     a disconnect deletes the row, so a later reconnect is a fresh insert with a
 *     new `createdAt` → a new family member → the head advances past the
 *     disconnect (the bug a status-only hash would cause — see `evidenceHash`).
 *   - PAYLOAD SELF-CONSISTENCY: `domainClass` is computed from the SAME
 *     `(accountEmail, verifiedHostedDomain)` the observation boundary re-checks,
 *     and `verifiedHostedDomain` is the Google Workspace `hd` domain when present
 *     (Google treats `hd`, not the email claim's domain, as the hosted-domain
 *     authority), so alias/secondary-domain mailboxes still ground the verified
 *     Workspace org.
 */

import {
  canonicalizeIdentityValue,
  classifyEmailDomain,
  identityValueMatchesKind,
  isNonEmptyString,
  isRecord,
  type DomainClass,
  type ObservationInsertInput,
  type UserOrgAffiliationPayload,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { integrationCredentials, observationFamilyHeads } from "@alfred/db/schemas";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { insertObservation } from "./observations";
import { type DbExecutor } from "./executor";

/** The lifecycle status a connect/disconnect emits. */
export type OrgAffiliationStatus = "connected" | "disconnected";

/**
 * The credential fields the emitter reads. A narrow interface (not the full
 * `IntegrationCredential`) so the connect route, the disconnect route, and the
 * backfill can each hand over exactly what they have without coupling to the row
 * shape — `createdAt` is the connect event time (replay/idempotency anchor).
 */
export interface CredentialForAffiliation {
  userId: string;
  /** Google `sub` — the provider-stable account id. */
  accountId: string;
  /** The account email (`integration_credentials.account_label`). */
  accountEmail: string | null;
  /** The credential `metadata` bag (carries `googleHostedDomain`, the Workspace `hd`). */
  metadata: unknown;
}

export type BuildOrgAffiliationResult =
  | { ok: true; input: ObservationInsertInput; domainClass: DomainClass }
  | { ok: false; reason: BuildOrgAffiliationSkipReason };

export type BuildOrgAffiliationSkipReason =
  | "missing_account_id"
  | "missing_account_email"
  | "invalid_account_email"
  | "unclassifiable_domain";

const ORG_AFFILIATION_APPEND_MAX_ATTEMPTS = 3;
const OBSERVATION_CHAIN_CONSTRAINTS = new Set([
  "observations_no_fork_idx",
  "observations_single_root_idx",
]);

export function isOrgAffiliationObservationAppendConflict(err: unknown): boolean {
  if (!isRecord(err)) return false;
  const constraint = err.constraint;
  return (
    err.code === "23505" &&
    typeof constraint === "string" &&
    OBSERVATION_CHAIN_CONSTRAINTS.has(constraint)
  );
}

async function retryOrgAffiliationAppend<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (
        attempt >= ORG_AFFILIATION_APPEND_MAX_ATTEMPTS ||
        !isOrgAffiliationObservationAppendConflict(err)
      ) {
        throw err;
      }
    }
  }
}

/** Pull the verified Workspace hosted domain (`hd`) out of the credential metadata bag. */
function hostedDomainFromMetadata(metadata: unknown): string | null {
  if (!isRecord(metadata)) return null;
  const hd = metadata["googleHostedDomain"];
  return isNonEmptyString(hd) ? hd : null;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function payloadsMatchForCurrentAffiliation(
  a: UserOrgAffiliationPayload,
  b: UserOrgAffiliationPayload,
): boolean {
  return (
    a.accountId === b.accountId &&
    a.accountEmail === b.accountEmail &&
    a.orgDomain === b.orgDomain &&
    a.verifiedHostedDomain === b.verifiedHostedDomain &&
    a.domainClass === b.domainClass
  );
}

/**
 * Build the `user_org_affiliation` observation for a credential — PURE given its
 * inputs (no DB), so both the live connect path and the backfill compose it and
 * the dry-run can print exactly what the commit would write. Returns a typed skip
 * reason instead of throwing when the account can't ground an affiliation (no
 * email, malformed email, unclassifiable domain) — a missing grounding is "no
 * row" (invariant 1), not an error.
 *
 * `occurredAt` is supplied by the caller and MUST be the credential's
 * `createdAt` for a connect (the idempotency/replay anchor — see the file
 * header); a disconnect passes the disconnect event time.
 */
export function buildOrgAffiliationObservationInput(
  cred: CredentialForAffiliation,
  opts: { status: OrgAffiliationStatus; occurredAt: Date },
): BuildOrgAffiliationResult {
  const accountId = cred.accountId.trim();
  if (!accountId) return { ok: false, reason: "missing_account_id" };

  if (!isNonEmptyString(cred.accountEmail)) return { ok: false, reason: "missing_account_email" };
  const accountEmail = canonicalizeIdentityValue("email", cred.accountEmail);
  if (!identityValueMatchesKind("email", accountEmail)) {
    return { ok: false, reason: "invalid_account_email" };
  }
  // A canonical, format-valid email always has a single `@`; the domain after it
  // is a valid hostname (the email regex validates it), so it satisfies the
  // payload's canonical-domain schema without a second normalization pass.
  const accountEmailDomain = accountEmail.slice(accountEmail.indexOf("@") + 1);

  const rawHostedDomain = hostedDomainFromMetadata(cred.metadata);
  const hostedDomain = rawHostedDomain
    ? canonicalizeIdentityValue("domain", rawHostedDomain)
    : null;
  const verifiedHostedDomain =
    hostedDomain && identityValueMatchesKind("domain", hostedDomain) ? hostedDomain : null;
  // Google documents `hd` as the hosted-domain authority. The email claim can be
  // an alias/secondary domain, so the org lifecycle family is keyed by `hd` when
  // present; the accountEmail still preserves the actual mailbox.
  const orgDomain = verifiedHostedDomain ?? accountEmailDomain;

  const domainClass = classifyEmailDomain({ email: accountEmail, verifiedHostedDomain });
  if (!domainClass) return { ok: false, reason: "unclassifiable_domain" };

  const payload: UserOrgAffiliationPayload = {
    accountId,
    accountEmail,
    orgDomain,
    verifiedHostedDomain,
    domainClass,
    status: opts.status,
    evidence:
      opts.status === "connected" ? "connected_google_account" : "disconnected_google_account",
  };

  // Family = the account×org lifecycle; connect/disconnect/reconnect rows share
  // it so the projection reads the latest member to decide currentness.
  const familyKey = `org_affiliation:${accountId}:${orgDomain}`;
  // The hash carries `occurredAtMs` so distinct lifecycle EVENTS never dedup,
  // while a re-auth/backfill at the same connect time DOES (stable `createdAt`).
  const evidenceHash = hashJson({
    accountId,
    orgDomain,
    domainClass,
    status: opts.status,
    occurredAtMs: opts.occurredAt.getTime(),
  });

  return {
    ok: true,
    domainClass,
    input: {
      userId: cred.userId,
      source: "google_account",
      kind: "user_org_affiliation",
      occurredAt: opts.occurredAt,
      familyKey,
      evidenceHash,
      subjectIdentity: { kind: "user" },
      payload,
      schemaVersion: 1,
      reducerVersion: 1,
    },
  };
}

export interface RecordOrgAffiliationResult {
  status: "emitted" | "deduped" | "skipped";
  reason?: BuildOrgAffiliationSkipReason;
}

export interface RecordOrgAffiliationOnCredentialUpsertResult {
  disconnectedPrevious?: RecordOrgAffiliationResult;
  connectedCurrent: RecordOrgAffiliationResult;
}

interface LoadedCredentialForAffiliation extends CredentialForAffiliation {
  createdAt: Date;
}

type ReadExecutor = DbExecutor | ReturnType<typeof db>;

async function insertOrgAffiliationObservation(
  input: ObservationInsertInput,
  tx?: DbExecutor,
): Promise<Awaited<ReturnType<typeof insertObservation>>> {
  const runOnce = async (ex: DbExecutor) => {
    const [head] = await ex
      .select({ headObservationId: observationFamilyHeads.headObservationId })
      .from(observationFamilyHeads)
      .where(
        and(
          eq(observationFamilyHeads.userId, input.userId),
          eq(observationFamilyHeads.familyKey, input.familyKey),
        ),
      )
      .limit(1);

    return insertObservation(
      {
        ...input,
        ...(head ? { supersedesObservationId: head.headObservationId } : {}),
      },
      ex,
    );
  };

  return tx ? runOnce(tx) : retryOrgAffiliationAppend(() => db().transaction(runOnce));
}

async function loadGoogleCredentialForAffiliation(
  credentialId: string,
  ex: ReadExecutor,
): Promise<LoadedCredentialForAffiliation | null> {
  const [cred] = await ex
    .select({
      userId: integrationCredentials.userId,
      accountId: integrationCredentials.accountId,
      accountEmail: integrationCredentials.accountLabel,
      metadata: integrationCredentials.metadata,
      createdAt: integrationCredentials.createdAt,
    })
    .from(integrationCredentials)
    .where(
      and(
        eq(integrationCredentials.id, credentialId),
        eq(integrationCredentials.provider, "google"),
      ),
    )
    .limit(1);
  return cred ?? null;
}

async function recordOrgAffiliationConnectEvent(
  cred: CredentialForAffiliation,
  occurredAt: Date,
  tx?: DbExecutor,
): Promise<RecordOrgAffiliationResult> {
  const built = buildOrgAffiliationObservationInput(cred, { status: "connected", occurredAt });
  if (!built.ok) return { status: "skipped", reason: built.reason };
  const { deduped } = await insertOrgAffiliationObservation(built.input, tx);
  return { status: deduped ? "deduped" : "emitted" };
}

/**
 * Load a Google credential by id and append its connect-time
 * `user_org_affiliation` observation. The connect EVENT TIME is the credential's
 * `createdAt` (stable across re-auth), so a re-connect that merely refreshes the
 * token dedups rather than minting a duplicate. Returns a status so the caller
 * can log; never throws on a skip (no grounding ≠ failure).
 */
export async function recordOrgAffiliationOnConnect(
  credentialId: string,
  tx?: DbExecutor,
): Promise<RecordOrgAffiliationResult> {
  const ex = tx ?? db();
  const cred = await loadGoogleCredentialForAffiliation(credentialId, ex);
  if (!cred) return { status: "skipped", reason: "missing_account_id" };

  return recordOrgAffiliationConnectEvent(cred, cred.createdAt, tx);
}

/**
 * Record the affiliation lifecycle after a Google credential upsert. A normal
 * re-auth with identical affiliation evidence dedups against the stable
 * credential `createdAt`. If Google reports changed affiliation evidence, treat
 * the upsert as a new lifecycle event at the callback time: disconnect the old
 * family when the family changed, and connect the current evidence at the
 * change time.
 */
export async function recordOrgAffiliationOnCredentialUpsert(
  args: {
    credentialId: string;
    previousCredential?: CredentialForAffiliation | null;
    changedAt: Date;
  },
  tx?: DbExecutor,
): Promise<RecordOrgAffiliationOnCredentialUpsertResult> {
  const run = async (ex: DbExecutor): Promise<RecordOrgAffiliationOnCredentialUpsertResult> => {
    const current = await loadGoogleCredentialForAffiliation(args.credentialId, ex);
    if (!current) {
      return { connectedCurrent: { status: "skipped", reason: "missing_account_id" } };
    }

    let connectOccurredAt = current.createdAt;
    let disconnectedPrevious: RecordOrgAffiliationResult | undefined;
    if (args.previousCredential) {
      const previousConnectBuilt = buildOrgAffiliationObservationInput(args.previousCredential, {
        status: "connected",
        occurredAt: args.changedAt,
      });
      const currentBuiltAtChange = buildOrgAffiliationObservationInput(current, {
        status: "connected",
        occurredAt: args.changedAt,
      });
      const familyChanged =
        previousConnectBuilt.ok &&
        (!currentBuiltAtChange.ok ||
          previousConnectBuilt.input.familyKey !== currentBuiltAtChange.input.familyKey);
      const affiliationEvidenceChanged =
        currentBuiltAtChange.ok &&
        (!previousConnectBuilt.ok ||
          previousConnectBuilt.input.familyKey !== currentBuiltAtChange.input.familyKey ||
          !payloadsMatchForCurrentAffiliation(
            previousConnectBuilt.input.payload as UserOrgAffiliationPayload,
            currentBuiltAtChange.input.payload as UserOrgAffiliationPayload,
          ));

      if (familyChanged) {
        disconnectedPrevious = await recordOrgAffiliationOnDisconnect(
          args.previousCredential,
          args.changedAt,
          ex,
        );
      }
      if (affiliationEvidenceChanged) connectOccurredAt = args.changedAt;
    }

    return {
      ...(disconnectedPrevious ? { disconnectedPrevious } : {}),
      connectedCurrent: await recordOrgAffiliationConnectEvent(current, connectOccurredAt, ex),
    };
  };

  return tx ? run(tx) : retryOrgAffiliationAppend(() => db().transaction(run));
}

/**
 * Append a `status = "disconnected"` affiliation observation for an
 * account/domain family. Called with the fields captured BEFORE the credential
 * row is deleted (the row is gone afterwards), stamping the disconnect event time
 * — a real one-shot event, so `now()` here is the immutable record of when it
 * happened, not a replay hazard. The new row's `occurredAt` is later than the
 * connect's, so the projection reads the family as disconnected.
 */
export async function recordOrgAffiliationOnDisconnect(
  cred: CredentialForAffiliation,
  occurredAt: Date,
  tx?: DbExecutor,
): Promise<RecordOrgAffiliationResult> {
  const built = buildOrgAffiliationObservationInput(cred, { status: "disconnected", occurredAt });
  if (!built.ok) return { status: "skipped", reason: built.reason };
  const { deduped } = await insertOrgAffiliationObservation(built.input, tx);
  return { status: deduped ? "deduped" : "emitted" };
}
