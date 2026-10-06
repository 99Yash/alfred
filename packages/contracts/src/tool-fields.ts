/**
 * Schema-derived form descriptors for tool inputs.
 *
 * The web approval surface needs to render a typed control per field — a
 * dropdown for an enum, a stepper for a bounded integer, a datetime picker,
 * etc. Rather than hand-mirror each tool's shape in the web layer (which
 * drifts from the server), we derive that descriptor from the SAME zod schema
 * the dispatcher validates with, via zod 4's native JSON-Schema conversion.
 *
 * The result is a flat `FieldSpec[]` in declaration order. Anything we can't
 * express as a first-class control (nested objects, freeform records, unknown)
 * degrades to a `json` field, so every tool renders something sane and the
 * raw-JSON fallback only appears for genuinely opaque inputs.
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
  /** Object key in the tool input. */
  key: string;
  /** Human label for the control. */
  label: string;
  /** The schema's `.describe()` text, shown as helper/title text. */
  description?: string | undefined;
  /** Field is not in the schema's `required` set. */
  optional: boolean;
  /** Schema default, pre-filled when the proposed input omits the key. */
  default?: JsonValue | undefined;
  /** Display context that is derived server-side and cannot be edited safely. */
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

/**
 * Every value a field control can read: the per-kind overloads of
 * {@link fieldValue} narrow this to one arm each, and the implementation
 * signature returns the whole union.
 */
export type FieldValue = string | number | boolean | JsonValue | undefined;

/**
 * Read one field's value off an unvalidated input record, coerced to the
 * control's own shape — a text control reads a string, a stepper a finite
 * number, a multi-line list a string array.
 *
 * The overloads carry the per-kind value type, so a caller that has already
 * narrowed on `field.kind` gets the narrowed value with no `typeof` of its
 * own: `fieldValue` is the one place that branches on the runtime
 * representation. A wrong-shaped leaf reads as unset (`undefined`, or `[]`
 * for a list) rather than leaking `[object Object]` into a visible input.
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

/** The JSON-Schema `type` may be a string or an array (e.g. `["string","null"]`). */
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
    // SAFETY: a JSON Schema `items` keyword, when present, is itself a schema
    // object; JsonObject is that shape.
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

  // Objects, freeform records, unions, unknown → edit as JSON.
  return { ...base, kind: "json", multiline: true };
}

/** Resolve a one-level `$ref` against the schema's `$defs`/`definitions`. */
function deref(schema: JsonObject, root: JsonObject): JsonObject {
  const ref = asString(schema.$ref);

  if (!ref) return schema;
  const name = ref.replace(/^#\/(\$defs|definitions)\//, "");
  // SAFETY: `$defs` / `definitions` hold named schema nodes per the JSON
  // Schema spec; the loose record view types that map.
  const defs = (root.$defs ?? root.definitions) as Record<string, JsonObject> | undefined;

  return defs?.[name] ?? schema;
}

function deriveFields(schema: z.ZodType): FieldSpec[] | null {
  let json: JsonObject;

  try {
    // `io: "input"` so defaulted fields read as optional; `reused: "inline"`
    // avoids `$ref` indirection for shared primitives; `unrepresentable: "any"`
    // keeps custom `.refine()` checks from throwing (the server still enforces
    // them on `.parse()` — they just don't shape the form).
    // SAFETY: z.toJSONSchema emits a JSON Schema document, which is exactly
    // the loose record shape JsonObject models.
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
  // SAFETY: a JSON Schema `properties` keyword maps property names to schema
  // nodes; the loose record view types that map.
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

/**
 * The form descriptor for a tool's input, or `null` when there's no schema
 * (e.g. `system.spawn_sub_agent`) or it can't be expressed as fields — callers
 * fall back to a raw-JSON view. Memoized per tool.
 */
export function toolInputFields(toolName: ToolName): FieldSpec[] | null {
  if (FIELD_CACHE.has(toolName)) return FIELD_CACHE.get(toolName) ?? null;
  // SAFETY: TOOL_INPUT_SCHEMAS is keyed by ToolName (its key type is checked
  // against the union) with one intentionally absent entry, so Partial is the
  // honest lookup type; the cast only homogenizes the per-tool schema values
  // to their common base for this read.
  const schema = (TOOL_INPUT_SCHEMAS as Partial<Record<ToolName, z.ZodType>>)[toolName];
  const fields = schema ? deriveFields(schema) : null;
  FIELD_CACHE.set(toolName, fields);

  return fields;
}
