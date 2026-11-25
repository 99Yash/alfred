import type { SENSITIVE_LOG_PATHS } from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import {
  createCredentialVault,
  CredentialVaultError,
  type CredentialVault,
  type SealedCredentialSecret,
} from "./credential-envelope";

export { createCredentialVault, CredentialVaultError } from "./credential-envelope";

import type * as schema from "./schemas";

export type { CredentialVault, SealedCredentialSecret } from "./credential-envelope";

/** Each column key that holds a {@link SealedCredentialSecret}, across every table in the schema. */
type SealedColumnKey = {
  [Export in keyof typeof schema]: (typeof schema)[Export] extends {
    readonly _: { readonly columns: infer Columns };
  }
    ? {
        [Key in keyof Columns]: Columns[Key] extends { readonly _: { readonly data: infer Data } }
          ? [Data] extends [SealedCredentialSecret]
            ? Key
            : never
          : never;
      }[keyof Columns]
    : never;
}[keyof typeof schema];

type SealedColumnKeyMissingFromLogRedaction = Exclude<
  SealedColumnKey,
  (typeof SENSITIVE_LOG_PATHS)[number]
>;

/**
 * Compile-time gate (#1870, ADR-0038): code that opens a sealed column often logs the value
 * under the column key. So each sealed column key must be in `SENSITIVE_LOG_PATHS`. A new
 * sealed column without an entry fails here and names the key.
 */
const SEALED_COLUMN_KEYS_ARE_REDACTED: [SealedColumnKeyMissingFromLogRedaction] extends [never]
  ? true
  : {
      readonly "Add each sealed column key to SENSITIVE_LOG_PATHS": SealedColumnKeyMissingFromLogRedaction;
    } = true;

void SEALED_COLUMN_KEYS_ARE_REDACTED;

/** OAuth token fields on `account`. The adapter and the boot gate must share this one list. */
export const ACCOUNT_SECRET_FIELDS = ["accessToken", "refreshToken", "idToken"] as const;

export type AccountSecretField = (typeof ACCOUNT_SECRET_FIELDS)[number];

let vault: CredentialVault | undefined;

/** The production vault. No default key and no plaintext fallback. */
export function credentialVault(): CredentialVault {
  if (vault) return vault;
  vault = createCredentialVault(Buffer.from(serverEnv().OAUTH_CREDENTIAL_KEK, "base64url"));

  return vault;
}

/**
 * Whether a stored secret opens with the current key. `false` only for an envelope sealed under
 * another key, which a KEK rotation leaves behind: a dead grant. Any other vault failure still
 * throws. `null` (no secret stored) opens.
 */
export function opensWithCurrentKey(
  keyVault: CredentialVault,
  sealed: SealedCredentialSecret | null,
): boolean {
  if (sealed === null) return true;

  try {
    keyVault.open(sealed);

    return true;
  } catch (error) {
    if (
      error instanceof CredentialVaultError &&
      (error.failure === "unknown_key" || error.failure === "authentication_failed")
    ) {
      return false;
    }

    throw error;
  }
}
