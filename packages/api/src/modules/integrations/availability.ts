import { toStringArray, type LoadableIntegrationSlug } from "@alfred/contracts";
import { db } from "@alfred/db";
import { integrationCredentials } from "@alfred/db/schemas";
import {
  CALENDAR_EVENTS_SCOPE,
  CALENDAR_READONLY_SCOPE,
  DOCS_SCOPE,
  DRIVE_SCOPE,
  GMAIL_READONLY_SCOPE,
  SHEETS_SCOPE,
  SLIDES_SCOPE,
} from "@alfred/integrations/google";
import { eq } from "drizzle-orm";

interface IntegrationAccessSpec {
  slug: LoadableIntegrationSlug;
  provider: string;
  anyOfScopes: readonly string[];
}

const ACCESS_SPECS: readonly IntegrationAccessSpec[] = [
  { slug: "gmail", provider: "google", anyOfScopes: [GMAIL_READONLY_SCOPE] },
  {
    slug: "calendar",
    provider: "google",
    anyOfScopes: [CALENDAR_READONLY_SCOPE, CALENDAR_EVENTS_SCOPE],
  },
  { slug: "drive", provider: "google", anyOfScopes: [DRIVE_SCOPE] },
  { slug: "docs", provider: "google", anyOfScopes: [DOCS_SCOPE] },
  { slug: "sheets", provider: "google", anyOfScopes: [SHEETS_SCOPE] },
  { slug: "slides", provider: "google", anyOfScopes: [SLIDES_SCOPE] },
  { slug: "github", provider: "github", anyOfScopes: [] },
  { slug: "notion", provider: "notion", anyOfScopes: [] },
  { slug: "railway", provider: "railway", anyOfScopes: [] },
  { slug: "vercel", provider: "vercel", anyOfScopes: [] },
];

interface ProviderRow {
  status: string;
  scopes: Set<string>;
  accountLabel: string | null;
}

export interface IntegrationAvailability {
  health: "active" | "needs_reauth" | null;
  accountLabel: string | null;
}

/** One credential read projected into exact per-integration capability health. */
export async function readIntegrationAvailability(
  userId: string,
): Promise<Map<LoadableIntegrationSlug, IntegrationAvailability>> {
  const rows = await db()
    .select({
      provider: integrationCredentials.provider,
      status: integrationCredentials.status,
      scopes: integrationCredentials.scopes,
      accountLabel: integrationCredentials.accountLabel,
    })
    .from(integrationCredentials)
    .where(eq(integrationCredentials.userId, userId));

  const byProvider = new Map<string, ProviderRow[]>();
  for (const row of rows) {
    const list = byProvider.get(row.provider) ?? [];
    list.push({
      status: row.status,
      scopes: new Set(toStringArray(row.scopes)),
      accountLabel: row.accountLabel,
    });
    byProvider.set(row.provider, list);
  }

  const availability = new Map<LoadableIntegrationSlug, IntegrationAvailability>();
  for (const spec of ACCESS_SPECS) {
    const providerRows = byProvider.get(spec.provider);
    if (!providerRows || providerRows.length === 0) {
      availability.set(spec.slug, { health: null, accountLabel: null });
      continue;
    }
    const active = providerRows.find(
      (row) =>
        row.status === "active" &&
        (spec.anyOfScopes.length === 0 || spec.anyOfScopes.some((scope) => row.scopes.has(scope))),
    );
    availability.set(spec.slug, {
      health: active ? "active" : "needs_reauth",
      accountLabel: active?.accountLabel?.trim() || null,
    });
  }
  return availability;
}

export async function availableIntegrationSlugs(
  userId: string,
  allowedIntegrations: readonly string[],
): Promise<Set<LoadableIntegrationSlug>> {
  const availability = await readIntegrationAvailability(userId);
  const allowed = new Set(allowedIntegrations);
  const available = new Set<LoadableIntegrationSlug>();
  for (const [slug, access] of availability) {
    if (allowed.size > 0 && !allowed.has(slug)) continue;
    if (access.health === "active") available.add(slug);
  }
  return available;
}
