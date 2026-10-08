import { serverEnv } from "@alfred/env/server";
import { createCredentialVault, type CredentialVault } from "./credential-envelope";

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
