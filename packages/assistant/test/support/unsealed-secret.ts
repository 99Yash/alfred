import type { SealedCredentialSecret } from "@alfred/db/credential-vault";

/**
 * A plaintext token typed as sealed, for a seeded credential row that no code path under test opens.
 * Sealing needs the `serverEnv()` KEK fixtures, which a test that never reads the token back does not set up.
 * A test that opens the token must seal it with `credentialVault().seal` instead.
 */
export function unsealedTestSecret(plaintext: string): SealedCredentialSecret {
  // SAFETY: the brand is never checked, because nothing opens the row's token.
  // eslint-disable-next-line anti-slop/no-chained-type-assertions -- a plaintext test token stands in for a sealed envelope that is never opened
  return plaintext as unknown as SealedCredentialSecret;
}
