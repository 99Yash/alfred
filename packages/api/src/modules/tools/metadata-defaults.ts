/**
 * Baseline discovery metadata derivation (#413).
 *
 * Hand-authored `discovery` copy on `liveTool` calls is the curated ideal, but
 * it does not scale: every new integration tool — and, once they exist,
 * MCP/imported tools with only a server identity, a name, a description, and an
 * input schema — would otherwise be invisible to {@link searchToolCatalog}
 * except by its exact canonical name. This module derives a useful search
 * baseline from that identity so any registered tool participates in lazy
 * discovery, and merges local overrides on top so high-value tools can still be
 * tuned without re-listing everything the baseline already covers.
 *
 * The single derivation path is {@link deriveToolDiscovery}; `liveTool` calls it
 * for every builtin, and a future MCP importer should call it with the imported
 * server slug, tool name, description, and translated zod schema so external
 * providers get the same treatment for free.
 */

import { humanizeSlug, type IntegrationSlug } from "@alfred/contracts";
import { z } from "zod";
import type { ToolDiscoveryMetadata } from "./registry";

/**
 * Generic verb synonyms, keyed by the action's leading token. This is English
 * vocabulary, not a per-tool catalog: the baseline maps a user's likely phrasing
 * ("show my events", "open the page") onto the action's own verb so recall does
 * not depend on the author guessing every phrasing. Only the leading token is
 * expanded — unknown leads (`recent`, `batch`) simply contribute no synonyms.
 */
const VERB_SYNONYMS: Record<string, readonly string[]> = {
  search: ["find", "look up", "query"],
  list: ["show", "view", "browse"],
  get: ["read", "fetch", "open", "view"],
  read: ["view", "open", "fetch"],
  create: ["add", "new", "make", "start"],
  send: ["deliver", "share"],
  update: ["edit", "change", "modify", "set"],
  edit: ["update", "change", "modify"],
  append: ["add", "insert"],
  add: ["create", "insert"],
  delete: ["remove", "drop"],
  forget: ["remove", "delete"],
  export: ["download", "save"],
  download: ["export", "save"],
  fetch: ["get", "read", "load"],
  load: ["fetch", "open", "activate"],
  resolve: ["complete", "close", "finish"],
  redeploy: ["deploy", "restart", "rerun"],
  remember: ["save", "store", "note"],
  suggest: ["propose", "recommend"],
  promote: ["publish", "apply"],
  spawn: ["start", "launch", "delegate"],
};

/**
 * Input-schema property names that carry no capability signal — pagination,
 * opaque ids, and generic request plumbing. Excluded from derived entities so a
 * query like "page" or "limit" never surfaces an unrelated tool.
 */
const PLUMBING_FIELD_TOKENS = new Set([
  "id",
  "ids",
  "token",
  "cursor",
  "offset",
  "limit",
  "page",
  "pagetoken",
  "pagesize",
  "maxresults",
  "perpage",
  "q",
  "query",
  "format",
  "type",
  "mimetype",
  "order",
  "orderby",
  "input",
  "options",
  "option",
]);

export interface DeriveToolDiscoveryInput {
  /** Server/provider identity (the integration slug). */
  integration: IntegrationSlug;
  /** The tool's action slug, e.g. `create_event`. */
  action: string;
  /** The executable description; the derived `summary` default. */
  description: string;
  /** Input schema, read for its top-level field names. */
  inputSchema: z.ZodTypeAny;
  /** Hand-authored copy; each field takes precedence over the derived baseline. */
  overrides?: ToolDiscoveryMetadata;
}

type ResolvedDiscovery = Required<Pick<ToolDiscoveryMetadata, "title" | "summary">> &
  ToolDiscoveryMetadata;

/**
 * Merge a derived discovery baseline with hand-authored overrides. Scalars
 * (`title`, `summary`) take the override when present, else the derived default.
 * Arrays are a de-duplicated union — an author supplies a small delta that
 * *improves* the baseline rather than forking it — with authored phrasings kept
 * first so they read as canonical. `relatedTools` is authored-only: the baseline
 * cannot know which exact companion tool is useful next.
 */
export function deriveToolDiscovery(input: DeriveToolDiscoveryInput): ResolvedDiscovery {
  const overrides = input.overrides ?? {};
  const tokens = actionTokens(input.action);
  const [lead, ...rest] = tokens;

  const derivedVerbs = lead ? [lead, ...(VERB_SYNONYMS[lead] ?? [])] : [];
  const derivedEntities = [...rest.flatMap(entityForms), ...schemaFieldEntities(input.inputSchema)];
  const humanizedAction = humanizeSlug(input.action).toLowerCase();
  const derivedAliases = [humanizedAction, `${input.integration} ${humanizedAction}`];

  return {
    title: overrides.title ?? humanizeSlug(input.action),
    summary: overrides.summary ?? input.description,
    aliases: union(overrides.aliases, derivedAliases),
    tags: union(overrides.tags, [input.integration]),
    entities: union(overrides.entities, derivedEntities),
    verbs: union(overrides.verbs, derivedVerbs),
    ...(overrides.relatedTools ? { relatedTools: overrides.relatedTools } : {}),
  };
}

function actionTokens(action: string): string[] {
  return action
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/** A noun token plus its naive singular, so a query matches either number. */
function entityForms(token: string): string[] {
  const singular = singularize(token);
  return singular === token ? [token] : [token, singular];
}

function singularize(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (/(ss|sh|ch|x|z)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !/(ss|us|is|ous)$/.test(word)) return word.slice(0, -1);
  return word;
}

/**
 * Meaningful nouns from the schema's top-level fields. Read through zod's own
 * JSON-Schema conversion (the same options the dispatcher and approval form use)
 * so wrapped schemas — `z.preprocess`, coercion helpers — still report their
 * inner object; any conversion failure degrades to no fields rather than
 * throwing at registration.
 */
function schemaFieldEntities(schema: z.ZodTypeAny): string[] {
  let json: Record<string, unknown>;
  try {
    json = z.toJSONSchema(schema, {
      io: "input",
      reused: "inline",
      unrepresentable: "any",
    }) as Record<string, unknown>;
  } catch {
    return [];
  }
  const properties = json.properties;
  if (!properties || typeof properties !== "object") return [];

  const out: string[] = [];
  for (const key of Object.keys(properties)) {
    for (const token of splitFieldName(key)) {
      if (token.length <= 2 || PLUMBING_FIELD_TOKENS.has(token)) continue;
      out.push(...entityForms(token));
    }
  }
  return out;
}

/** `spreadsheetId` → `["spreadsheet", "id"]`; `page_token` → `["page", "token"]`. */
function splitFieldName(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/** Case-insensitive de-duplicated union; `primary` phrasings come first. */
function union(primary: readonly string[] | undefined, derived: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of [...(primary ?? []), ...derived]) {
    const trimmed = value.trim();
    const dedupeKey = trimmed.toLowerCase();
    if (trimmed.length === 0 || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(trimmed);
  }
  return out;
}
