import type { IntegrationBrand } from "~/lib/integration-icons";

export type IntegrationStatus = "connected" | "available" | "soon";

export type IntegrationCategory =
  | "Connected"
  | "Apps"
  | "Productivity"
  | "Development"
  | "Your Integrations";

export type IntegrationProvider = {
  id: string;
  name: string;
  description: string;
  status: IntegrationStatus;
  category: IntegrationCategory;
  brand: IntegrationBrand;
  actionLabel: "Manage" | "Connect" | "Coming Soon" | "Add";
  capabilities: ReadonlyArray<string>;
  trust: {
    title: string;
    body: string;
  };
  overview: {
    body: string;
    heading: string;
    detail: string;
    extraHeading?: string;
    extraDetail?: string;
  };
  relatedProviderIds?: ReadonlyArray<string>;
};

const GOOGLE_TRUST = {
  title: "Your data is indexed & encrypted",
  body: "Your data is indexed and encrypted at rest. We never train AI models on your data or share it with third parties.",
};

export const INTEGRATION_PROVIDERS: ReadonlyArray<IntegrationProvider> = [
  {
    id: "google_gmail",
    name: "Gmail",
    description: "Manage Gmail emails and communications.",
    status: "available",
    category: "Apps",
    brand: "gmail",
    actionLabel: "Connect",
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
  {
    id: "google_calendar",
    name: "Google Calendar",
    description: "Manage calendar and schedule events.",
    status: "available",
    category: "Apps",
    brand: "google_calendar",
    actionLabel: "Connect",
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
  {
    id: "google_drive",
    name: "Google Drive",
    description: "Read files across your Google Drive.",
    status: "available",
    category: "Apps",
    brand: "google_drive",
    actionLabel: "Connect",
    relatedProviderIds: ["google_docs", "google_sheets", "google_slides"],
    capabilities: ["Search Files", "List Folders", "Read File Metadata", "Download File Contents"],
    trust: GOOGLE_TRUST,
    overview: {
      body: "Connect Google Drive to Alfred so it can find and read your files when answering questions or composing workflows.",
      heading: "Read-only file access",
      detail:
        "Alfred can search for files, follow folder structures, and pull contents into context. Writes (rename, share, move, delete) are out of scope at this grant level.",
    },
  },
  {
    id: "github",
    name: "GitHub",
    description: "Manage GitHub repos and workflow.",
    status: "available",
    category: "Development",
    brand: "github",
    actionLabel: "Connect",
    capabilities: ["Read Repositories", "Review Pull Requests", "Manage Issues", "Search Code"],
    trust: GOOGLE_TRUST,
    overview: {
      body: "Connect your GitHub account to Alfred for repository, pull request, issue, and release context.",
      heading: "Development Intelligence",
      detail:
        "Alfred can summarize code work, inspect issue context, and help coordinate development workflows.",
    },
  },
  {
    id: "slack",
    name: "Slack",
    description: "Manage Slack messages and channels.",
    status: "available",
    category: "Apps",
    brand: "slack",
    actionLabel: "Connect",
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
  {
    id: "google_docs",
    name: "Google Docs",
    description: "Read your Google Docs.",
    status: "available",
    category: "Productivity",
    brand: "google_docs",
    actionLabel: "Connect",
    capabilities: ["Read Documents", "Extract Headings", "Read Tables", "Search Document Text"],
    trust: GOOGLE_TRUST,
    overview: {
      body: "Connect Google Docs to Alfred so it can pull structured content — headings, paragraphs, tables — into context when you ask.",
      heading: "Read-only document access",
      detail:
        "Alfred can use Docs as source material in answers and workflows. Drafting back to Docs (create/edit) is not enabled at this grant level.",
    },
  },
  {
    id: "google_sheets",
    name: "Google Sheets",
    description: "Read and edit your Google Sheets.",
    status: "available",
    category: "Productivity",
    brand: "google_sheets",
    actionLabel: "Connect",
    capabilities: ["Read Cell Ranges", "Create Spreadsheets", "Write & Append Rows"],
    trust: GOOGLE_TRUST,
    overview: {
      body: "Connect Google Sheets to Alfred for spreadsheet-backed lookups, summaries, and edits.",
      heading: "Read/write spreadsheet access",
      detail:
        "Alfred can read cell ranges, create spreadsheets, and write or append rows on your behalf.",
    },
  },
  {
    id: "google_slides",
    name: "Google Slides",
    description: "Read and edit your Google Slides.",
    status: "available",
    category: "Productivity",
    brand: "google_slides",
    actionLabel: "Connect",
    capabilities: ["Read Presentations", "Create Decks", "Add & Edit Slides"],
    trust: GOOGLE_TRUST,
    overview: {
      body: "Connect Google Slides to Alfred to read deck structure and build or edit presentations.",
      heading: "Read/write deck access",
      detail:
        "Alfred can summarize decks, create presentations, and add or edit slides on your behalf.",
    },
  },
  {
    id: "linear",
    name: "Linear",
    description: "View, create, and manage Linear projects, issues, and docs.",
    status: "available",
    category: "Productivity",
    brand: "linear",
    actionLabel: "Connect",
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
];

export const CATEGORY_ORDER: ReadonlyArray<IntegrationCategory> = [
  "Connected",
  "Apps",
  "Productivity",
  "Development",
  "Your Integrations",
];

const SHORT_SLUG_ALIASES: Readonly<Record<string, string>> = {
  gmail: "google_gmail",
  calendar: "google_calendar",
  drive: "google_drive",
  docs: "google_docs",
  sheets: "google_sheets",
  slides: "google_slides",
};

export function getIntegrationProvider(id: string): IntegrationProvider | undefined {
  const canonical = SHORT_SLUG_ALIASES[id] ?? id;
  return INTEGRATION_PROVIDERS.find((provider) => provider.id === canonical);
}

/**
 * Reverse of `SHORT_SLUG_ALIASES`: maps a catalog provider id (e.g.
 * `google_gmail`) to the `@alfred/contracts` integration slug (e.g.
 * `gmail`) the tool registry keys on. Google providers de-prefix; every
 * other provider's id already equals its slug. Returns `undefined` for
 * unknown ids so callers can skip the registry lookup.
 */
const PROVIDER_ID_TO_SLUG: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(SHORT_SLUG_ALIASES).map(([slug, id]) => [id, slug]),
);

export function integrationSlugForProvider(providerId: string): string {
  return PROVIDER_ID_TO_SLUG[providerId] ?? providerId;
}

export function getRelatedProviders(provider: IntegrationProvider): IntegrationProvider[] {
  return (provider.relatedProviderIds ?? [])
    .map((id) => getIntegrationProvider(id))
    .filter((related): related is IntegrationProvider => Boolean(related));
}

export function matchesIntegration(provider: IntegrationProvider, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return `${provider.name} ${provider.description} ${provider.capabilities.join(" ")}`
    .toLowerCase()
    .includes(needle);
}

/**
 * Provider → required OAuth scopes the user must have granted for the
 * provider tile to render as "Connected". A provider absent from this map
 * has no live backend yet; its catalog-declared `status` is the source of
 * truth (typically `"soon"`).
 */
export type ProviderScopeRequirement = string | ReadonlyArray<string>;

export const PROVIDER_REQUIRED_SCOPES: Readonly<
  Record<string, ReadonlyArray<ProviderScopeRequirement>>
> = {
  google_gmail: ["https://www.googleapis.com/auth/gmail.readonly"],
  google_calendar: [
    [
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/calendar.events",
    ],
  ],
  google_drive: ["https://www.googleapis.com/auth/drive"],
  google_docs: ["https://www.googleapis.com/auth/documents"],
  google_sheets: ["https://www.googleapis.com/auth/spreadsheets"],
  google_slides: ["https://www.googleapis.com/auth/presentations"],
  // GitHub is intentionally absent: post-ADR-0052 the App install carries no
  // OAuth scopes, so its connection is probed by an active credential with an
  // `installation_id` (see `resolveOne` in use-integration-status.ts), not by
  // scopes.
};

/**
 * Provider id → the upstream provider key in the `integration_credentials`
 * table. Providers in this map are checked against real credential rows
 * by `useResolvedIntegrations`; everything else falls back to the catalog
 * status (typically `"soon"`).
 */
export const PROVIDER_BACKEND: Readonly<Record<string, "google" | "github">> = {
  google_gmail: "google",
  google_calendar: "google",
  google_drive: "google",
  google_docs: "google",
  google_sheets: "google",
  google_slides: "google",
  github: "github",
};
