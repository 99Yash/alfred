import { eq } from "drizzle-orm";
import { db } from "./index";
import { account } from "./schema/auth";
import { integrationCredentials } from "./schema/integrations";
import {
  ACCOUNT_SECRET_FIELDS,
  credentialVault,
  CredentialVaultError,
  type CredentialVault,
  type SealedCredentialSecret,
} from "./credential-vault";

export interface CredentialBackfillResult {
  accountsUpdated: number;
  integrationsUpdated: number;
  /** Non-null token fields still readable as plaintext once the pass finishes. */
  plaintextRemaining: number;
  /**
   * Non-null token fields that are envelope-shaped but do not open with the
   * configured key.
   */
  unopenableRemaining: number;
}

const INTEGRATION_SECRET_FIELDS = ["accessToken", "refreshToken"] as const;

type PersistedTokenState =
  | { readonly state: "absent" }
  | { readonly state: "plaintext"; readonly plaintext: string }
  | { readonly state: "openable" }
  | { readonly state: "unopenable" };

/**
 * Classify persisted data without trusting the Drizzle column type. This
 * maintenance pass exists for rows whose old plaintext representation violates
 * that type.
 */
function classifyPersisted(value: unknown, vault: CredentialVault): PersistedTokenState {
  if (value === null || value === undefined) return { state: "absent" };
  if (typeof value !== "string") return { state: "unopenable" };
  if (!vault.isSealed(value)) return { state: "plaintext", plaintext: value };
  try {
    vault.open(value);
    return { state: "openable" };
  } catch {
    return { state: "unopenable" };
  }
}

function sealPending<Field extends string>(
  row: Readonly<Record<Field, unknown>>,
  fields: readonly Field[],
  vault: CredentialVault,
): Partial<Record<Field, SealedCredentialSecret>> {
  const pending: Partial<Record<Field, SealedCredentialSecret>> = {};
  for (const field of fields) {
    const classified = classifyPersisted(row[field], vault);
    if (classified.state === "absent" || classified.state === "openable") continue;
    if (classified.state === "unopenable") {
      throw new CredentialVaultError(
        "unopenable_remaining",
        "a persisted envelope does not open with the configured OAUTH_CREDENTIAL_KEK — this pass converts plaintext, it cannot rewrap another key's envelope",
      );
    }
    pending[field] = vault.seal(classified.plaintext);
  }
  return pending;
}

/**
 * Better Auth owns the unbranded account payload type. Keep the conversion
 * private so `CredentialVault.open` remains the only public way to get
 * plaintext from a sealed value.
 */
function asUnbranded<Field extends string>(
  pending: Partial<Record<Field, SealedCredentialSecret>>,
): Partial<Record<Field, string>> {
  return pending as unknown as Partial<Record<Field, string>>;
}

function countUnsealed<Field extends string>(
  row: Readonly<Record<Field, unknown>>,
  fields: readonly Field[],
  vault: CredentialVault,
): { plaintext: number; unopenable: number } {
  let plaintext = 0;
  let unopenable = 0;
  for (const field of fields) {
    const { state } = classifyPersisted(row[field], vault);
    if (state === "plaintext") plaintext += 1;
    else if (state === "unopenable") unopenable += 1;
  }
  return { plaintext, unopenable };
}

/**
 * Convert old plaintext OAuth credentials in one transaction, then verify the
 * complete persisted state. Run this only while every credential writer is
 * stopped.
 */
export async function encryptPersistedOAuthCredentials(options?: {
  checkOnly?: boolean;
}): Promise<CredentialBackfillResult> {
  const checkOnly = options?.checkOnly === true;
  const vault = credentialVault();

  return db().transaction(async (tx) => {
    let accountsUpdated = 0;
    let integrationsUpdated = 0;

    if (!checkOnly) {
      const accountRows = await tx
        .select({
          id: account.id,
          accessToken: account.accessToken,
          refreshToken: account.refreshToken,
          idToken: account.idToken,
        })
        .from(account);
      for (const row of accountRows) {
        const pending = sealPending(row, ACCOUNT_SECRET_FIELDS, vault);
        if (Object.keys(pending).length === 0) continue;
        await tx.update(account).set(asUnbranded(pending)).where(eq(account.id, row.id));
        accountsUpdated += 1;
      }

      const integrationRows = await tx
        .select({
          id: integrationCredentials.id,
          accessToken: integrationCredentials.accessToken,
          refreshToken: integrationCredentials.refreshToken,
        })
        .from(integrationCredentials);
      for (const row of integrationRows) {
        const pending = sealPending(row, INTEGRATION_SECRET_FIELDS, vault);
        if (Object.keys(pending).length === 0) continue;
        await tx
          .update(integrationCredentials)
          .set(pending)
          .where(eq(integrationCredentials.id, row.id));
        integrationsUpdated += 1;
      }
    }

    const verifyAccounts = await tx
      .select({
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        idToken: account.idToken,
      })
      .from(account);
    const verifyIntegrations = await tx
      .select({
        accessToken: integrationCredentials.accessToken,
        refreshToken: integrationCredentials.refreshToken,
      })
      .from(integrationCredentials);
    let plaintextRemaining = 0;
    let unopenableRemaining = 0;
    for (const row of verifyAccounts) {
      const counts = countUnsealed(row, ACCOUNT_SECRET_FIELDS, vault);
      plaintextRemaining += counts.plaintext;
      unopenableRemaining += counts.unopenable;
    }
    for (const row of verifyIntegrations) {
      const counts = countUnsealed(row, INTEGRATION_SECRET_FIELDS, vault);
      plaintextRemaining += counts.plaintext;
      unopenableRemaining += counts.unopenable;
    }

    return { accountsUpdated, integrationsUpdated, plaintextRemaining, unopenableRemaining };
  });
}

/**
 * Refuse to start against plaintext credentials or envelopes that the current
 * key cannot open.
 */
export async function assertPersistedCredentialsSealed(): Promise<void> {
  const { plaintextRemaining, unopenableRemaining } = await encryptPersistedOAuthCredentials({
    checkOnly: true,
  });
  if (plaintextRemaining > 0) {
    throw new CredentialVaultError(
      "plaintext_remaining",
      `${plaintextRemaining} token field(s) are not sealed — run the backfill with all writers stopped`,
    );
  }
  if (unopenableRemaining > 0) {
    throw new CredentialVaultError(
      "unopenable_remaining",
      `${unopenableRemaining} sealed token field(s) do not open with the configured OAUTH_CREDENTIAL_KEK — the key is wrong, or a rotation rewrap did not run`,
    );
  }
}
