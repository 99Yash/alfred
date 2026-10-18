import { z } from "zod";
import { enumGuard, isIndexable } from "./guards";
import {
  INTEGRATION_ACTIONS,
  INTEGRATION_DISPLAY_NAMES,
  INTEGRATION_SLUGS,
  isIntegrationSlug,
  type IntegrationSlug,
} from "./integrations";

export const POLICY_MODES = ["autonomy", "gated"] as const;

export type PolicyMode = (typeof POLICY_MODES)[number];

/** `${slug}.${action}` is the tool name. */
export type ActionSlug<I extends IntegrationSlug> = (typeof INTEGRATION_ACTIONS)[I][number];

export type ToolName = {
  [K in IntegrationSlug]: ActionSlug<K> extends never ? never : `${K}.${ActionSlug<K>}`;
}[IntegrationSlug];

/**
 * Run facts that change which tools are allowed. Only a live chat can use
 * conversation-bound tools, even if a background run reports into a chat.
 * Build it from validated run state only.
 */
export interface ToolRunContext {
  caller: "boss" | "sub_agent";
  interaction: "live_chat" | "background";
}

/**
 * Stops new effects after a cancel (#559b). `cancelRunInTx` bumps `generation`.
 * The dispatch gate re-reads it before each effect; a higher value means the run
 * was cancelled mid-step.
 */
export const cancellationFenceSchema = z.object({
  generation: z.number().int().min(0),
});

export type CancellationFence = z.infer<typeof cancellationFenceSchema>;

/** The run was cancelled mid-step. The call did not run; never repeat it. */
export const cancellationEnvelopeSchema = z.object({
  status: z.literal("cancelled"),
  retry: z.literal("never"),
  message: z.string(),
});

export type CancellationEnvelope = z.infer<typeof cancellationEnvelopeSchema>;

/** Many surfaces compare against these names. `satisfies` makes a rename fail here. */
export const SPAWN_SUB_AGENT_TOOL = "system.spawn_sub_agent" satisfies ToolName;

export const AWAIT_SUB_AGENT_TOOL = "system.await_sub_agent" satisfies ToolName;

/**
 * Parks a chat turn on a `question` approval (ADR-0099). Readers without the
 * registry key on this name. The registry checks at boot that it owns the arm.
 */
export const ASK_USER_TOOL = "system.ask_user" satisfies ToolName;

/** True when a staged row holds a question, not a write. Takes `string`: callers read stored names. */
export function isQuestionApproval(toolName: string): boolean {
  return toolName === ASK_USER_TOOL;
}

export const TOOL_RISK_TIERS = ["no_risk", "low", "medium", "high"] as const;

export type ToolRiskTier = (typeof TOOL_RISK_TIERS)[number];

/**
 * Check a stored tier before you trust it. Only `"high"` gates (ADR-0069), so a bad
 * value would un-gate. On false, fall back to the conservative floor.
 */
export const isToolRiskTier = enumGuard(TOOL_RISK_TIERS);

/** Tiers that can change state outside Alfred. `low` is a read, so it is absent. */
export const WRITE_RISK_TIERS = ["medium", "high"] as const satisfies readonly ToolRiskTier[];

export const isWriteRiskTier = enumGuard(WRITE_RISK_TIERS);

export type RiskTierCounts = Record<ToolRiskTier, number>;

export interface IntegrationRule {
  mode: PolicyMode;
  toolOverrides?: Partial<Record<ToolName, PolicyMode>>;
}

export type IntegrationRules = Partial<Record<IntegrationSlug, IntegrationRule>>; // drift-ok: sparse per-user overrides; absence is the default mode

/** The per-integration mode for the policy editor. Ignores per-tool overrides (see `resolvePolicyMode`). */
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

export function isToolName(value: unknown): value is ToolName {
  if (typeof value !== "string") return false;
  const separator = value.indexOf(".");

  if (separator <= 0 || separator !== value.lastIndexOf(".")) return false;

  const integration = value.slice(0, separator);

  if (!isIntegrationSlug(integration)) return false;

  const action = value.slice(separator + 1);
  const actions: readonly string[] = INTEGRATION_ACTIONS[integration];

  return actions.includes(action);
}

/** For model-facing JSON Schema enums. */
export const TOOL_NAMES: readonly ToolName[] = INTEGRATION_SLUGS.flatMap((integration) =>
  INTEGRATION_ACTIONS[integration].map((action) => {
    const name = `${integration}.${action}`;

    if (!isToolName(name)) throw new Error(`Invalid declared tool name '${name}'`);

    return name;
  }),
);

/** `z.custom`, not `.refine`: only `z.custom` keeps the narrowed type in `z.infer`. */
export const toolNameSchema = z.custom<ToolName>((value) => isToolName(value), "Invalid tool name");

export function hashToolInput(toolName: ToolName, input: unknown): string {
  return `fnv1a64:${fnv1a64(`${toolName}:${canonicalJson(input)}`)}`;
}

/**
 * Effect-ledger hash (#559a). Adds `target`, so the same args on another account are
 * a different effect. Separate from `hashToolInput`: changing that re-keys stored hashes.
 */
export function hashToolRequest(
  toolName: ToolName,
  input: unknown,
  target: string | undefined,
): string {
  const binding = target === undefined ? "" : `:${target}`;

  return `req:fnv1a64:${fnv1a64(`${toolName}${binding}:${canonicalJson(input)}`)}`;
}

/**
 * The parameter type when an `IntegrationSlug` reaches {@link humanizeSlug}. No value has
 * this type, so the call fails to compile. Read the name off the registry instead:
 * `INTEGRATION_DISPLAY_NAMES[slug]`, or {@link integrationDisplayName} for an unchecked string.
 */
interface IntegrationSlugUseIntegrationDisplayName {
  readonly "Use INTEGRATION_DISPLAY_NAMES[slug] or integrationDisplayName, not humanizeSlug": never;
}

/**
 * The parameter type when an open string type reaches {@link humanizeSlug}: plain `string`,
 * a union that holds `string`, or a template pattern such as `` `${string}_received` ``. No
 * value has this type, so the call fails to compile. An open string can hold `system`, and no
 * single answer is right for it: "System" for a field or code, "Alfred" for the integration.
 */
interface OpenStringNarrowToItsOwningUnionOrCallIntegrationDisplayName {
  readonly "Narrow the value to the literal union of its owning schema or tuple, or call integrationDisplayName if it can be a provider": never;
}

/**
 * `true` for each member of `S` that has no finite set of values. `Record<"a", 1>` requires
 * the key `a`, so `{}` is not assignable to it. `Record<string, 1>` and a template-pattern key
 * make an index signature, so `{}` is assignable.
 */
type OpenStringMember<S extends string> = S extends unknown
  ? {} extends Record<S, 1>
    ? true
    : false
  : never;

/**
 * The formatting of {@link humanizeSlug}, without its type gate. Module-private on purpose: the
 * open-string callers in this module ask the registry first ({@link integrationDisplayName}) or
 * format a position that cannot hold an integration ({@link humanizeToolName}).
 */
function titleCaseSlug(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

/**
 * `send_draft` to `Send Draft`, for a member of a closed literal union (a `z.enum`, a `const`
 * tuple element, a `.$type<>()` column). Two argument types fail to compile:
 *
 * - A type that is or includes an `IntegrationSlug`. Use `INTEGRATION_DISPLAY_NAMES[slug]`.
 * - An open string type (`string`, `string | "a"`, `` `${string}_x` ``). Narrow it to the
 *   literal union of its owning schema, or call {@link integrationDisplayName} if the value
 *   can be a provider.
 *
 * So no value that reaches this function can be a registry slug, and it needs no registry
 * casing (`github` to "GitHub").
 */
export function humanizeSlug<S extends string>(
  value: S &
    (true extends OpenStringMember<S>
      ? OpenStringNarrowToItsOwningUnionOrCallIntegrationDisplayName
      : [Extract<S, IntegrationSlug>] extends [never]
        ? unknown
        : IntegrationSlugUseIntegrationDisplayName),
): string {
  return titleCaseSlug(value);
}

/**
 * The display name of a value that may be an integration slug. An unknown value is title-cased
 * like {@link humanizeSlug}. This is the only open-string entry to that formatting: a value that
 * can name a provider must ask the registry first.
 */
export function integrationDisplayName(value: string): string {
  return isIntegrationSlug(value) ? INTEGRATION_DISPLAY_NAMES[value] : titleCaseSlug(value);
}

export interface ToolLabel {
  /** Shown while the call runs. */
  running: string;
  done: string;
  /** Lowercase imperative, so it reads after "Alfred wants to ...". */
  title: string;
}

/** Keyed by `ToolName`, so a new tool fails to compile without a label. */
export const TOOL_LABELS = {
  "system.search_tools": {
    running: "Searching for a tool",
    done: "Searched for a tool",
    title: "search for a tool",
  },
  "system.load_tool": {
    running: "Loading a tool",
    done: "Loaded a tool",
    title: "load a tool",
  },
  "system.current_time": {
    running: "Checking the current time",
    done: "Checked the current time",
    title: "check the current time",
  },
  "system.author_workflow": {
    running: "Saving a workflow draft",
    done: "Saved a workflow draft",
    title: "save a workflow draft",
  },
  "system.recover_workflow": {
    running: "Recovering a workflow draft",
    done: "Recovered a workflow draft",
    title: "recover a workflow draft",
  },
  "system.activate_workflow": {
    running: "Activating a workflow",
    done: "Activated a workflow",
    title: "activate a workflow",
  },
  "system.spawn_sub_agent": {
    running: "Delegating a sub-task",
    done: "Delegated a sub-task",
    title: "delegate a sub-task",
  },
  "system.await_sub_agent": {
    running: "Waiting on a sub-task",
    done: "Sub-task finished",
    title: "wait for a sub-task",
  },
  "system.read_user_context": {
    running: "Reading user context",
    done: "Read user context",
    title: "read user context",
  },
  "system.read_chat_history": {
    running: "Searching conversation history",
    done: "Searched conversation history",
    title: "search conversation history",
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
  "system.list_instructions": {
    running: "Reviewing your standing instructions",
    done: "Reviewed your standing instructions",
    title: "review standing instructions",
  },
  "system.forget_instruction": {
    running: "Removing a standing instruction",
    done: "Removed a standing instruction",
    title: "remove a standing instruction",
  },
  "system.edit_instruction": {
    running: "Updating a standing instruction",
    done: "Updated a standing instruction",
    title: "update a standing instruction",
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
  "system.fetch_url": {
    running: "Reading a web page",
    done: "Read a web page",
    title: "read a web page",
  },
  "system.corpus_search": {
    running: "Searching your documents",
    done: "Searched your documents",
    title: "search your ingested documents",
  },
  "system.search_context": {
    running: "Gathering context",
    done: "Gathered context",
    title: "search across your context",
  },
  "system.create_artifact": {
    running: "Creating an artifact",
    done: "Created an artifact",
    title: "create an artifact",
  },
  "system.append_artifact_page": {
    running: "Adding a page",
    done: "Added a page",
    title: "add an artifact page",
  },
  "system.append_artifact_section": {
    running: "Writing a section",
    done: "Wrote a section",
    title: "write a document section",
  },
  "system.update_artifact": {
    running: "Updating an artifact",
    done: "Updated an artifact",
    title: "update an artifact",
  },
  "system.ask_user": {
    running: "Waiting for your answer",
    // Also used for a dismissed or expired question, so it must not claim an answer.
    done: "Asked you a question",
    title: "ask you a question",
  },

  "mcp.call": {
    running: "Calling a connected tool",
    done: "Called a connected tool",
    title: "call a connected tool",
  },
  "mcp.list_tools": {
    running: "Listing connected tools",
    done: "Listed connected tools",
    title: "list connected tools",
  },
  "mcp.inspect_tool": {
    running: "Inspecting a connected tool",
    done: "Inspected a connected tool",
    title: "inspect a connected tool",
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
  "gmail.request": {
    running: "Querying the Gmail API",
    done: "Queried the Gmail API",
    title: "run a read-only Gmail API request",
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
  "calendar.request": {
    running: "Querying the Calendar API",
    done: "Queried the Calendar API",
    title: "run a read-only Calendar API request",
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
  "drive.request": {
    running: "Querying the Drive API",
    done: "Queried the Drive API",
    title: "run a read-only Drive API request",
  },

  "docs.get_document": {
    running: "Reading a Google Doc",
    done: "Read a Google Doc",
    title: "read a Google Doc",
  },
  "docs.request": {
    running: "Querying the Docs API",
    done: "Queried the Docs API",
    title: "run a read-only Docs API request",
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
  "sheets.request": {
    running: "Querying the Sheets API",
    done: "Queried the Sheets API",
    title: "run a read-only Sheets API request",
  },

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
  "slides.request": {
    running: "Querying the Slides API",
    done: "Queried the Slides API",
    title: "run a read-only Slides API request",
  },

  "github.search": {
    running: "Searching GitHub",
    done: "Searched GitHub",
    title: "search issues and pull requests",
  },
  "github.get_pull_request": {
    running: "Reading a pull request",
    done: "Read a pull request",
    title: "read a pull request",
  },
  "github.get_pull_requests": {
    running: "Reading pull requests",
    done: "Read pull requests",
    title: "read several pull requests",
  },
  "github.get_issue": {
    running: "Reading an issue",
    done: "Read an issue",
    title: "read an issue",
  },
  "github.request": {
    running: "Querying the GitHub API",
    done: "Queried the GitHub API",
    title: "run a read-only GitHub API request",
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
  "notion.request": {
    running: "Querying the Notion API",
    done: "Queried the Notion API",
    title: "run a read-only Notion API request",
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
  "vercel.request": {
    running: "Querying the Vercel API",
    done: "Queried the Vercel API",
    title: "run a read-only Vercel API request",
  },

  "sentry.request": {
    running: "Querying the Sentry API",
    done: "Queried the Sentry API",
    title: "run a read-only Sentry API request",
  },
} satisfies Record<ToolName, ToolLabel>;

/** `null` for an unregistered name. */
export function toolLabel(toolName: string): ToolLabel | null {
  return isToolName(toolName) ? TOOL_LABELS[toolName] : null;
}

/** For run summaries. `system` is plumbing and never leads the summary. */
export type ToolCategory = "source" | "action" | "system";

export const TOOL_CATEGORIES = {
  "system.search_tools": "system",
  "system.load_tool": "system",
  "system.current_time": "system",
  "system.author_workflow": "action",
  "system.recover_workflow": "action",
  "system.activate_workflow": "action",
  "system.spawn_sub_agent": "system",
  "system.await_sub_agent": "system",
  "system.read_user_context": "system",
  "system.read_chat_history": "source",
  "system.read_scratch": "system",
  "system.write_scratch": "system",
  "system.promote": "action",
  "system.remember": "action",
  "system.list_instructions": "source",
  "system.forget_instruction": "action",
  "system.edit_instruction": "action",
  "system.resolve_todo": "action",
  "system.suggest_todo": "action",
  "system.web_search": "source",
  "system.fetch_url": "source",
  "system.corpus_search": "source",
  "system.search_context": "source",
  "system.create_artifact": "action",
  "system.append_artifact_page": "action",
  "system.append_artifact_section": "action",
  "system.update_artifact": "action",
  "system.ask_user": "system",

  "mcp.call": "action",
  "mcp.list_tools": "system",
  "mcp.inspect_tool": "system",

  "gmail.search": "source",
  "gmail.read_message": "source",
  "gmail.send_draft": "action",
  "gmail.request": "source",

  "calendar.list_events": "source",
  "calendar.create_event": "action",
  "calendar.request": "source",

  "drive.search_files": "source",
  "drive.get_file": "source",
  "drive.export_file": "source",
  "drive.download_file": "source",
  "drive.request": "source",

  "docs.get_document": "source",
  "docs.request": "source",

  "sheets.create_spreadsheet": "action",
  "sheets.get_values": "source",
  "sheets.update_values": "action",
  "sheets.append_values": "action",
  "sheets.batch_update": "action",
  "sheets.add_sheet": "action",
  "sheets.request": "source",

  "slides.create_presentation": "action",
  "slides.get_presentation": "source",
  "slides.batch_update": "action",
  "slides.add_slide": "action",
  "slides.request": "source",

  "github.search": "source",
  "github.get_pull_request": "source",
  "github.get_pull_requests": "source",
  "github.get_issue": "source",
  "github.request": "source",

  "notion.search": "source",
  "notion.get_page": "source",
  "notion.create_page": "action",
  "notion.append_blocks": "action",
  "notion.request": "source",

  "vercel.list_projects": "source",
  "vercel.list_deployments": "source",
  "vercel.redeploy": "action",
  "vercel.request": "source",

  "sentry.request": "source",
} satisfies Record<ToolName, ToolCategory>;

/** `null` for an unregistered name. */
export function toolCategoryOf(toolName: string): ToolCategory | null {
  return isToolName(toolName) ? TOOL_CATEGORIES[toolName] : null;
}

/**
 * The label `title`, or `${action} in ${integration}` for an unregistered tool. A stored
 * tool name is an open string (`effectReceiptSchema` keeps a retired name parseable), so the
 * fallback formats it with the private `titleCaseSlug`. The position settles the ambiguity
 * that `humanizeSlug` refuses: the part before the dot goes through the registry, and the part
 * after it is an action, never an integration.
 */
export function humanizeToolName(toolName: string): string {
  if (isToolName(toolName)) return TOOL_LABELS[toolName].title;
  const separator = toolName.indexOf(".");
  const integration = separator > 0 ? toolName.slice(0, separator) : toolName;
  const action = separator > 0 ? toolName.slice(separator + 1) : "";

  return action
    ? `${titleCaseSlug(action)} in ${integrationDisplayName(integration)}`
    : integrationDisplayName(integration);
}

/** JSON with object keys sorted recursively, for stored hashes. Array order still counts. */
export function canonicalJson(value: unknown): string {
  return stringifyCanonical(value, new WeakSet<object>());
}

function stringifyCanonical(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return "null";

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- canonical JSON dispatches on the runtime type of an unknown value; the type name IS the serializer's branch key.
  const valueType = typeof value;

  if (valueType === "string") return JSON.stringify(value);

  if (valueType === "number") return Number.isFinite(value) ? String(value) : "null";

  if (valueType === "boolean") return value ? "true" : "false";

  if (valueType === "bigint") throw new TypeError("Cannot hash tool input containing bigint");

  if (valueType === "undefined" || valueType === "function" || valueType === "symbol") {
    return "null";
  }

  if (isIndexable(value)) {
    const toJSON: unknown = Reflect.get(value, "toJSON");

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- `JSON.stringify` calls `toJSON` only when it is a function; the canonical form must match that check.
    if (typeof toJSON === "function") {
      return stringifyCanonical(toJSON.call(value), seen);
    }
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Cannot hash circular tool input");
    seen.add(value);

    // An undefined, function, or symbol item renders as "null" through the scalar arms above.
    const items = value.map((item) => stringifyCanonical(item, seen));

    seen.delete(value);

    return `[${items.join(",")}]`;
  }

  if (isIndexable(value)) {
    const objectValue = value;

    if (seen.has(objectValue)) throw new TypeError("Cannot hash circular tool input");
    seen.add(objectValue);

    const entries = Object.keys(objectValue)
      .sort()
      .flatMap((key) => {
        const item: unknown = Reflect.get(objectValue, key);
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- `JSON.stringify` drops undefined, function and symbol members; the canonical form must drop the same members.
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
