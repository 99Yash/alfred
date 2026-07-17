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
import { TOOL_INPUT_SCHEMAS } from "./tool-schemas";
import type { ToolName } from "./tools";

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
  description?: string;
  /** Field is not in the schema's `required` set. */
  optional: boolean;
  /** Schema default, pre-filled when the proposed input omits the key. */
  default?: unknown;
}

export type FieldSpec =
  | (BaseFieldSpec & {
      kind: "select";
      options: FieldOption[];
      multiline?: false;
    })
  | (BaseFieldSpec & {
      kind: "number" | "integer";
      min?: number;
      max?: number;
      step?: number;
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
      kind: "textarea" | "string_array" | "json";
      /** Render full-width. */
      multiline: true;
    });

type JsonSchema = Record<string, unknown>;

/** Labels for keys whose humanized form reads poorly (abbreviations, ids). */
const LABEL_ALIASES: Record<string, string> = {
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
};

function humanizeKey(key: string): string {
  if (LABEL_ALIASES[key]) return LABEL_ALIASES[key];
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The JSON-Schema `type` may be a string or an array (e.g. `["string","null"]`). */
function primaryType(schema: JsonSchema): string | undefined {
  const t = schema.type;
  if (typeof t === "string") return t;
  if (Array.isArray(t)) return t.find((v) => v !== "null") as string | undefined;
  return undefined;
}

function fieldFromProperty(key: string, prop: JsonSchema, required: boolean): FieldSpec {
  const base: BaseFieldSpec = {
    key,
    label: humanizeKey(key),
    description: asString(prop.description),
    optional: !required,
    default: prop.default,
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
    const items = (prop.items as JsonSchema | undefined) ?? {};
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
function deref(schema: JsonSchema, root: JsonSchema): JsonSchema {
  const ref = asString(schema.$ref);
  if (!ref) return schema;
  const name = ref.replace(/^#\/(\$defs|definitions)\//, "");
  const defs = (root.$defs ?? root.definitions) as Record<string, JsonSchema> | undefined;
  return defs?.[name] ?? schema;
}

function deriveFields(schema: z.ZodType): FieldSpec[] | null {
  let json: JsonSchema;
  try {
    // `io: "input"` so defaulted fields read as optional; `reused: "inline"`
    // avoids `$ref` indirection for shared primitives; `unrepresentable: "any"`
    // keeps custom `.refine()` checks from throwing (the server still enforces
    // them on `.parse()` — they just don't shape the form).
    json = z.toJSONSchema(schema, {
      io: "input",
      reused: "inline",
      unrepresentable: "any",
    }) as JsonSchema;
  } catch {
    return null;
  }

  const root = json;
  const resolved = deref(json, root);
  const properties = resolved.properties as Record<string, JsonSchema> | undefined;
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
  const schema = (TOOL_INPUT_SCHEMAS as Partial<Record<ToolName, z.ZodType>>)[toolName];
  const fields = schema ? deriveFields(schema) : null;
  FIELD_CACHE.set(toolName, fields);
  return fields;
}
