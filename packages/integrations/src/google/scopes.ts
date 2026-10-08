import { GOOGLE_FEATURE_SCOPES, toStringArray, type GoogleFeature } from "@alfred/contracts";
import { db } from "@alfred/db";
import { integrationCredentials } from "@alfred/db/schemas";
import { eq } from "drizzle-orm";
import { scopesForFeatures } from "./oauth";

/** Not transient: the user must reconnect with the missing features. */
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

/** A credential can be partly revoked or hold a narrower grant than a feature needs. */
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
    throw new Error(
      `[google.scopes] credential not active: ${credentialId} (status=${row.status})`,
    );
  }

  const granted = new Set<string>(toStringArray(row.scopes));
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

export function featuresFromGrantedScopes(grantedScopes: readonly string[]): GoogleFeature[] {
  const granted = new Set(grantedScopes);

  // SAFETY: GoogleFeature is `keyof typeof GOOGLE_FEATURE_SCOPES`.
  return (Object.keys(GOOGLE_FEATURE_SCOPES) as GoogleFeature[]).filter((f) =>
    GOOGLE_FEATURE_SCOPES[f].every((s) => granted.has(s)),
  );
}
