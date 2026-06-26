import {
  calendarListEventsInput,
  toolInputFields,
  type FieldSpec,
  type ToolName,
} from "@alfred/contracts";
import { useRef, useState } from "react";
import type { z } from "zod";
import { AppDateTimePicker, AppInput, AppSelect, AppSwitch, AppTextarea } from "~/components/ui/v2";
import { asRecord, type JsonRecord } from "~/lib/json-record";
import { formatJson, parseJson } from "./format";

type FieldControlSpec = Exclude<FieldSpec, { kind: "boolean" }>;
type CalendarListEventsKey = keyof z.infer<typeof calendarListEventsInput>;

/**
 * Editable view of a staged tool's proposed input. Every control is derived
 * from the tool's zod `inputSchema` (via `toolInputFields`) — an enum renders
 * a dropdown, a bounded integer a stepper, a datetime a picker, an email list
 * a multi-line editor — so the form can't drift from what the server accepts.
 * Tools without a derivable schema fall back to a raw-JSON editor.
 */
export function ApprovalInputEditor({
  toolName,
  value,
  onChange,
  disabled,
  idPrefix,
}: {
  toolName: ToolName;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
  idPrefix: string;
}) {
  const record = asRecord(value);
  const fieldSpecs = toolInputFields(toolName);

  if (!record || !fieldSpecs) {
    return <JsonFallbackEditor value={value} onChange={onChange} disabled={disabled} />;
  }

  const fields = editorFieldsForTool(toolName, fieldSpecs, record);

  return (
    <div className="grid gap-3 rounded-xl bg-app-bg-2/60 p-3 shadow-[0_0_0_1px_var(--app-bg-a2)] sm:grid-cols-2">
      {fields.map((field) => (
        <EditableField
          key={field.key}
          id={`${idPrefix}-${field.key}`}
          field={field}
          value={record[field.key] ?? field.default}
          disabled={disabled}
          onChange={(next) => {
            const updated = { ...record };
            if (next === undefined) delete updated[field.key];
            else updated[field.key] = next;
            onChange(updated);
          }}
        />
      ))}
    </div>
  );
}

// z.toJSONSchema cannot preserve calendarListEventsInput's explicit-vs-relative
// refine, so this UI visibility rule intentionally mirrors the schema and
// resolver guards. Type it against the inferred output (z.infer, not z.input —
// the schema's preprocess makes z.input `unknown`, which wouldn't constrain
// the keys) so key renames fail at compile time instead of silently showing
// the wrong field set.
const CALENDAR_EXPLICIT_TIME_KEYS: ReadonlySet<CalendarListEventsKey> = new Set([
  "timeMin",
  "timeMax",
]);
const CALENDAR_RELATIVE_TIME_KEYS: ReadonlySet<CalendarListEventsKey> = new Set([
  "window",
  "partOfDay",
]);

function editorFieldsForTool(
  toolName: ToolName,
  fields: FieldSpec[],
  record: JsonRecord,
): FieldSpec[] {
  if (toolName !== "calendar.list_events") return fields;

  const hasExplicitWindow = [...CALENDAR_EXPLICIT_TIME_KEYS].some((key) =>
    hasFieldValue(record, key),
  );
  if (hasExplicitWindow) {
    return fields.filter((field) => !hasCalendarListKey(CALENDAR_RELATIVE_TIME_KEYS, field.key));
  }

  return fields.filter((field) => !hasCalendarListKey(CALENDAR_EXPLICIT_TIME_KEYS, field.key));
}

function hasCalendarListKey(keys: ReadonlySet<CalendarListEventsKey>, key: string): boolean {
  return (keys as ReadonlySet<string>).has(key);
}

function hasFieldValue(record: JsonRecord, key: CalendarListEventsKey): boolean {
  const value = record[key];
  return value !== undefined && value !== null && value !== "";
}

function EditableField({
  id,
  field,
  value,
  disabled,
  onChange,
}: {
  id: string;
  field: FieldSpec;
  value: unknown;
  disabled: boolean | undefined;
  onChange: (value: unknown) => void;
}) {
  if (field.kind === "boolean") {
    return (
      <div className="flex min-h-16 items-center justify-between gap-3 rounded-lg bg-app-bg-1/70 px-3 py-2 shadow-[0_0_0_1px_var(--app-fg-a1)]">
        <label htmlFor={id} className="min-w-0 text-[12px] font-medium text-app-fg-3">
          {field.label}
        </label>
        <AppSwitch
          id={id}
          checked={value === true}
          disabled={disabled}
          onCheckedChange={(checked) => onChange(checked)}
        />
      </div>
    );
  }

  return (
    <div className={field.multiline ? "sm:col-span-2" : undefined}>
      <label
        htmlFor={id}
        title={field.description}
        className="text-[11px] font-medium uppercase tracking-tight text-app-fg-2"
      >
        {field.label}
      </label>
      <div className="mt-1.5">
        <FieldControl id={id} field={field} value={value} disabled={disabled} onChange={onChange} />
      </div>
    </div>
  );
}

function FieldControl({
  id,
  field,
  value,
  disabled,
  onChange,
}: {
  id: string;
  field: FieldControlSpec;
  value: unknown;
  disabled: boolean | undefined;
  onChange: (value: unknown) => void;
}) {
  switch (field.kind) {
    case "select":
      return (
        <AppSelect
          id={id}
          label={field.label}
          value={typeof value === "string" ? value : undefined}
          onChange={onChange}
          options={field.options}
          clearable={field.optional}
          placeholder={field.optional ? "Any" : "Select…"}
          disabled={disabled}
        />
      );
    case "number":
    case "integer":
      return (
        <AppInput
          id={id}
          type="number"
          inputMode={field.kind === "integer" ? "numeric" : "decimal"}
          min={field.min}
          max={field.max}
          step={field.step ?? (field.kind === "integer" ? 1 : undefined)}
          value={typeof value === "number" && Number.isFinite(value) ? String(value) : ""}
          disabled={disabled}
          onChange={(e) => {
            const next = e.target.value.trim();
            onChange(next === "" ? undefined : Number(next));
          }}
          className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
      );
    case "datetime":
      return (
        <AppDateTimePicker
          id={id}
          value={typeof value === "string" ? value : undefined}
          onChange={onChange}
          disabled={disabled}
        />
      );
    case "string_array":
      return (
        <AppTextarea
          id={id}
          value={Array.isArray(value) ? value.filter((v) => typeof v === "string").join("\n") : ""}
          rows={3}
          disabled={disabled}
          placeholder="One per line"
          onChange={(e) => {
            const items = e.target.value.split("\n").flatMap((item) => {
              const trimmed = item.trim();
              return trimmed ? [trimmed] : [];
            });
            onChange(items.length > 0 ? items : undefined);
          }}
          className="min-h-24"
        />
      );
    case "json":
      return <JsonField id={id} value={value} disabled={disabled} onChange={onChange} />;
    case "textarea":
      return (
        <AppTextarea
          id={id}
          value={typeof value === "string" ? value : ""}
          rows={3}
          disabled={disabled}
          onChange={(e) => onChange(emptyToUndefined(e.target.value, field.optional))}
          className="min-h-24"
        />
      );
    case "email":
    case "text":
      return (
        <AppInput
          id={id}
          type={field.kind === "email" ? "email" : "text"}
          value={typeof value === "string" ? value : value === undefined ? "" : String(value)}
          disabled={disabled}
          onChange={(e) => onChange(emptyToUndefined(e.target.value, field.optional))}
        />
      );
    default:
      return assertNever(field);
  }
}

/** A single object/array field edited as JSON text, committed only when valid. */
function JsonField({
  id,
  value,
  disabled,
  onChange,
}: {
  id: string;
  value: unknown;
  disabled: boolean | undefined;
  onChange: (value: unknown) => void;
}) {
  const [text, setText] = useState(() => formatJson(value));
  const [error, setError] = useState<string | null>(null);
  const previousValueRef = useRef(value);
  if (value !== previousValueRef.current) {
    previousValueRef.current = value;
    setText(formatJson(value));
    setError(null);
  }

  return (
    <div>
      <AppTextarea
        id={id}
        value={text}
        rows={4}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          const parsed = parseJson(e.target.value);
          if (parsed.ok) {
            setError(null);
            onChange(parsed.value);
          } else {
            setError(parsed.message);
          }
        }}
        className="min-h-24 font-mono text-[12px]"
      />
      {error ? <p className="mt-1 text-[11px] text-app-red-4">{error}</p> : null}
    </div>
  );
}

/** Whole-input fallback when the tool has no derivable field schema. */
function JsonFallbackEditor({
  value,
  onChange,
  disabled,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
  disabled: boolean | undefined;
}) {
  const [text, setText] = useState(() => formatJson(value));
  const [error, setError] = useState<string | null>(null);
  const previousValueRef = useRef(value);
  // Re-seed when the staged value changes underneath us (e.g. navigating
  // between approvals reuses this component).
  if (value !== previousValueRef.current) {
    previousValueRef.current = value;
    setText(formatJson(value));
    setError(null);
  }

  return (
    <div className="rounded-xl bg-app-bg-2/60 p-3 shadow-[0_0_0_1px_var(--app-bg-a2)]">
      <p className="text-[12px] leading-5 text-app-fg-3">
        This tool has no structured form yet. Edit the raw input below.
      </p>
      <AppTextarea
        value={text}
        rows={8}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          const parsed = parseJson(e.target.value);
          if (parsed.ok) {
            setError(null);
            onChange(parsed.value);
          } else {
            setError(parsed.message);
          }
        }}
        className="mt-2 min-h-40 font-mono text-[12px]"
      />
      {error ? <p className="mt-1 text-[11px] text-app-red-4">{error}</p> : null}
    </div>
  );
}

function emptyToUndefined(value: string, optional: boolean): string | undefined {
  if (value.trim().length === 0 && optional) return undefined;
  return value;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled field kind: ${JSON.stringify(value)}`);
}
