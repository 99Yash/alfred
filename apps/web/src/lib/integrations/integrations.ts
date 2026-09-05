import {
  CATALOG_SLUGS,
  credentialProviderOf,
  INTEGRATIONS,
  integrationRoutePrefix,
  isCatalogSlug,
  type CatalogSlug,
  type IntegrationSlug,
  type LiveProviderSlug,
} from "@alfred/contracts";
import type { IntegrationBrand } from "~/lib/integrations/integration-icons";

export type IntegrationStatus = "connected" | "available" | "soon";

export type IntegrationCategory =
  | "Connected"
  | "Apps"
  | "Productivity"
  | "Development"
  | "Your Integrations";

export type IntegrationActionLabel = "Manage" | "Connect" | "Coming Soon" | "Add";

/**
 * The web-only prose of one catalog page. Every registry fact (display name,
 * brand, live/planned status, credential shape) is read off the entry in
 * `INTEGRATIONS`, so this type holds nothing the registry already knows.
 */
export interface IntegrationPageCopy {
  readonly description: string;
  readonly category: IntegrationCategory;
  readonly capabilities: ReadonlyArray<string>;
  readonly trust: {
    readonly title: string;
    readonly body: string;
  };
  readonly overview: {
    readonly body: string;
    readonly heading: string;
    readonly detail: string;
    readonly extraHeading?: string | undefined;
    readonly extraDetail?: string | undefined;
  };
  /** Pages to offer under "Complete your setup", by slug. */
  readonly related?: ReadonlyArray<CatalogSlug> | undefined;
}

/**
 * One catalog page: the registry entry's facts under the names the tiles and
 * detail sections read, plus the page copy. `slug` is the only key; the route
 * param, the credential probe, the policy row, and the brand all derive from
 * it. `status` and `actionLabel` are the catalog's static reading; the
 * credential overlay (`useResolvedIntegrations`) flips both to connected.
 */
export interface IntegrationPage extends IntegrationPageCopy {
  readonly slug: CatalogSlug;
  /** The registry display name (`Gmail`, `Calendar`). */
  readonly name: string;
  readonly brand: IntegrationBrand;
  readonly status: IntegrationStatus;
  readonly actionLabel: IntegrationActionLabel;
}

const GOOGLE_TRUST = {
  title: "Your data is indexed & encrypted",
  body: "Your data is indexed and encrypted at rest. We never train AI models on your data or share it with third parties.",
};

/**
 * The page copy, one row per catalog slug. `satisfies Record<CatalogSlug, …>`
 * makes a provider entry without a page, or a page without a provider entry, a
 * compile error, so a new registry entry cannot ship as a brandless tile or a
 * pageless slug (Notion, Railway, and Vercel once did).
 */
const INTEGRATION_PAGE_COPY = {
  gmail: {
    description: "Manage Gmail emails and communications.",
    category: "Apps",
    capabilities: [
      "Read Emails",
      "Compose Emails",
      "Send Emails",
      "Reply to Emails",
      "Manage Labels",
      "Search Conversations",
      "Handle Attachments",
    ],
    trust: GOOGLE_TRUST,
    overview: {
      body: "Connect your Gmail to Alfred for comprehensive email management. Read, compose, and organize your emails with AI assistance.",
      heading: "Email Intelligence",
      detail:
        "Alfred can help draft emails, summarize conversations, find specific messages, and manage inbox organization with smart labeling and filtering.",
    },
  },
  calendar: {
    description: "Manage calendar and schedule events.",
    category: "Apps",
    capabilities: [
      "Read Events",
      "Create Events",
      "Update Events",
      "Delete Events",
      "Check Availability",
      "Manage Attendees",
      "Handle Recurring Events",
    ],
    trust: GOOGLE_TRUST,
    overview: {
      body: "Connect your Google Calendar to Alfred for intelligent scheduling and calendar management. Create meetings, check availability, and manage your schedule seamlessly.",
      heading: "Smart Calendar Integration",
      detail:
        "When you mention dates or times in conversation, Alfred can pull up your calendar for that day and use those events as scheduling context.",
    },
  },
  drive: {
    description: "Read files across your Google Drive.",
    category: "Apps",
    related: ["docs", "sheets", "slides"],
    capabilities: ["Search Files", "List Folders", "Read File Metadata", "Download File Contents"],
    trust: GOOGLE_TRUST,
    overview: {
      body: "Connect Google Drive to Alfred so it can find and read your files when answering questions or composing workflows.",
      heading: "Read-only file access",
      detail:
        "Alfred can search for files, follow folder structures, and pull contents into context. Writes (rename, share, move, delete) are out of scope at this grant level.",
    },
  },
  docs: {
    description: "Read your Google Docs.",
    category: "Productivity",
    capabilities: ["Read Documents", "Extract Headings", "Read Tables", "Search Document Text"],
    trust: GOOGLE_TRUST,
    overview: {
      body: "Connect Google Docs to Alfred so it can pull structured content — headings, paragraphs, tables — into context when you ask.",
      heading: "Read-only document access",
      detail:
        "Alfred can use Docs as source material in answers and workflows. Drafting back to Docs (create/edit) is not enabled at this grant level.",
    },
  },
  sheets: {
    description: "Read and edit your Google Sheets.",
    category: "Productivity",
    capabilities: ["Read Cell Ranges", "Create Spreadsheets", "Write & Append Rows"],
    trust: GOOGLE_TRUST,
    overview: {
      body: "Connect Google Sheets to Alfred for spreadsheet-backed lookups, summaries, and edits.",
      heading: "Read/write spreadsheet access",
      detail:
        "Alfred can read cell ranges, create spreadsheets, and write or append rows on your behalf.",
    },
  },
  slides: {
    description: "Read and edit your Google Slides.",
    category: "Productivity",
    capabilities: ["Read Presentations", "Create Decks", "Add & Edit Slides"],
    trust: GOOGLE_TRUST,
    overview: {
      body: "Connect Google Slides to Alfred to read deck structure and build or edit presentations.",
      heading: "Read/write deck access",
      detail:
        "Alfred can summarize decks, create presentations, and add or edit slides on your behalf.",
    },
  },
  slack: {
    description: "Manage Slack messages and channels.",
    category: "Apps",
    capabilities: [
      "Send Messages",
      "Read Messages",
      "Create Channels",
      "Manage Channels",
      "Fetch Unread Messages",
      "Thread Management",
      "File Sharing",
    ],
    trust: {
      title: "Your data is safe",
      body: "Your data stays in Slack's database. We only access it on your command.",
    },
    overview: {
      body: "Connect your Slack to Alfred for intelligent team communication management. Send messages, manage channels, and stay on top of team conversations.",
      heading: "Communication Intelligence",
      detail:
        "Alfred can help manage team communications, organize channel discussions, summarize conversations, and draft messages for your team.",
    },
  },
  linear: {
    description: "View, create, and manage Linear projects, issues, and docs.",
    category: "Productivity",
    capabilities: [
      "Create Issues",
      "Update Issues",
      "Delete Issues",
      "Manage Teams",
      "Track Milestones",
      "Organize Projects",
      "Assign Tasks",
    ],
    trust: GOOGLE_TRUST,
    overview: {
      body: "Connect your Linear to Alfred for intelligent project and task management. Create issues, track progress, and manage your development workflow.",
      heading: "Project Intelligence",
      detail:
        "Alfred can help organize projects, track team progress, create and assign tasks, and suggest project improvements based on workflow patterns.",
      extraHeading: "Full Access",
      extraDetail:
        "Connecting Linear gives Alfred full access to read and write issues, documents, and projects. This enables both search/indexing and AI-powered actions like creating issues and adding comments.",
    },
  },
  github: {
    description: "Manage GitHub repos and workflow.",
    category: "Development",
    capabilities: ["Read Repositories", "Review Pull Requests", "Manage Issues", "Search Code"],
    trust: GOOGLE_TRUST,
    overview: {
      body: "Connect your GitHub account to Alfred for repository, pull request, issue, and release context.",
      heading: "Development Intelligence",
      detail:
        "Alfred can summarize code work, inspect issue context, and help coordinate development workflows.",
    },
  },
  notion: {
    description: "Search, read, and write Notion pages.",
    category: "Productivity",
    capabilities: ["Search Workspace", "Read Pages", "Create Pages", "Append Content"],
    trust: {
      title: "Alfred only sees what you share",
      body: "Notion's OAuth grant scopes Alfred to the pages and databases you explicitly share with the integration. Nothing else in your workspace is visible.",
    },
    overview: {
      body: "Connect Notion so Alfred can find and read your docs and write new pages or notes on your behalf.",
      heading: "Workspace Intelligence",
      detail:
        "Alfred can search shared pages and databases, pull their contents into answers, create new pages under a parent, and append notes to existing pages.",
    },
  },
  railway: {
    description: "Inspect and redeploy Railway services.",
    category: "Development",
    capabilities: ["List Projects", "Check Deployments", "Read Logs", "Redeploy"],
    trust: {
      title: "Your token, your control",
      body: "Railway has no OAuth, so you paste a workspace-scoped or account API token you generate yourself. Revoke it any time from Railway, or disconnect here.",
    },
    overview: {
      body: "Connect Railway with a workspace-scoped or account API token. Alfred answers questions about your projects and deployments, and redeploys when you ask.",
      heading: "Deployment Intelligence",
      detail:
        "Alfred can list your projects, services, and environments, check deployment status, read deployment logs, and trigger a redeploy.",
    },
  },
  vercel: {
    description: "Inspect and redeploy Vercel projects.",
    category: "Development",
    capabilities: ["List Projects", "Check Deployments", "Redeploy"],
    trust: {
      title: "Scoped to your install",
      body: "Vercel's OAuth scopes Alfred to the account or team you install it on. Manage or remove access from your Vercel integrations page any time.",
    },
    overview: {
      body: "Connect Vercel so Alfred can report on your projects and deployments and redeploy on request.",
      heading: "Deployment Intelligence",
      detail:
        "Alfred can list projects, check recent deployments and their state, and redeploy an existing deployment.",
    },
  },
  sentry: {
    description: "Read Sentry issues and error events.",
    category: "Development",
    capabilities: ["List Issues", "Read Issue Detail", "Read Stack Traces", "Receive Webhooks"],
    trust: {
      title: "Your token, your control",
      body: "You paste a token from an internal integration in your own Sentry organization. Revoke it any time from Sentry, or disconnect here.",
    },
    overview: {
      body: "Connect Sentry with an internal integration token and your organization slug. Alfred reads your issues and events through that integration, and receives its webhooks.",
      heading: "Error Intelligence",
      detail:
        "Alfred can list an organization's projects and issues, read one issue and its latest event with the stack trace, and react when Sentry sends an alert or Seer opens a pull request.",
    },
  },
} satisfies Record<CatalogSlug, IntegrationPageCopy>;

function buildPage(slug: CatalogSlug): IntegrationPage {
  const entry = INTEGRATIONS[slug];
  const live = entry.status === "live";
  return {
    slug,
    name: entry.displayName,
    brand: entry.brand,
    status: live ? "available" : "soon",
    actionLabel: live ? "Connect" : "Coming Soon",
    ...INTEGRATION_PAGE_COPY[slug],
  };
}

/** Every catalog page in registry order: the one list the tiles, dialogs, and overlays iterate. */
export const INTEGRATION_PAGES: ReadonlyArray<IntegrationPage> = CATALOG_SLUGS.map(buildPage);

export const CATEGORY_ORDER: ReadonlyArray<IntegrationCategory> = [
  "Connected",
  "Apps",
  "Productivity",
  "Development",
  "Your Integrations",
];

/** The page of a known catalog slug. */
export function integrationPage(slug: CatalogSlug): IntegrationPage {
  // SAFETY: `INTEGRATION_PAGES` is `CATALOG_SLUGS.map(buildPage)`, so every
  // catalog slug has exactly one page in it.
  return INTEGRATION_PAGES.find((page) => page.slug === slug) as IntegrationPage;
}

/**
 * The page for an unchecked string (a tool-name prefix, a mention value, a
 * route param), or `undefined` when it is not a catalog slug.
 */
export function getIntegrationPage(value: string): IntegrationPage | undefined {
  return isCatalogSlug(value) ? integrationPage(value) : undefined;
}

/**
 * Brand mark for an integration slug, or `undefined` for a slug without a page
 * (Alfred's own `system` tools, the `mcp` projection, the `imessage` channel).
 * Every provider entry carries a brand, so a slug with a page always renders
 * its own mark.
 */
export function brandForIntegration(slug: IntegrationSlug): IntegrationBrand | undefined {
  const entry = INTEGRATIONS[slug];
  return entry.kind === "provider" ? entry.brand : undefined;
}

export function getRelatedPages(page: IntegrationPage): ReadonlyArray<IntegrationPage> {
  return (page.related ?? []).map(integrationPage);
}

export function matchesIntegration(page: IntegrationPage, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return `${page.name} ${page.description} ${page.capabilities.join(" ")}`
    .toLowerCase()
    .includes(needle);
}

/**
 * The API path that starts a live provider's connect flow: the provider's route
 * family plus `/connect`, and for a Google product the `?features=` the entry
 * declares, so the consent screen asks only for that product's scopes
 * (Google's `include_granted_scopes=true` merges the grant into an existing
 * one). A `token_paste` credential POSTs a token to this path instead of
 * redirecting to it; `DetailHeader` branches on the credential, not the slug.
 */
export function connectPathFor(slug: LiveProviderSlug): string {
  const path = `${integrationRoutePrefix(credentialProviderOf(slug))}/connect`;
  const credential = INTEGRATIONS[slug].credential;
  return credential.shape === "google_oauth"
    ? `${path}?features=${credential.features.join(",")}`
    : path;
}
