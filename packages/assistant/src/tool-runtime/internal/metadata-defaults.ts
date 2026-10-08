/**
 * Derive search metadata from a tool's name, description, and schema, so every
 * tool is findable by capability without hand-written copy (#413).
 */

import { humanizeSlug } from "@alfred/contracts";
import { z } from "zod";
import type { ToolDiscoveryMetadata } from "./registry";

/** Free search text only. A plain string, so it does not widen the closed slug enums. */
type ProviderLabel = string;

/** Synonyms for the action's leading token. An unknown lead adds none. */
const VERB_SYNONYMS = {
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
} satisfies Record<string, readonly string[]>;

/** Field names with no capability signal, so "page" or "limit" never surfaces a tool. */
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
  integration: ProviderLabel;
  action: string;
  description: string;
  /** Read for its top-level field names. */
  inputSchema: z.ZodType<any>;
  /** Hand-written copy. Each field wins over the derived value. */
  overrides?: ToolDiscoveryMetadata | undefined;
}

/** Discovery after the merge. `title` and `summary` are always set. */
export type ResolvedDiscovery = Required<Pick<ToolDiscoveryMetadata, "title" | "summary">> &
  ToolDiscoveryMetadata;

/**
 * Merge derived metadata with overrides. Scalars take the override. Arrays are a
 * de-duplicated union, authored entries first. `relatedTools` is authored only.
 */
export function deriveToolDiscovery(input: DeriveToolDiscoveryInput): ResolvedDiscovery {
  const overrides = input.overrides ?? {};
  const tokens = actionTokens(input.action);
  const [lead, ...rest] = tokens;

  const derivedVerbs = lead
    ? [lead, ...(Object.entries(VERB_SYNONYMS).find(([verb]) => verb === lead)?.[1] ?? [])]
    : [];

  const derivedEntities = [...entitiesFromTokens(rest), ...schemaFieldEntities(input.inputSchema)];
  const humanizedAction = humanizeSlug(input.action).toLowerCase();
  const qualifiedAlias = `${input.integration} ${humanizedAction}`;
  // A bare one-word alias ("search") would preload every tool that shares the
  // word on a one-word prompt, so only multi-token actions keep the bare form.
  const derivedAliases = tokens.length > 1 ? [humanizedAction, qualifiedAlias] : [qualifiedAlias];

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

/**
 * Drop short connector tokens (`by`, `id`) and add singular forms. The caller
 * filters plumbing first: `page` is noise in `pageToken` but real in `create_page`.
 */
function entitiesFromTokens(tokens: readonly string[]): string[] {
  const out: string[] = [];

  for (const token of tokens) {
    if (token.length <= 2) continue;
    out.push(...entityForms(token));
  }

  return out;
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
 * Singularize each word, so "pull requests" matches "pull request" (#414).
 * Expects a normalized, single-spaced string.
 */
export function singularizePhrase(value: string): string {
  return value.split(" ").map(singularize).join(" ");
}

/** Nouns from the top-level fields. Runs at boot, so a failed conversion yields none. */
function schemaFieldEntities(schema: z.ZodType<any>): string[] {
  let json: z.core.JSONSchema.BaseSchema;

  try {
    json = z.toJSONSchema(schema, {
      io: "input",
      reused: "inline",
      unrepresentable: "any",
    });
  } catch {
    return [];
  }

  const properties = json.properties;

  if (!properties) return [];

  const fieldTokens = Object.keys(properties)
    .flatMap(splitFieldName)
    .filter((token) => !PLUMBING_FIELD_TOKENS.has(token));

  return entitiesFromTokens(fieldTokens);
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
