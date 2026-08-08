import { withDefaults } from "@alfred/contracts";
import { db, type DbTransaction } from "@alfred/db";
import { integrationCredentials } from "@alfred/db/schemas";
import { detectPersona, upsertCredential } from "@alfred/integrations/google";
import { and, eq } from "drizzle-orm";
import {
  registerGoogleCredentialLifecycleHandler,
  type GoogleCredentialLifecycleHandler,
} from "@alfred/assistant/connections";
import {
  recordOrgAffiliationOnCredentialUpsert,
  recordOrgAffiliationOnDisconnect,
  retryOnObservationChainConflict,
  type CredentialForAffiliation,
} from "../modules/knowledge";

type DeletedGoogleCredential = CredentialForAffiliation & { id: string };

interface GoogleCredentialLifecycleAdapterDeps {
  transaction<T>(callback: (tx: DbTransaction) => Promise<T>): Promise<T>;
  loadPreviousCredential(
    request: { userId: string; accountId: string },
    tx: DbTransaction,
  ): Promise<CredentialForAffiliation | null>;
  upsertCredential: typeof upsertCredential;
  recordUpsert: typeof recordOrgAffiliationOnCredentialUpsert;
  deleteCredential(
    request: { userId: string; credentialId: string },
    tx: DbTransaction,
  ): Promise<DeletedGoogleCredential | null>;
  recordDisconnect: typeof recordOrgAffiliationOnDisconnect;
  retryOnConflict: typeof retryOnObservationChainConflict;
}

async function loadPreviousCredential(
  request: { userId: string; accountId: string },
  tx: DbTransaction,
): Promise<CredentialForAffiliation | null> {
  const [row] = await tx
    .select({
      userId: integrationCredentials.userId,
      accountId: integrationCredentials.accountId,
      accountEmail: integrationCredentials.accountLabel,
      metadata: integrationCredentials.metadata,
    })
    .from(integrationCredentials)
    .where(
      and(
        eq(integrationCredentials.userId, request.userId),
        eq(integrationCredentials.provider, "google"),
        eq(integrationCredentials.accountId, request.accountId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function deleteCredential(
  request: { userId: string; credentialId: string },
  tx: DbTransaction,
): Promise<DeletedGoogleCredential | null> {
  const [row] = await tx
    .delete(integrationCredentials)
    .where(
      and(
        eq(integrationCredentials.id, request.credentialId),
        eq(integrationCredentials.userId, request.userId),
        eq(integrationCredentials.provider, "google"),
      ),
    )
    .returning({
      id: integrationCredentials.id,
      userId: integrationCredentials.userId,
      accountId: integrationCredentials.accountId,
      accountEmail: integrationCredentials.accountLabel,
      metadata: integrationCredentials.metadata,
    });
  return row ?? null;
}

const DEFAULT_DEPS: GoogleCredentialLifecycleAdapterDeps = {
  transaction: async (callback) => db().transaction(callback),
  loadPreviousCredential,
  upsertCredential,
  recordUpsert: recordOrgAffiliationOnCredentialUpsert,
  deleteCredential,
  recordDisconnect: recordOrgAffiliationOnDisconnect,
  retryOnConflict: retryOnObservationChainConflict,
};

/** Build the cross-domain transaction coordinator. Overrides are an internal test seam. */
export function createGoogleCredentialLifecycleHandler(
  overrides: Partial<GoogleCredentialLifecycleAdapterDeps> = {},
): GoogleCredentialLifecycleHandler {
  const deps = withDefaults(DEFAULT_DEPS, overrides);

  return {
    async upsert(request) {
      return deps.retryOnConflict(() =>
        deps.transaction(async (tx) => {
          const previousCredential = await deps.loadPreviousCredential(
            { userId: request.userId, accountId: request.accountId },
            tx,
          );
          const credential = await deps.upsertCredential(
            {
              userId: request.userId,
              provider: "google",
              accountId: request.accountId,
              accountLabel: request.accountEmail,
              accessToken: request.accessToken,
              refreshToken: request.refreshToken,
              expiresAt: request.expiresAt,
              scopes: request.scopes,
              persona: detectPersona(request.hostedDomain ?? undefined),
              metadata: {
                token_type: request.tokenType,
                ...(request.hostedDomain ? { googleHostedDomain: request.hostedDomain } : {}),
              },
            },
            tx,
          );
          await deps.recordUpsert(
            {
              credentialId: credential.id,
              previousCredential,
              changedAt: request.changedAt,
            },
            tx,
          );
          return { credentialId: credential.id };
        }),
      );
    },

    async disconnect(request) {
      return deps.retryOnConflict(() =>
        deps.transaction(async (tx) => {
          const deleted = await deps.deleteCredential(request, tx);
          if (!deleted) return { status: "already_absent" as const };

          await deps.recordDisconnect(deleted, request.disconnectedAt, tx);
          return { status: "deleted" as const };
        }),
      );
    },
  };
}

let unregisterGoogleCredentialLifecycleHandler: (() => void) | undefined;

export function registerGoogleCredentialLifecycle(): void {
  if (unregisterGoogleCredentialLifecycleHandler) return;
  unregisterGoogleCredentialLifecycleHandler = registerGoogleCredentialLifecycleHandler(
    createGoogleCredentialLifecycleHandler(),
  );
}

export function unregisterGoogleCredentialLifecycle(): void {
  unregisterGoogleCredentialLifecycleHandler?.();
  unregisterGoogleCredentialLifecycleHandler = undefined;
}
