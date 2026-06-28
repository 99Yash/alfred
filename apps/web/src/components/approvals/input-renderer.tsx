import { toolInputFields, type FieldSpec, type ToolName } from "@alfred/contracts";
import { CalendarDays, Check, Minus } from "lucide-react";
import type { ReactNode } from "react";
import { asRecord } from "~/lib/json-record";
import { formatDateTime, formatJson, stringArray, stringValue } from "./format";

/**
 * Read-only render of a staged tool's proposed input. Lays out one labelled
 * field per entry in the tool's schema-derived descriptor (`toolInputFields`),
 * rendered by kind — booleans as a yes/no chip, email lists as recipient
 * chips, datetimes humanized, opaque objects as a code block. The exact same
 * descriptor drives the editor, so the display and "Adjust" form always agree.
 * Tools without a derivable schema fall back to a raw-JSON block.
 */
export function InputRenderer({ toolName, input }: { toolName: ToolName; input: unknown }) {
  const fields = toolInputFields(toolName);
  const record = asRecord(input);

  if (!fields || !record) {
    return <CodeBlock>{formatJson(input)}</CodeBlock>;
  }

  // Show what's actually being sent: provided values, plus required/defaulted
  // fields. Untouched optionals stay hidden so the card reads cleanly.
  const visible = fields.filter(
    (field) => record[field.key] !== undefined || field.default !== undefined || !field.optional,
  );

  return (
    // max-h + overflow keeps a long proposed input (e.g. a full email body)
    // from blowing the card out — the panel scrolls instead of growing.
    <div className="grid max-h-72 gap-x-4 gap-y-3 overflow-y-auto overscroll-contain rounded-xl bg-app-bg-2/60 p-3 shadow-[0_0_0_1px_var(--app-bg-a2)] sm:grid-cols-2">
      {visible.map((field) => (
        <div key={field.key} className={field.multiline ? "sm:col-span-2" : undefined}>
          <p className="text-[11px] font-medium tracking-tight text-app-fg-2 uppercase">
            {field.label}
          </p>
          <div className="mt-1">
            <FieldValue field={field} value={record[field.key] ?? field.default} />
          </div>
        </div>
      ))}
    </div>
  );
}

function FieldValue({ field, value }: { field: FieldSpec; value: unknown }) {
  if (value === undefined || value === null || value === "") return <Empty />;

  switch (field.kind) {
    case "boolean":
      return <BoolChip on={value === true} />;

    case "string_array": {
      const items = stringArray(value);
      if (items.length === 0) return <Empty />;
      return (
        <div className="flex flex-wrap gap-1.5">
          {items.map((item, i) => (
            <Chip key={`${item}-${i}`}>{item}</Chip>
          ))}
        </div>
      );
    }

    case "select": {
      const match = field.options?.find((o) => o.value === value);
      return <Chip>{match?.label ?? stringValue(value)}</Chip>;
    }

    case "json":
      return <CodeBlock>{formatJson(value)}</CodeBlock>;

    case "number":
    case "integer":
      return (
        <span className="text-xs leading-5 text-app-fg-4 tabular-nums">
          {typeof value === "number" ? String(value) : stringValue(value)}
        </span>
      );

    case "datetime":
      return (
        <span className="inline-flex items-center gap-1.5 text-xs leading-5 text-app-fg-4">
          <CalendarDays size={13} className="shrink-0 text-app-fg-2" />
          {formatDateTime(stringValue(value))}
        </span>
      );

    case "email":
      return <Chip mono>{stringValue(value)}</Chip>;

    case "text":
    case "textarea": {
      const text = stringValue(value);
      if (text === "") return <Empty />;
      return (
        <p
          className={
            field.multiline
              ? // No inner max-h — the panel container owns scrolling, so the
                // body never produces a scrollbar-within-a-scrollbar.
                "text-xs leading-5 break-words whitespace-pre-wrap text-app-fg-4"
              : "text-xs leading-5 break-words text-app-fg-4"
          }
        >
          {text}
        </p>
      );
    }

    default:
      return assertNever(field);
  }
}

function Chip({ children, mono }: { children: ReactNode; mono?: boolean }) {
  return (
    <span
      className={
        mono
          ? "inline-flex max-w-full items-center truncate rounded-md bg-app-bg-1 px-2 py-0.5 font-mono text-[11px] text-app-fg-4 shadow-[0_0_0_1px_var(--app-fg-a1)]"
          : "inline-flex max-w-full items-center truncate rounded-md bg-app-bg-1 px-2 py-0.5 text-[12px] text-app-fg-4 shadow-[0_0_0_1px_var(--app-fg-a1)]"
      }
    >
      {children}
    </span>
  );
}

function BoolChip({ on }: { on: boolean }) {
  return (
    <span
      className={
        on
          ? "inline-flex items-center gap-1 rounded-md bg-app-green-1 px-2 py-0.5 text-[12px] font-medium text-app-green-4"
          : "inline-flex items-center gap-1 rounded-md bg-app-bg-3 px-2 py-0.5 text-[12px] font-medium text-app-fg-3"
      }
    >
      {on ? <Check size={12} /> : <Minus size={12} />}
      {on ? "Yes" : "No"}
    </span>
  );
}

function CodeBlock({ children }: { children: ReactNode }) {
  return (
    <pre className="max-h-72 overflow-auto rounded-xl bg-app-bg-1 p-3 font-mono text-[12px] leading-5 text-app-fg-4 shadow-[0_0_0_1px_var(--app-fg-a1)]">
      {children}
    </pre>
  );
}

function Empty() {
  return <span className="text-xs leading-5 text-app-fg-2">—</span>;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled field kind: ${JSON.stringify(value)}`);
}
