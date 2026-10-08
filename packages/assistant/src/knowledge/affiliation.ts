/**
 * Connect-time `user_org_affiliation` emitter (ADR-0080 §4a). A connected Google
 * account is first-party evidence of the user's org, so a connect appends an
 * observation the identity-facts projection folds into `employer`. A disconnect
 * appends a `disconnected` row in the same family.
 *
 * `occurredAt` is the credential's `createdAt`, not `now()`, so a re-auth dedups
 * and replays converge. A reconnect is a new row with a new `createdAt`.
 * The org domain is the Workspace `hd` when present: Google treats `hd` as the authority.
 */

import {
  canonicalizeIdentityValue,
  classifyConnectedAccount,
  identityValueMatchesKind,
  isNonEmptyString,
  isRecord,
  type DomainClass,
  type ObservationInsertInput,
  type UserOrgAffiliationPayload,
} from "@alfred/contracts";
import { db, type DbRoot } from "@alfred/db";
import { integrationCredentials, observationFamilyHeads } from "@alfred/db/schemas";
import { sha256Canonical } from "@alfred/db/hash";
import { and, eq } from "drizzle-orm";
import { uniqueViolationConstraint } from "@alfred/db/pg-errors";
import { insertObservation } from "./observations";
import { type DbTransaction } from "@alfred/db";

export type OrgAffiliationStatus = UserOrgAffiliationPayload["status"];

/** The credential fields the emitter reads. `createdAt` is the connect time. */
export interface CredentialForAffiliation {
  userId: string;
  /** Google `sub`. */
  accountId: string;
  /** `integration_credentials.account_label`. */
  accountEmail: string | null;
  /** Holds `googleHostedDomain`, the Workspace `hd`. */
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
  const constraint = uniqueViolationConstraint(err);

  return constraint !== null && OBSERVATION_CHAIN_CONSTRAINTS.has(constraint);
}

/** The one bounded retry for org-affiliation observation-chain conflicts. */
export async function retryOnObservationChainConflict<T>(fn: () => Promise<T>): Promise<T> {
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

function hostedDomainFromMetadata(metadata: unknown): string | null {
  if (!isRecord(metadata)) return null;
  const hd = metadata["googleHostedDomain"];

  return isNonEmptyString(hd) ? hd : null;
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
 * Build the observation for a credential. Pure, so the backfill dry run prints
 * what a commit would write. An ungroundable account returns a skip reason, not
 * an error: no grounding, no row. `occurredAt` must be `createdAt` for a connect.
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

  // The email regex already validated this domain.
  const accountEmailDomain = accountEmail.slice(accountEmail.indexOf("@") + 1);

  const rawHostedDomain = hostedDomainFromMetadata(cred.metadata);

  const hostedDomain = rawHostedDomain
    ? canonicalizeIdentityValue("domain", rawHostedDomain)
    : null;

  const verifiedHostedDomain =
    hostedDomain && identityValueMatchesKind("domain", hostedDomain) ? hostedDomain : null;

  // Key the family by `hd`: the email can be an alias domain.
  const orgDomain = verifiedHostedDomain ?? accountEmailDomain;

  const domainClass = classifyConnectedAccount({ email: accountEmail, verifiedHostedDomain });

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

  // The family is the account×org lifecycle; the latest member decides currentness.
  const familyKey = `org_affiliation:${accountId}:${orgDomain}`;

  // `occurredAtMs` keeps distinct events apart while a re-auth at the same connect time dedups.
  const evidenceHash = sha256Canonical({
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

type ReadExecutor = DbTransaction | DbRoot;

async function insertOrgAffiliationObservation(
  input: ObservationInsertInput,
  tx?: DbTransaction,
): Promise<Awaited<ReturnType<typeof insertObservation>>> {
  const runOnce = async (ex: DbTransaction) => {
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

  return tx ? runOnce(tx) : retryOnObservationChainConflict(() => db().transaction(runOnce));
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
  tx?: DbTransaction,
): Promise<RecordOrgAffiliationResult> {
  const built = buildOrgAffiliationObservationInput(cred, { status: "connected", occurredAt });

  if (!built.ok) return { status: "skipped", reason: built.reason };
  const { deduped } = await insertOrgAffiliationObservation(built.input, tx);

  return { status: deduped ? "deduped" : "emitted" };
}

/** Append the connect observation for a credential id. A skip is not an error. */
export async function recordOrgAffiliationOnConnect(
  credentialId: string,
  tx?: DbTransaction,
): Promise<RecordOrgAffiliationResult> {
  const ex = tx ?? db();
  const cred = await loadGoogleCredentialForAffiliation(credentialId, ex);

  if (!cred) return { status: "skipped", reason: "missing_account_id" };

  return recordOrgAffiliationConnectEvent(cred, cred.createdAt, tx);
}

/**
 * After a credential upsert, an unchanged re-auth dedups. Changed evidence is a
 * new event at callback time: disconnect the old family if it changed, then connect.
 */
export async function recordOrgAffiliationOnCredentialUpsert(
  args: {
    credentialId: string;
    previousCredential?: CredentialForAffiliation | null;
    changedAt: Date;
  },
  tx?: DbTransaction,
): Promise<RecordOrgAffiliationOnCredentialUpsertResult> {
  const run = async (ex: DbTransaction): Promise<RecordOrgAffiliationOnCredentialUpsertResult> => {
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
          // SAFETY: both inputs came from buildOrgAffiliationObservationInput and `.ok` was checked for each.
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

  return tx ? run(tx) : retryOnObservationChainConflict(() => db().transaction(run));
}

/**
 * Append a `disconnected` row. The caller captures the fields before deleting
 * the credential. `now()` is safe here: this is a real one-time event.
 */
export async function recordOrgAffiliationOnDisconnect(
  cred: CredentialForAffiliation,
  occurredAt: Date,
  tx?: DbTransaction,
): Promise<RecordOrgAffiliationResult> {
  const built = buildOrgAffiliationObservationInput(cred, { status: "disconnected", occurredAt });

  if (!built.ok) return { status: "skipped", reason: built.reason };
  const { deduped } = await insertOrgAffiliationObservation(built.input, tx);

  return { status: deduped ? "deduped" : "emitted" };
}
