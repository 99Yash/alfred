import { db } from "@alfred/db";
import { integrationCredentials } from "@alfred/db/schemas";
import { eq } from "drizzle-orm";
import { GOOGLE_FEATURE_SCOPES, type GoogleFeature, scopesForFeatures } from "./oauth";

/**
 * Thrown when a credential row is missing scopes a feature needs. The
 * caller treats this as "ask the user to re-connect with the missing
 * feature ticked" — never as a transient/retry condition. Workflows
 * surface this through the agent runtime as a non-retriable failure;
 * the UI maps it to a re-consent CTA carrying `features` in the link.
 */
export class MissingScopesError extends Error {
  readonly code = "MISSING_SCOPES";
  readonly credentialId: string;
  readonly missing: string[];
  readonly features: GoogleFeature[];

  constructor(args: { credentialId: string; missing: string[]; features: GoogleFeature[] }) {
    super(
      `[google.scopes] credential ${args.credentialId} is missing scopes for ${args.features.join(", ")}: ${args.missing.join(", ")}`,
    );
    this.name = "MissingScopesError";
    this.credentialId = args.credentialId;
    this.missing = args.missing;
    this.features = args.features;
  }
}

/**
 * Verify a credential row has every scope a feature needs before we
 * call Gmail on its behalf. Defensive: a credential could have been
 * issued at m7 with the full grant and later partially revoked, or
 * (post-incremental-consent) the user may have only granted briefing
 * scopes when the workflow expects triage scopes.
 *
 * Returns the access token on success — saves the caller a second
 * round-trip through `getFreshAccessToken` immediately after this.
 */
export async function requireScopes(
  credentialId: string,
  features: readonly GoogleFeature[],
): Promise<{ scopes: string[] }> {
  const rows = await db()
    .select({
      scopes: integrationCredentials.scopes,
      status: integrationCredentials.status,
    })
    .from(integrationCredentials)
    .where(eq(integrationCredentials.id, credentialId));
  const row = rows[0];
  if (!row) {
    throw new Error(`[google.scopes] credential not found: ${credentialId}`);
  }
  if (row.status !== "active") {
    throw new Error(`[google.scopes] credential not active: ${credentialId} (status=${row.status})`);
  }
  const granted = new Set<string>((row.scopes as string[] | null) ?? []);
  const required = scopesForFeatures(features);
  const missing = required.filter((s) => !granted.has(s));
  if (missing.length > 0) {
    throw new MissingScopesError({
      credentialId,
      missing,
      features: [...features],
    });
  }
  return { scopes: [...granted] };
}

/** Convenience: which features can this credential currently support? */
export function featuresFromGrantedScopes(grantedScopes: readonly string[]): GoogleFeature[] {
  const granted = new Set(grantedScopes);
  return (Object.keys(GOOGLE_FEATURE_SCOPES) as GoogleFeature[]).filter((f) =>
    GOOGLE_FEATURE_SCOPES[f].every((s) => granted.has(s)),
  );
}
