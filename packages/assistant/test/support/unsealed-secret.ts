import { sql, type SQL } from "drizzle-orm";

/**
 * A plaintext token as a bound SQL parameter, for a seeded credential row that no code path under test opens.
 * The `SealedCredentialSecret` brand refuses a plain string, and a parameter writes the text as it is.
 * Sealing needs the `serverEnv()` KEK fixtures, which a test that never reads the token back does not set up.
 * A test that opens the token must seal it with `credentialVault().seal` instead.
 */
export function unsealedTestSecret(plaintext: string): SQL {
  return sql`${plaintext}`;
}
