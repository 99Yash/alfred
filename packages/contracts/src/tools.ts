export const POLICY_MODES = ["autonomy", "gated"] as const;
export type PolicyMode = (typeof POLICY_MODES)[number];

export const LOADABLE_INTEGRATION_SLUGS = [
  "gmail",
  "calendar",
  "drive",
  "docs",
  "sheets",
  "slides",
  "slack",
  "linear",
  "github",
  "notion",
  "railway",
  "vercel",
  "imessage",
] as const;
export type LoadableIntegrationSlug = (typeof LOADABLE_INTEGRATION_SLUGS)[number];

export const INTEGRATION_SLUGS = ["system", ...LOADABLE_INTEGRATION_SLUGS] as const;
export type IntegrationSlug = (typeof INTEGRATION_SLUGS)[number];

export const SYSTEM_ACTIONS = [
  "load_integration",
  "spawn_sub_agent",
  "read_user_context",
  "read_scratch",
  "write_scratch",
  "promote",
  "remember",
  "resolve_todo",
  "suggest_todo",
  "web_search",
] as const;

export const GMAIL_ACTIONS = ["search", "read_message", "send_draft"] as const;

export const CALENDAR_ACTIONS = ["list_events", "create_event"] as const;

export const DRIVE_ACTIONS = ["search_files", "get_file", "export_file", "download_file"] as const;
export const DOCS_ACTIONS = ["get_document"] as const;

export const SHEETS_ACTIONS = [
  "create_spreadsheet",
  "get_values",
  "update_values",
  "append_values",
  "batch_update",
  "add_sheet",
] as const;

export const SLIDES_ACTIONS = [
  "create_presentation",
  "get_presentation",
  "batch_update",
  "add_slide",
] as const;

export const SLACK_ACTIONS = [] as const;
export const LINEAR_ACTIONS = [] as const;
export const GITHUB_ACTIONS = ["search_pull_requests"] as const;

export const NOTION_ACTIONS = ["search", "get_page", "create_page", "append_blocks"] as const;

export const RAILWAY_ACTIONS = [
  "list_projects",
  "list_deployments",
  "get_logs",
  "redeploy",
] as const;

export const VERCEL_ACTIONS = ["list_projects", "list_deployments", "redeploy"] as const;

export const IMESSAGE_ACTIONS = [] as const;

export const INTEGRATION_ACTIONS = {
  system: SYSTEM_ACTIONS,
  gmail: GMAIL_ACTIONS,
  calendar: CALENDAR_ACTIONS,
  drive: DRIVE_ACTIONS,
  docs: DOCS_ACTIONS,
  sheets: SHEETS_ACTIONS,
  slides: SLIDES_ACTIONS,
  slack: SLACK_ACTIONS,
  linear: LINEAR_ACTIONS,
  github: GITHUB_ACTIONS,
  notion: NOTION_ACTIONS,
  railway: RAILWAY_ACTIONS,
  vercel: VERCEL_ACTIONS,
  imessage: IMESSAGE_ACTIONS,
} as const satisfies Record<IntegrationSlug, readonly string[]>;

export type ActionSlug<I extends IntegrationSlug> = (typeof INTEGRATION_ACTIONS)[I][number];

export type ToolName = {
  [K in IntegrationSlug]: ActionSlug<K> extends never ? never : `${K}.${ActionSlug<K>}`;
}[IntegrationSlug];

export const TOOL_RISK_TIERS = ["no_risk", "low", "medium", "high"] as const;
export type ToolRiskTier = (typeof TOOL_RISK_TIERS)[number];

export interface IntegrationRule {
  mode: PolicyMode;
  toolOverrides?: Partial<Record<ToolName, PolicyMode>>;
}

export type IntegrationRules = Partial<Record<IntegrationSlug, IntegrationRule>>;

/**
 * Derive an integration's effective policy mode from a rules map + the
 * user default. The single source for this projection — the dispatcher's
 * `resolvePolicyMode` (server) and the policy editor (web) both call it so
 * the displayed mode and the enforced mode can't drift. Per-tool overrides
 * are deliberately ignored here: this is the per-integration radio's value,
 * not a per-tool resolution (that stays in `resolvePolicyMode`).
 */
export function resolveIntegrationMode(
  rules: IntegrationRules,
  slug: IntegrationSlug,
  defaultMode: PolicyMode,
): PolicyMode {
  return rules[slug]?.mode ?? defaultMode;
}

export function integrationFromToolName(toolName: ToolName): IntegrationSlug {
  const integration = toolName.slice(0, toolName.indexOf("."));
  if (isIntegrationSlug(integration)) return integration;
  throw new Error(`Unknown integration in tool name '${toolName}'`);
}

export function buildToolName<I extends IntegrationSlug, A extends ActionSlug<I> & string>(
  integration: I,
  action: A,
): ToolName {
  const name = `${integration}.${action}`;
  if (isToolName(name)) return name;
  throw new Error(`Unknown tool name '${name}'`);
}

export function isIntegrationSlug(value: string): value is IntegrationSlug {
  return (INTEGRATION_SLUGS as readonly string[]).includes(value);
}

export function isToolName(value: string): value is ToolName {
  const separator = value.indexOf(".");
  if (separator <= 0 || separator !== value.lastIndexOf(".")) return false;

  const integration = value.slice(0, separator);
  if (!isIntegrationSlug(integration)) return false;

  const action = value.slice(separator + 1);
  const actions: readonly string[] = INTEGRATION_ACTIONS[integration];
  return actions.includes(action);
}

export function isLoadableIntegrationSlug(value: string): value is LoadableIntegrationSlug {
  return (LOADABLE_INTEGRATION_SLUGS as readonly string[]).includes(value);
}

export function hashToolInput(toolName: ToolName, input: unknown): string {
  return `fnv1a64:${fnv1a64(`${toolName}:${canonicalJson(input)}`)}`;
}

/**
 * Title-case a snake/underscore slug for display: `send_draft` → `Send Draft`.
 * Shared so the email worker and the approvals card never drift.
 */
export function humanizeSlug(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

/**
 * Human phrasing for a single tool, co-located here so every surface reads the
 * same words. The chat transcript narrates with the `running` → `done` verbs;
 * approvals and the email notification worker use the imperative `title`.
 */
export interface ToolLabel {
  /** Present-continuous, shown in the chat row while the call is in flight. */
  running: string;
  /** Past tense, shown once the call lands. */
  done: string;
  /**
   * Imperative, lowercase-leading so it reads after "Alfred wants to …" (email
   * subject) and capitalizes cleanly as an approval card title.
   */
  title: string;
}

/**
 * The single source of truth for tool-facing copy. Keyed by `ToolName`, so the
 * type checker forces a label for every tool the moment it's added to
 * `INTEGRATION_ACTIONS` — labels can never silently fall back to a raw
 * `snake_case` symbol again. Pure + zero-dep so the server notification worker,
 * the approvals card, and the chat transcript all import the one map.
 *
 * `system.load_integration` and `system.spawn_sub_agent` carry static fallbacks
 * here; their chat rows refine them with the live target (e.g. "Connecting to
 * GitHub") at the call site, where the integration catalog is available.
 */
export const TOOL_LABELS: Record<ToolName, ToolLabel> = {
  "system.load_integration": {
    running: "Connecting an integration",
    done: "Connected an integration",
    title: "connect an integration",
  },
  "system.spawn_sub_agent": {
    running: "Delegating a sub-task",
    done: "Delegated a sub-task",
    title: "delegate a sub-task",
  },
  "system.read_user_context": {
    running: "Reading user context",
    done: "Read user context",
    title: "read user context",
  },
  "system.read_scratch": { running: "Reading notes", done: "Read notes", title: "read notes" },
  "system.write_scratch": { running: "Saving notes", done: "Saved notes", title: "save notes" },
  "system.promote": {
    running: "Recording a finding",
    done: "Recorded a finding",
    title: "record a finding",
  },
  "system.remember": {
    running: "Remembering an instruction",
    done: "Remembered an instruction",
    title: "remember an instruction",
  },
  "system.resolve_todo": {
    running: "Resolving a to-do",
    done: "Resolved a to-do",
    title: "resolve a to-do",
  },
  "system.suggest_todo": {
    running: "Suggesting a to-do",
    done: "Suggested a to-do",
    title: "suggest a to-do",
  },
  "system.web_search": {
    running: "Searching the web",
    done: "Searched the web",
    title: "search the web",
  },

  "gmail.search": { running: "Searching Gmail", done: "Searched Gmail", title: "search Gmail" },
  "gmail.read_message": {
    running: "Reading a Gmail message",
    done: "Read a Gmail message",
    title: "read a Gmail message",
  },
  "gmail.send_draft": {
    running: "Sending a Gmail draft",
    done: "Sent a Gmail draft",
    title: "send a Gmail draft",
  },

  "calendar.list_events": {
    running: "Checking your calendar",
    done: "Checked your calendar",
    title: "list calendar events",
  },
  "calendar.create_event": {
    running: "Creating a calendar event",
    done: "Created a calendar event",
    title: "create a calendar event",
  },

  "drive.search_files": {
    running: "Searching Drive",
    done: "Searched Drive",
    title: "search Drive",
  },
  "drive.get_file": {
    running: "Opening a Drive file",
    done: "Opened a Drive file",
    title: "open a Drive file",
  },
  "drive.export_file": {
    running: "Exporting a Drive file",
    done: "Exported a Drive file",
    title: "export a Drive file",
  },
  "drive.download_file": {
    running: "Downloading a Drive file",
    done: "Downloaded a Drive file",
    title: "download a Drive file",
  },

  "docs.get_document": {
    running: "Reading a Google Doc",
    done: "Read a Google Doc",
    title: "read a Google Doc",
  },

  "sheets.create_spreadsheet": {
    running: "Creating a spreadsheet",
    done: "Created a spreadsheet",
    title: "create a spreadsheet",
  },
  "sheets.get_values": {
    running: "Reading spreadsheet values",
    done: "Read spreadsheet values",
    title: "read spreadsheet values",
  },
  "sheets.update_values": {
    running: "Updating spreadsheet values",
    done: "Updated spreadsheet values",
    title: "update spreadsheet values",
  },
  "sheets.append_values": {
    running: "Appending spreadsheet rows",
    done: "Appended spreadsheet rows",
    title: "append spreadsheet rows",
  },
  "sheets.batch_update": {
    running: "Updating the spreadsheet",
    done: "Updated the spreadsheet",
    title: "update the spreadsheet",
  },
  "sheets.add_sheet": { running: "Adding a sheet", done: "Added a sheet", title: "add a sheet" },

  "slides.create_presentation": {
    running: "Creating a presentation",
    done: "Created a presentation",
    title: "create a presentation",
  },
  "slides.get_presentation": {
    running: "Reading a presentation",
    done: "Read a presentation",
    title: "read a presentation",
  },
  "slides.batch_update": {
    running: "Updating the presentation",
    done: "Updated the presentation",
    title: "update the presentation",
  },
  "slides.add_slide": {
    running: "Adding a slide",
    done: "Added a slide",
    title: "add a slide",
  },

  "github.search_pull_requests": {
    running: "Searching pull requests",
    done: "Searched pull requests",
    title: "search pull requests",
  },

  "notion.search": {
    running: "Searching Notion",
    done: "Searched Notion",
    title: "search Notion",
  },
  "notion.get_page": {
    running: "Reading a Notion page",
    done: "Read a Notion page",
    title: "read a Notion page",
  },
  "notion.create_page": {
    running: "Creating a Notion page",
    done: "Created a Notion page",
    title: "create a Notion page",
  },
  "notion.append_blocks": {
    running: "Adding to a Notion page",
    done: "Added to a Notion page",
    title: "add content to a Notion page",
  },

  "railway.list_projects": {
    running: "Listing Railway projects",
    done: "Listed Railway projects",
    title: "list Railway projects",
  },
  "railway.list_deployments": {
    running: "Checking Railway deployments",
    done: "Checked Railway deployments",
    title: "check Railway deployments",
  },
  "railway.get_logs": {
    running: "Reading Railway logs",
    done: "Read Railway logs",
    title: "read Railway logs",
  },
  "railway.redeploy": {
    running: "Redeploying on Railway",
    done: "Triggered a Railway redeploy",
    title: "redeploy a Railway service",
  },

  "vercel.list_projects": {
    running: "Listing Vercel projects",
    done: "Listed Vercel projects",
    title: "list Vercel projects",
  },
  "vercel.list_deployments": {
    running: "Checking Vercel deployments",
    done: "Checked Vercel deployments",
    title: "check Vercel deployments",
  },
  "vercel.redeploy": {
    running: "Redeploying on Vercel",
    done: "Triggered a Vercel redeploy",
    title: "redeploy a Vercel deployment",
  },
};

/** The co-located label for a tool, or `null` for an unregistered name. */
export function toolLabel(toolName: string): ToolLabel | null {
  return isToolName(toolName) ? TOOL_LABELS[toolName] : null;
}

/**
 * Human phrase for "what does this tool do", in the imperative so it reads
 * after "Alfred wants to …" (email subject) and as a card title. Registered
 * tools resolve from {@link TOOL_LABELS}; anything else falls back to a generic
 * `${action} in ${integration}` phrasing. Pure + zero-dep so both the server
 * notification worker and the web approvals card import the one source.
 */
export function humanizeToolName(toolName: string): string {
  if (isToolName(toolName)) return TOOL_LABELS[toolName].title;
  const separator = toolName.indexOf(".");
  const integration = separator > 0 ? toolName.slice(0, separator) : toolName;
  const action = separator > 0 ? toolName.slice(separator + 1) : "";
  return action
    ? `${humanizeSlug(action)} in ${humanizeSlug(integration)}`
    : humanizeSlug(integration);
}

function canonicalJson(value: unknown): string {
  return stringifyCanonical(value, new WeakSet<object>());
}

function stringifyCanonical(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return "null";

  const valueType = typeof value;
  if (valueType === "string") return JSON.stringify(value);
  if (valueType === "number") return Number.isFinite(value) ? String(value) : "null";
  if (valueType === "boolean") return value ? "true" : "false";
  if (valueType === "bigint") throw new TypeError("Cannot hash tool input containing bigint");
  if (valueType === "undefined" || valueType === "function" || valueType === "symbol") {
    return "null";
  }

  if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
    return stringifyCanonical((value as { toJSON: () => unknown }).toJSON(), seen);
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Cannot hash circular tool input");
    seen.add(value);
    const items = value.map((item) => {
      const itemType = typeof item;
      if (itemType === "undefined" || itemType === "function" || itemType === "symbol") {
        return "null";
      }
      return stringifyCanonical(item, seen);
    });
    seen.delete(value);
    return `[${items.join(",")}]`;
  }

  if (valueType === "object") {
    const objectValue = value as Record<string, unknown>;
    if (seen.has(objectValue)) throw new TypeError("Cannot hash circular tool input");
    seen.add(objectValue);
    const entries = Object.keys(objectValue)
      .sort()
      .flatMap((key) => {
        const item = objectValue[key];
        const itemType = typeof item;
        if (itemType === "undefined" || itemType === "function" || itemType === "symbol") {
          return [];
        }
        return [`${JSON.stringify(key)}:${stringifyCanonical(item, seen)}`];
      });
    seen.delete(objectValue);
    return `{${entries.join(",")}}`;
  }

  return "null";
}

function fnv1a64(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;

  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & mask;
  }

  return hash.toString(16).padStart(16, "0");
}
