import { toolInputFields, type FieldSpec, type ToolName } from "@alfred/contracts";
import { asRecord } from "~/lib/json-record";
import { formatDateTime, formatJson, stringArray, stringValue } from "./format";

/**
 * Read-only render of a staged tool's proposed input. Lays out one labelled
 * field per entry in the tool's schema-derived descriptor (`toolInputFields`),
 * formatted by kind — datetimes humanized, email lists joined, opaque
 * objects shown as JSON. The exact same descriptor drives the editor, so the
 * display and "Adjust" form always agree. Tools without a derivable schema
 * fall back to a raw-JSON block.
 */
export function InputRenderer({ toolName, input }: { toolName: ToolName; input: unknown }) {
  const fields = toolInputFields(toolName);
  const record = asRecord(input);

  if (!fields || !record) {
    return (
      <pre className="max-h-72 overflow-auto rounded-xl bg-app-bg-2/60 p-3 font-mono text-[12px] leading-5 text-app-fg-4 shadow-[0_0_0_1px_rgba(0,0,0,0.05)]">
        {formatJson(input)}
      </pre>
    );
  }

  // Show what's actually being sent: provided values, plus required/defaulted
  // fields. Untouched optionals stay hidden so the card reads cleanly.
  const visible = fields.filter(
    (field) => record[field.key] !== undefined || field.default !== undefined || !field.optional,
  );

  return (
    <div className="grid gap-2 rounded-xl bg-app-bg-2/60 p-3 shadow-[0_0_0_1px_rgba(0,0,0,0.05)] sm:grid-cols-2">
      {visible.map((field) => {
        const display = formatField(field, record[field.key] ?? field.default);
        return (
          <div key={field.key} className={field.multiline ? "sm:col-span-2" : undefined}>
            <p className="text-[11px] font-medium uppercase tracking-tight text-app-fg-2">
              {field.label}
            </p>
            <p
              className={
                field.multiline
                  ? "mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs leading-5 text-app-fg-4"
                  : "mt-1 break-words text-xs leading-5 text-app-fg-4"
              }
            >
              {display || "—"}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function formatField(field: FieldSpec, value: unknown): string {
  if (value === undefined || value === null) return "";
  switch (field.kind) {
    case "datetime":
      return formatDateTime(stringValue(value));
    case "string_array":
      return stringArray(value).join(", ");
    case "boolean":
      return value === true ? "Yes" : "No";
    case "select": {
      const match = field.options?.find((o) => o.value === value);
      return match?.label ?? stringValue(value);
    }
    case "json":
      return formatJson(value);
    case "number":
    case "integer":
      return typeof value === "number" ? String(value) : stringValue(value);
    case "text":
    case "email":
    case "textarea":
      return stringValue(value);
    default:
      return assertNever(field);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled field kind: ${JSON.stringify(value)}`);
}
