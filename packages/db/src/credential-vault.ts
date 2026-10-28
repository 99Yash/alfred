import { serverEnv } from "@alfred/env/server";
import {
  createCredentialVault,
  CredentialVaultError,
  type CredentialVault,
  type SealedCredentialSecret,
} from "./credential-envelope";

export { createCredentialVault, CredentialVaultError } from "./credential-envelope";

export type {
  CredentialVault,
  CredentialVaultFailure,
  SealedCredentialSecret,
} from "./credential-envelope";

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
