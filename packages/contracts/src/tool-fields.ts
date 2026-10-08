/**
 * Form fields for the web approval view, derived from the same zod schema the
 * dispatcher validates with. Anything without a control becomes a `json` field.
 */

import { z } from "zod";
import { toStringArray } from "./guards";
import { TOOL_INPUT_SCHEMAS } from "./tool-schemas";
import type { ToolName } from "./tools";
import type { JsonObject, JsonValue } from "./user-model";

export type FieldKind =
  | "text"
  | "textarea"
  | "number"
  | "integer"
  | "boolean"
  | "select"
  | "datetime"
  | "email"
  | "string_array"
  | "json";

export interface FieldOption {
  value: string;
  label: string;
}

interface BaseFieldSpec {
  key: string;
  label: string;
  /** The schema's `.describe()` text. */
  description?: string | undefined;
  optional: boolean;
  /** Pre-filled when the proposed input omits the key. */
  default?: JsonValue | undefined;
  /** Derived on the server; editing it is not safe. */
  readOnly?: boolean | undefined;
}

export type FieldSpec =
  | (BaseFieldSpec & {
      kind: "select";
      options: FieldOption[];
      multiline?: false;
    })
  | (BaseFieldSpec & {
      kind: "number" | "integer";
      min?: number | undefined;
      max?: number | undefined;
      step?: number | undefined;
      multiline?: false;
    })
  | (BaseFieldSpec & {
      kind: "boolean";
      multiline?: false;
    })
  | (BaseFieldSpec & {
      kind: "text" | "email" | "datetime";
      multiline?: false;
    })
  | (BaseFieldSpec & {
      kind: "textarea";
      /** Render full-width. */
      multiline: true;
    })
  | (BaseFieldSpec & {
      kind: "string_array";
      /** Render full-width. */
      multiline: true;
    })
  | (BaseFieldSpec & {
      kind: "json";
      /** Render full-width. */
      multiline: true;
    });

export type FieldValue = string | number | boolean | JsonValue | undefined;

/**
 * Read one field off an unvalidated input, typed by `field.kind`.
 * A wrong-shaped value reads as unset, not `[object Object]`.
 */
export function fieldValue(
  field: Extract<FieldSpec, { kind: "select" | "text" | "email" | "datetime" | "textarea" }>,
  record: JsonObject,
): string | undefined;
export function fieldValue(
  field: Extract<FieldSpec, { kind: "number" | "integer" }>,
  record: JsonObject,
): number | undefined;
export function fieldValue(
  field: Extract<FieldSpec, { kind: "string_array" }>,
  record: JsonObject,
): string[];
export function fieldValue(
  field: Extract<FieldSpec, { kind: "boolean" }>,
  record: JsonObject,
): boolean | undefined;
export function fieldValue(
  field: Extract<FieldSpec, { kind: "json" }>,
  record: JsonObject,
): JsonValue | undefined;
export function fieldValue(field: FieldSpec, record: JsonObject): FieldValue {
  const raw: JsonValue | undefined = record[field.key] ?? field.default;

  switch (field.kind) {
    case "select":
    case "text":
    case "email":
    case "datetime":
    case "textarea":
      return typeof raw === "string" ? raw : undefined;
    case "number":
    case "integer":
      return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
    case "string_array":
      return toStringArray(raw);
    case "boolean":
      return typeof raw === "boolean" ? raw : undefined;
    case "json":
      return raw;
  }
}

/** Labels for keys whose humanized form reads poorly (abbreviations, ids). */
const LABEL_ALIASES = {
  q: "Query",
  cc: "Cc",
  bcc: "Bcc",
  perPage: "Results",
  maxResults: "Max results",
  pageSize: "Page size",
  pageToken: "Page token",
  orderBy: "Sort order",
  bodyText: "Body",
  threadId: "Thread",
  calendarId: "Calendar",
  documentId: "Document",
  messageId: "Message",
  spreadsheetId: "Spreadsheet",
  presentationId: "Presentation",
  fileId: "File",
  mimeType: "Export type",
  timeZone: "Timezone",
  timeMin: "Starts after",
  timeMax: "Ends before",
  valueInputOption: "Value handling",
} satisfies Record<string, string>;

function humanizeKey(key: string): string {
  const alias = Object.entries(LABEL_ALIASES).find(([k]) => k === key)?.[1];

  if (alias) return alias;

  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function asNumber(value: JsonObject[keyof JsonObject] | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: JsonObject[keyof JsonObject] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** `type` can be an array, such as `["string","null"]`. */
function primaryType(schema: JsonObject): string | undefined {
  const t = schema.type;

  if (typeof t === "string") return t;

  if (Array.isArray(t)) {
    return t.find((v): v is string => typeof v === "string" && v !== "null");
  }

  return undefined;
}

function fieldFromProperty(key: string, prop: JsonObject, required: boolean): FieldSpec {
  const base: BaseFieldSpec = {
    key,
    label: humanizeKey(key),
    description: asString(prop.description),
    optional: !required,
    default: prop.default,
    readOnly: prop.readOnly === true,
  };

  const enumValues = Array.isArray(prop.enum) ? prop.enum : undefined;
  const type = primaryType(prop);

  if (enumValues && type !== "array") {
    return {
      ...base,
      kind: "select",
      options: enumValues
        .filter((v): v is string => typeof v === "string")
        .map((value) => ({ value, label: humanizeKey(value) })),
    };
  }

  if (type === "boolean") return { ...base, kind: "boolean" };

  if (type === "integer" || type === "number") {
    return {
      ...base,
      kind: type === "integer" ? "integer" : "number",
      min: asNumber(prop.minimum),
      max: asNumber(prop.maximum),
      step: type === "integer" ? 1 : undefined,
    };
  }

  if (type === "array") {
    // SAFETY: JSON Schema `items` is a schema object.
    const items = (prop.items as JsonObject | undefined) ?? {};
    const itemType = primaryType(items);

    if (itemType === "string") {
      return { ...base, kind: "string_array", multiline: true };
    }

    return { ...base, kind: "json", multiline: true };
  }

  if (type === "string") {
    if (prop.format === "date-time") return { ...base, kind: "datetime" };

    if (prop.format === "email") return { ...base, kind: "email" };
    const maxLength = asNumber(prop.maxLength) ?? 0;

    if (maxLength >= 2_000) return { ...base, kind: "textarea", multiline: true };

    return { ...base, kind: "text" };
  }

  return { ...base, kind: "json", multiline: true };
}

/** Resolve one level of `$ref`. */
function deref(schema: JsonObject, root: JsonObject): JsonObject {
  const ref = asString(schema.$ref);

  if (!ref) return schema;
  const name = ref.replace(/^#\/(\$defs|definitions)\//, "");
  // SAFETY: `$defs` / `definitions` map names to schema nodes.
  const defs = (root.$defs ?? root.definitions) as Record<string, JsonObject> | undefined;

  return defs?.[name] ?? schema;
}

function deriveFields(schema: z.ZodType): FieldSpec[] | null {
  let json: JsonObject;

  try {
    // `io: "input"` makes defaulted fields optional. `unrepresentable: "any"` stops
    // `.refine()` from throwing; the server still enforces it.
    // SAFETY: z.toJSONSchema emits a JSON Schema object.
    json = z.toJSONSchema(schema, {
      io: "input",
      reused: "inline",
      unrepresentable: "any",
    }) as JsonObject;
  } catch {
    return null;
  }

  const root = json;
  const resolved = deref(json, root);
  // SAFETY: JSON Schema `properties` maps names to schema nodes.
  const properties = resolved.properties as Record<string, JsonObject> | undefined;

  if (!properties) return null;

  const required = new Set(
    Array.isArray(resolved.required)
      ? resolved.required.filter((v): v is string => typeof v === "string")
      : [],
  );

  return Object.entries(properties).map(([key, prop]) =>
    fieldFromProperty(key, deref(prop, root), required.has(key)),
  );
}

const FIELD_CACHE = new Map<ToolName, FieldSpec[] | null>();

/** `null` when the tool has no schema or no fields. Callers then show raw JSON. Memoized. */
export function toolInputFields(toolName: ToolName): FieldSpec[] | null {
  if (FIELD_CACHE.has(toolName)) return FIELD_CACHE.get(toolName) ?? null;
  // SAFETY: keyed by ToolName with one entry absent on purpose; the cast only widens the values.
  const schema = (TOOL_INPUT_SCHEMAS as Partial<Record<ToolName, z.ZodType>>)[toolName];
  const fields = schema ? deriveFields(schema) : null;
  FIELD_CACHE.set(toolName, fields);

  return fields;
}
