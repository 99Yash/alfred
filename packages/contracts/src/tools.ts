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
  "imessage",
] as const;
export type LoadableIntegrationSlug = (typeof LOADABLE_INTEGRATION_SLUGS)[number];

export const INTEGRATION_SLUGS = ["system", ...LOADABLE_INTEGRATION_SLUGS] as const;
export type IntegrationSlug = (typeof INTEGRATION_SLUGS)[number];

export const SYSTEM_ACTIONS = [
  "load_integration",
  "spawn_sub_agent",
  "read_scratch",
  "write_scratch",
  "promote",
] as const;

export const GMAIL_ACTIONS = ["search", "read_message", "send_draft"] as const;

export const CALENDAR_ACTIONS = ["list_events", "create_event"] as const;

export const DRIVE_ACTIONS = [] as const;
export const DOCS_ACTIONS = [] as const;

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
export const GITHUB_ACTIONS = [] as const;
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
