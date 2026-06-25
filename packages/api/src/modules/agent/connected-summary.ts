import {
  INTEGRATION_ACTIONS,
  toStringArray,
  type LoadableIntegrationSlug,
} from "@alfred/contracts";
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

/**
 * ADR-0053 connected summary: a frozen, human-readable one-line-per-integration
 * grounding block ("slug — actions — short desc", with `(needs reauth)` markers)
 * snapshotted into `agent_runs.state` at run start and concatenated into the
 * boss/chat/sub-agent system prompt. It is *grounding*, not the security floor:
 * the dispatcher still hard-enforces `allowed_integrations` + connection health
 * before any tool executes. Its job here is to tell the model — in exact-slug
 * copy it can paste into an `integration.action` tool name — which services are
 * actually live, so the boss stops inventing tools or asking the user to load
 * an integration it is already connected to.
 *
 * Computed once per run (one DB read) and cached in run state; never recomputed
 * mid-turn, so the system-prompt prefix stays cache-stable (ADR-0053 / ADR-0026).
 */

interface SummarySlug {
  slug: LoadableIntegrationSlug;
  /** `integration_credentials.provider` that backs this slug. */
  provider: string;
  /**
   * Any one of these granted scopes proves a credential can serve this slug.
   * Empty means no scope gate (GitHub rides an App installation, not scopes).
   */
  anyOfScopes: readonly string[];
  /** Short, user-facing description of what the slug reaches. */
  blurb: string;
  /**
   * When true, append the connected account's identity (e.g. GitHub login) to
   * the catalog line — the F2 binding (ADR-0071). It lets the boss resolve
   * `author:@me` / `owner` from its own connection instead of asking the user.
   * Scoped to GitHub today: that is the connection whose missing identity made
   * the boss ask "which repo?" on a self-referential question.
   */
  showIdentity?: boolean;
}

/**
 * Ordered for stable, readable output. Empty-action stubs (`slack`, `linear`,
 * `imessage`) are intentionally omitted — ADR-0053 skips empty-action slugs.
 */
const SUMMARY_SLUGS: readonly SummarySlug[] = [
  {
    slug: "gmail",
    provider: "google",
    anyOfScopes: [GMAIL_READONLY_SCOPE],
    blurb: "the user's email",
  },
  {
    slug: "calendar",
    provider: "google",
    anyOfScopes: [CALENDAR_READONLY_SCOPE, CALENDAR_EVENTS_SCOPE],
    blurb: "the user's calendar",
  },
  {
    slug: "drive",
    provider: "google",
    anyOfScopes: [DRIVE_SCOPE],
    blurb: "the user's Drive files",
  },
  { slug: "docs", provider: "google", anyOfScopes: [DOCS_SCOPE], blurb: "the user's Google Docs" },
  {
    slug: "sheets",
    provider: "google",
    anyOfScopes: [SHEETS_SCOPE],
    blurb: "the user's spreadsheets",
  },
  {
    slug: "slides",
    provider: "google",
    anyOfScopes: [SLIDES_SCOPE],
    blurb: "the user's presentations",
  },
  {
    slug: "github",
    provider: "github",
    anyOfScopes: [],
    blurb: "the user's GitHub issues and pull requests",
    showIdentity: true,
  },
  // Bearer-token providers (Notion OAuth, Railway API token, Vercel OAuth):
  // connection is proven by an active credential, not a granted scope, so
  // `anyOfScopes` is empty like GitHub.
  {
    slug: "notion",
    provider: "notion",
    anyOfScopes: [],
    blurb: "the user's Notion pages and databases",
  },
  {
    slug: "railway",
    provider: "railway",
    anyOfScopes: [],
    blurb: "the user's Railway projects, deployments, and logs",
  },
  {
    slug: "vercel",
    provider: "vercel",
    anyOfScopes: [],
    blurb: "the user's Vercel projects and deployments",
  },
];

const CONNECTED_HEADER =
  "You are connected to these integrations right now — call each as integration.action (for example calendar.list_events). Treat this list as authoritative: do not offer or attempt an integration that is not on it.";

const NO_INTEGRATIONS_TEXT =
  "You have no integrations connected right now. If the user asks about their email, calendar, files, or other connected data, tell them they need to connect it first — never pretend to have access you do not.";

type SlugHealth = "active" | "needs_reauth";

interface ProviderRow {
  status: string;
  scopes: Set<string>;
  accountLabel: string | null;
}

/**
 * Reduce a provider's credential rows to one health verdict for a slug, mirroring
 * ADR-0053 micro-decision 3: an active row carrying a required scope wins; a
 * relevant-but-unusable row (inactive, or active but scope-insufficient) reports
 * `needs_reauth`; no relevant row at all means the slug is not connected (`null`,
 * omitted from the summary).
 */
function healthForSlug(
  spec: SummarySlug,
  byProvider: Map<string, ProviderRow[]>,
): SlugHealth | null {
  const rows = byProvider.get(spec.provider);
  if (!rows || rows.length === 0) return null;
  const capable = rows.some(
    (r) =>
      r.status === "active" &&
      (spec.anyOfScopes.length === 0 || spec.anyOfScopes.some((s) => r.scopes.has(s))),
  );
  return capable ? "active" : "needs_reauth";
}

/** The active credential's account label for a slug's provider (the F2 identity). */
function identityForSlug(spec: SummarySlug, byProvider: Map<string, ProviderRow[]>): string | null {
  if (!spec.showIdentity) return null;
  const active = byProvider.get(spec.provider)?.find((r) => r.status === "active");
  const label = active?.accountLabel?.trim();
  return label ? label : null;
}

/**
 * Build the connected summary for `userId`, bounded to `allowedIntegrations`
 * (empty = unrestricted among connected loadable integrations, per ADR-0053).
 * One DB read; call it once at run start and cache the result in run state.
 */
export async function buildConnectedSummary(
  userId: string,
  allowedIntegrations: readonly string[],
): Promise<string> {
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
    const scopeList = toStringArray(row.scopes);
    const list = byProvider.get(row.provider) ?? [];
    list.push({ status: row.status, scopes: new Set(scopeList), accountLabel: row.accountLabel });
    byProvider.set(row.provider, list);
  }

  const allowed = new Set(allowedIntegrations);
  const lines: string[] = [];
  for (const spec of SUMMARY_SLUGS) {
    if (allowed.size > 0 && !allowed.has(spec.slug)) continue;
    const health = healthForSlug(spec, byProvider);
    if (health === null) continue;
    const actions = INTEGRATION_ACTIONS[spec.slug].join(", ");
    const marker = health === "needs_reauth" ? " (needs reauth)" : "";
    const identity = identityForSlug(spec, byProvider);
    const binding = identity ? ` — connected as ${identity}` : "";
    lines.push(`- ${spec.slug} — ${actions} — ${spec.blurb}${binding}${marker}`);
  }

  if (lines.length === 0) return NO_INTEGRATIONS_TEXT;
  return [CONNECTED_HEADER, ...lines].join("\n");
}
