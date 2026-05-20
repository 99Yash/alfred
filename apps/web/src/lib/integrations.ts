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
    status: "connected",
    category: "Connected",
    brand: "gmail",
    actionLabel: "Manage",
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
    status: "connected",
    category: "Connected",
    brand: "google_calendar",
    actionLabel: "Manage",
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
    description: "Access and manage Google Drive files.",
    status: "connected",
    category: "Connected",
    brand: "google_drive",
    actionLabel: "Manage",
    relatedProviderIds: ["google_docs", "google_sheets", "google_slides"],
    capabilities: [
      "Read Files",
      "Upload Files",
      "Download Files",
      "Create Folders",
      "Share Files",
      "Search Files",
      "Manage Permissions",
    ],
    trust: GOOGLE_TRUST,
    overview: {
      body: "Connect your Google Drive to Alfred for comprehensive file management. Access, upload, download, and organize your files directly from your assistant.",
      heading: "Smart File Operations",
      detail:
        "Alfred can help find specific files, organize Drive, share documents with team members, and analyze file contents to answer questions about your documents.",
    },
  },
  {
    id: "github",
    name: "GitHub",
    description: "Manage GitHub repos and workflow.",
    status: "connected",
    category: "Connected",
    brand: "github",
    actionLabel: "Manage",
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
    description: "Create and edit Google Docs.",
    status: "available",
    category: "Productivity",
    brand: "google_docs",
    actionLabel: "Connect",
    capabilities: ["Read Documents", "Create Documents", "Edit Documents", "Search Documents"],
    trust: GOOGLE_TRUST,
    overview: {
      body: "Connect Google Docs to Alfred to read, create, and update documents from agent workflows.",
      heading: "Document Intelligence",
      detail:
        "Alfred can use Docs as source material, draft new documents, and keep generated content tied to your workspace.",
    },
  },
  {
    id: "google_sheets",
    name: "Google Sheets",
    description: "Work with Google Sheets.",
    status: "available",
    category: "Productivity",
    brand: "google_sheets",
    actionLabel: "Connect",
    capabilities: ["Read Sheets", "Update Sheets", "Create Sheets", "Analyze Tables"],
    trust: GOOGLE_TRUST,
    overview: {
      body: "Connect Google Sheets to Alfred for spreadsheet-backed research, reporting, and operational workflows.",
      heading: "Spreadsheet Intelligence",
      detail:
        "Alfred can read tables, update tracked ranges, and use spreadsheet context when producing summaries or recommendations.",
    },
  },
  {
    id: "google_slides",
    name: "Google Slides",
    description: "Create and edit Google Slides.",
    status: "available",
    category: "Productivity",
    brand: "google_slides",
    actionLabel: "Connect",
    capabilities: ["Read Presentations", "Create Slides", "Update Slides", "Export Decks"],
    trust: GOOGLE_TRUST,
    overview: {
      body: "Connect Google Slides to Alfred to create and update presentation decks from assistant output.",
      heading: "Presentation Intelligence",
      detail:
        "Alfred can turn research and structured notes into deck-ready slides while keeping the final artifact in your workspace.",
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
