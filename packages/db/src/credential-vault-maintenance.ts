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
  /** Token fields still in plaintext after the pass. */
  plaintextRemaining: number;
  /** Sealed token fields that do not open with the configured key. */
  unopenableRemaining: number;
}

const INTEGRATION_SECRET_FIELDS = ["accessToken", "refreshToken"] as const;

type PersistedTokenState =
  | { readonly state: "absent" }
  | { readonly state: "plaintext"; readonly plaintext: string }
  | { readonly state: "openable" }
  | { readonly state: "unopenable" };

/** Takes `unknown`, because old plaintext rows do not match the Drizzle column type. */
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
  return fields.reduce<Partial<Record<Field, SealedCredentialSecret>>>((pending, field) => {
    const classified = classifyPersisted(row[field], vault);

    if (classified.state === "absent" || classified.state === "openable") return pending;

    if (classified.state === "unopenable") {
      throw new CredentialVaultError(
        "unopenable_remaining",
        "a persisted envelope does not open with the configured OAUTH_CREDENTIAL_KEK — this pass converts plaintext, it cannot rewrap another key's envelope",
      );
    }

    pending[field] = vault.seal(classified.plaintext);

    return pending;
  }, {});
}

/** Better Auth's `account` type wants `string`. Keep this private so `open` stays the only public unwrap. */
function asUnbranded<Field extends string>(
  pending: Partial<Record<Field, SealedCredentialSecret>>,
): Partial<Record<Field, string>> {
  // eslint-disable-next-line anti-slop/no-chained-type-assertions -- boundary cast: SealedCredentialSecret is a branded symbol at the type level but a plain string at runtime; the brand prevents implicit provider use
  return pending as unknown as Partial<Record<Field, string>>;
}

function countUnsealed<Field extends string>(
  row: Readonly<Record<Field, unknown>>,
  fields: readonly Field[],
  vault: CredentialVault,
) {
  let plaintext = 0;
  let unopenable = 0;

  for (const field of fields) {
    const { state } = classifyPersisted(row[field], vault);

    if (state === "plaintext") plaintext += 1;
    else if (state === "unopenable") unopenable += 1;
  }

  return { plaintext, unopenable };
}

/** Seal plaintext OAuth tokens in one transaction, then count what is left. Stop all writers first. */
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

/** Refuse to start if any token is plaintext or does not open with the current key. */
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
