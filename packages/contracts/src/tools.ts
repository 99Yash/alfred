import { z } from "zod";
import { enumGuard, isIndexable } from "./guards";
import {
  INTEGRATION_ACTIONS,
  INTEGRATION_DISPLAY_NAMES,
  INTEGRATION_SLUGS,
  isIntegrationSlug,
  type IntegrationSlug,
  type ToolReadClass,
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
  /**
   * How this run reads (ADR-0124). Absent: each read tool is a direct tool. `code_run`: a chat run
   * with the flag on, so a read runs only inside `system.code_run`. `code_run_host`: one read of a
   * `system.code_run` script, set only by its nested dispatch.
   */
  readPath?: ToolReadPath;
}

export type ToolReadPath = "code_run" | "code_run_host";

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

/** The one read tool of a `code_run` run (ADR-0124). */
export const CODE_RUN_TOOL = "system.code_run" satisfies ToolName;

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

/**
 * The declared output of a confirmed read (ADR-0124 amendment 2026-11-18). Only a `structured`
 * read can enter a script. `binary` is file content, for example base64 bytes, so it runs direct.
 */
export const TOOL_OUTPUT_KINDS = ["structured", "binary"] as const;

export type ToolOutputKind = (typeof TOOL_OUTPUT_KINDS)[number];

/** Why a call stays direct, also carried by a public route-change error (ADR-0124). */
export const directReadRouteReasonSchema = z.enum([
  "not_a_confirmed_read",
  "binary_output",
  "undeclared_output",
  "needs_approval",
]);

export type DirectRouteReason = z.infer<typeof directReadRouteReasonSchema>;

/** Trusted wording shared by route refusals and the public failure catalog. */
export const DIRECT_READ_ROUTE_REASON_TEXT = {
  not_a_confirmed_read:
    "Alfred cannot confirm that it only reads: no built-in read-only endpoint and no exact read policy covers it.",
  binary_output: "It returns binary file content, which a script cannot use.",
  undeclared_output: "No trusted declaration says that its output is structured.",
  needs_approval:
    "It waits for the user's approval now, and only a direct call shows the approval card.",
} satisfies Record<DirectRouteReason, string>;

/**
 * What a discovery hit quotes about one tool (ADR-0130 C1): where it runs now, if it shows an
 * approval card, and its read class. Discovery quotes it, and dispatch decides again for each call.
 * - `script`: a `system.code_run` script can call it, and `approval` is `none`.
 * - `direct`: a direct tool call. `directReason` says why. Only a run that reads through scripts
 *   (`code_run`, or a script's nested `code_run_host` read) has one.
 * - `class`: the class of a confirmed read (ADR-0130 decision 1). Absent for a tool that is not a
 *   confirmed read, and for a confirmed read that no code classifies.
 * One flat shape, not a union, so the script index that renders it stays short.
 */
export interface ToolRouteQuote {
  route: "script" | "direct";
  directReason?: DirectRouteReason;
  approval: "none" | "card";
  class?: ToolReadClass;
}

/**
 * One remote tool on one MCP server, at one exact descriptor (ADR-0130 amendment (c)). A server
 * names a call's tool with it, and a rule on one server tool binds to it. The stored reason and
 * the policy write parse it.
 */
export const mcpServerToolRefSchema = z.object({
  connectionId: z.string().min(1),
  remoteName: z.string().min(1),
  descriptorHash: z.string().min(1),
});

/** `z.infer` gives a type alias, so a `Fix` that holds it stays assignable to `JsonValue`. */
export type McpServerToolRef = z.infer<typeof mcpServerToolRefSchema>;

/**
 * The rule on one server tool ("Always allow this action" on an MCP server, ADR-0130 amendment
 * (c)). It applies only while the tool keeps `descriptorHash`, so a changed tool asks again.
 */
export interface ServerToolRule {
  mode: PolicyMode;
  descriptorHash: string;
}

/**
 * `mode` is absent when a rule only holds exceptions; the user default then applies.
 * - `toolOverrides`: the rule on one tool of the integration.
 * - `serverToolOverrides`: the rule on one server tool, keyed by connection id, then by remote
 *   tool name. A connection has one integration (a built-in's provider, else `mcp`).
 */
export interface IntegrationRule {
  mode?: PolicyMode;
  toolOverrides?: Partial<Record<ToolName, PolicyMode>>;
  serverToolOverrides?: Record<string, Record<string, ServerToolRule>>; // drift-ok: keyed by connection id and remote tool name, both open
}

export type IntegrationRules = Partial<Record<IntegrationSlug, IntegrationRule>>; // drift-ok: sparse per-user overrides; absence is the default mode

/** The per-integration mode for the policy editor. Ignores per-tool overrides (see `resolveToolModeDecision`). */
export function resolveIntegrationMode(
  rules: IntegrationRules,
  slug: IntegrationSlug,
  defaultMode: PolicyMode,
): PolicyMode {
  return rules[slug]?.mode ?? defaultMode;
}

/**
 * One tool's mode, and the setting that set it (ADR-0130 decision 4).
 * - `tool_override`: the tool's own "Always allow" override.
 * - `server_tool`: the rule on one server tool, at the call's descriptor.
 * - `integration`: the mode on the integration page.
 * - `default`: the global default, because the integration has no mode of its own.
 */
export interface ToolModeDecision {
  mode: PolicyMode;
  source: ApprovalModeSource;
}

/** The setting that supplied a tool's mode (`ToolModeDecision`). */
export type ApprovalModeSource = "tool_override" | "server_tool" | "integration" | "default";

/**
 * The rule on one server tool that applies to `serverTool` now: a rule at the same descriptor
 * hash. A rule at another hash applies to nothing, so the tool asks again (ADR-0130 amendment (c)).
 */
export function serverToolRuleOf(
  rules: IntegrationRules,
  integration: IntegrationSlug,
  serverTool: McpServerToolRef,
): ServerToolRule | undefined {
  const rule = storedServerToolRuleOf(rules, integration, serverTool);

  return rule?.descriptorHash === serverTool.descriptorHash ? rule : undefined;
}

/** The stored rule on one server tool at any descriptor hash, so a page can show an old one. */
export function storedServerToolRuleOf(
  rules: IntegrationRules,
  integration: IntegrationSlug,
  serverTool: Pick<McpServerToolRef, "connectionId" | "remoteName">,
): ServerToolRule | undefined {
  return rules[integration]?.serverToolOverrides?.[serverTool.connectionId]?.[
    serverTool.remoteName
  ];
}

/**
 * The mode of a call on one server tool: its rule at this descriptor, then the integration's
 * mode, then the user default. The rule beats the integration mode, as a tool override does.
 */
export function resolveServerToolModeDecision(
  rules: IntegrationRules,
  integration: IntegrationSlug,
  serverTool: McpServerToolRef,
  defaultMode: PolicyMode,
): ToolModeDecision {
  const rule = serverToolRuleOf(rules, integration, serverTool);

  if (rule !== undefined) return { mode: rule.mode, source: "server_tool" };

  return resolveIntegrationModeDecision(rules, integration, defaultMode);
}

/** The mode of one integration, and whether its own rule or the global default supplied it. */
export function resolveIntegrationModeDecision(
  rules: IntegrationRules,
  slug: IntegrationSlug,
  defaultMode: PolicyMode,
): ToolModeDecision {
  const mode = rules[slug]?.mode;

  return mode === undefined
    ? { mode: defaultMode, source: "default" }
    : { mode, source: "integration" };
}

/**
 * One tool's mode: its override, then its integration's mode, then the user default. The server's
 * `resolvePolicyDecision` adds the `system.*` floor and the rule of a built-in `mcp.call`.
 */
export function resolveToolModeDecision(
  rules: IntegrationRules,
  toolName: ToolName,
  defaultMode: PolicyMode,
): ToolModeDecision {
  const integration = integrationFromToolName(toolName);
  const override = rules[integration]?.toolOverrides?.[toolName];

  if (override !== undefined) return { mode: override, source: "tool_override" };

  return resolveIntegrationModeDecision(rules, integration, defaultMode);
}

/** The mode of `resolveToolModeDecision`, for a caller that does not name the setting. */
export function resolveToolMode(
  rules: IntegrationRules,
  toolName: ToolName,
  defaultMode: PolicyMode,
): PolicyMode {
  return resolveToolModeDecision(rules, toolName, defaultMode).mode;
}

/**
 * Set or clear (`null`) one tool's override. An override equal to the integration's mode is
 * dropped, so `toolOverrides` holds only real exceptions. The client and server mutators share it.
 */
export function withToolOverride(
  rules: IntegrationRules,
  toolName: ToolName,
  mode: PolicyMode | null,
  defaultMode: PolicyMode,
): IntegrationRules {
  const integration = integrationFromToolName(toolName);
  const rule = rules[integration];
  const overrides = { ...rule?.toolOverrides };

  if (mode === null || mode === resolveIntegrationMode(rules, integration, defaultMode)) {
    delete overrides[toolName];
  } else {
    overrides[toolName] = mode;
  }

  return withIntegrationRule(rules, integration, { ...rule, toolOverrides: overrides });
}

/**
 * Set or clear (`null`) the rule on one server tool. The rule binds to `serverTool.descriptorHash`.
 * A connection keeps one rule for each remote tool, so a new rule replaces one at an old hash.
 * A rule equal to the integration's mode is dropped, as `withToolOverride` drops an override.
 * The client and server mutators share it.
 */
export function withServerToolOverride(
  rules: IntegrationRules,
  integration: IntegrationSlug,
  serverTool: McpServerToolRef,
  mode: PolicyMode | null,
  defaultMode: PolicyMode,
): IntegrationRules {
  const rule = rules[integration];
  const { connectionId, remoteName, descriptorHash } = serverTool;
  const connectionRules = { ...rule?.serverToolOverrides?.[connectionId] };

  if (mode === null || mode === resolveIntegrationMode(rules, integration, defaultMode)) {
    delete connectionRules[remoteName];
  } else {
    connectionRules[remoteName] = { mode, descriptorHash };
  }

  const { [connectionId]: _previous, ...otherConnections } = rule?.serverToolOverrides ?? {};

  const serverToolOverrides =
    Object.keys(connectionRules).length > 0
      ? { ...otherConnections, [connectionId]: connectionRules }
      : otherConnections;

  return withIntegrationRule(rules, integration, { ...rule, serverToolOverrides });
}

/** Put `rule` on `integration` with its empty parts removed, or drop the integration's rule when it is empty. */
function withIntegrationRule(
  rules: IntegrationRules,
  integration: IntegrationSlug,
  rule: IntegrationRule,
): IntegrationRules {
  const toolOverrides = rule.toolOverrides ?? {};
  const serverToolOverrides = rule.serverToolOverrides ?? {};

  const next: IntegrationRule = {
    ...(rule.mode ? { mode: rule.mode } : {}),
    ...(Object.keys(toolOverrides).length > 0 ? { toolOverrides } : {}),
    ...(Object.keys(serverToolOverrides).length > 0 ? { serverToolOverrides } : {}),
  };

  const { [integration]: _previous, ...rest } = rules;

  return Object.keys(next).length > 0 ? { ...rest, [integration]: next } : rest;
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

/**
 * Names of removed tools that a saved row can still hold, for example a workflow revision that
 * lists `system.await_sub_agent` (ADR-0130 amendment (i)). Only a parse of a saved row accepts
 * them. New input stays strict.
 */
const RETIRED_TOOL_NAMES = ["system.await_sub_agent"] as const;

const retiredToolNameSchema = z.enum(RETIRED_TOOL_NAMES);

export type RetiredToolName = z.infer<typeof retiredToolNameSchema>;

export function isRetiredToolName(value: unknown): value is RetiredToolName {
  return retiredToolNameSchema.safeParse(value).success;
}

/** Marks a dropped entry inside a saved-list parse. It never leaves the parse. */
const RETIRED_ENTRY: symbol = Symbol("retired tool entry");

function retiredEntry(): symbol {
  return RETIRED_ENTRY;
}

function isKeptEntry<T>(entry: T): entry is Exclude<T, symbol> {
  return entry !== RETIRED_ENTRY;
}

/**
 * A saved list of tool names. Each entry must be a tool name or a retired name, and the list keeps
 * the max of its saved schema, so an object or a list over the max still fails. Then each retired
 * name drops.
 */
export function savedToolNameList(max: number) {
  return z
    .array(z.union([retiredToolNameSchema.transform(retiredEntry), toolNameSchema]))
    .max(max)
    .transform((names) => names.filter(isKeptEntry));
}

/**
 * A saved list of entries that name a tool in `tool`, for example the capabilities of a workflow.
 * Each entry must be an object with a retired name in `tool`, or match `entry`. The list keeps the
 * max of its saved schema. Then each entry with a retired name drops.
 */
export function savedToolEntryList<Entry extends z.ZodType<{ tool: string }>>(
  entry: Entry,
  max: number,
) {
  return z
    .array(z.union([z.looseObject({ tool: retiredToolNameSchema }).transform(retiredEntry), entry]))
    .max(max)
    .transform((entries) => entries.filter(isKeptEntry));
}

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
 * `append_values` to `Append Values`, for a member of a closed literal union (a `z.enum`, a `const`
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
  "system.load_result": {
    running: "Reading an earlier result",
    done: "Read an earlier result",
    title: "read an earlier result",
  },
  "system.code_run": {
    running: "Reading with a script",
    done: "Read with a script",
    title: "read with a script",
  },
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
  "system.list_todos": {
    running: "Reviewing your to-dos",
    done: "Reviewed your to-dos",
    title: "review to-dos",
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

  "sheets.append_values": {
    running: "Appending spreadsheet rows",
    done: "Appended spreadsheet rows",
    title: "append spreadsheet rows",
  },

  "contacts.search": {
    running: "Searching contacts",
    done: "Searched contacts",
    title: "search contacts",
  },
  "contacts.list": { running: "Listing contacts", done: "Listed contacts", title: "list contacts" },
  "contacts.get": { running: "Reading a contact", done: "Read a contact", title: "read a contact" },

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
} satisfies Record<ToolName, ToolLabel>;

/** `null` for an unregistered name. */
export function toolLabel(toolName: string): ToolLabel | null {
  return isToolName(toolName) ? TOOL_LABELS[toolName] : null;
}

/**
 * For run summaries, and the "writes" fact: an `action` call writes ({@link isActionTool}).
 * `system` is plumbing and never leads the summary.
 */
export type ToolCategory = "source" | "action" | "system";

export const TOOL_CATEGORIES = {
  "system.search_tools": "system",
  "system.load_tool": "system",
  "system.current_time": "system",
  "system.author_workflow": "action",
  "system.recover_workflow": "action",
  "system.activate_workflow": "action",
  "system.spawn_sub_agent": "system",
  "system.read_user_context": "system",
  "system.read_chat_history": "source",
  "system.read_scratch": "system",
  "system.load_result": "system",
  "system.write_scratch": "system",
  "system.promote": "action",
  "system.remember": "action",
  "system.list_instructions": "source",
  "system.forget_instruction": "action",
  "system.edit_instruction": "action",
  "system.list_todos": "source",
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
  "system.code_run": "source",

  "mcp.call": "action",
  "mcp.list_tools": "system",
  "mcp.inspect_tool": "system",

  "sheets.append_values": "action",

  "contacts.search": "source",
  "contacts.list": "source",
  "contacts.get": "source",

  "vercel.list_projects": "source",
  "vercel.list_deployments": "source",
  "vercel.redeploy": "action",
  "vercel.request": "source",
} satisfies Record<ToolName, ToolCategory>;

/** `null` for an unregistered name. */
export function toolCategoryOf(toolName: string): ToolCategory | null {
  return isToolName(toolName) ? TOOL_CATEGORIES[toolName] : null;
}

/**
 * Whether a call of this tool writes, so a failed result counts as a failed action.
 * An unregistered name counts as a write: guessing "read" would hide a failure.
 */
export function isActionTool(toolName: string): boolean {
  return (toolCategoryOf(toolName) ?? "action") === "action";
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

  // For a finite number, `JSON.stringify` and `String` produce the same text.
  if (valueType === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";

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
      .toSorted()
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
