import { serverEnv } from "@alfred/env/server";
import { createCredentialVault, type CredentialVault } from "./credential-envelope";

export { createCredentialVault, CredentialVaultError } from "./credential-envelope";
export type {
  CredentialVault,
  CredentialVaultFailure,
  SealedCredentialSecret,
} from "./credential-envelope";

/**
 * The Better Auth account fields that contain OAuth capabilities.
 *
 * The adapter and the maintenance gate import this one tuple. A field that only
 * the adapter knows is never verified; a field that only the gate knows makes
 * the process refuse to boot.
 */
export const ACCOUNT_SECRET_FIELDS = ["accessToken", "refreshToken", "idToken"] as const;
export type AccountSecretField = (typeof ACCOUNT_SECRET_FIELDS)[number];

let vault: CredentialVault | undefined;

/**
 * Resolve the production credential vault from the validated server
 * environment. There is no default key and no plaintext fallback.
 */
export function credentialVault(): CredentialVault {
  if (vault) return vault;
  vault = createCredentialVault(Buffer.from(serverEnv().OAUTH_CREDENTIAL_KEK, "base64url"));
  return vault;
}
