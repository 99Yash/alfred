import {
  assertNever,
  type calendarListEventsInput,
  fieldValue,
  toolInputFields,
  toJsonValue,
  type FieldSpec,
  type JsonObject,
  type ToolName,
  jsonObjectSchema,
} from "@alfred/contracts";
import { useState } from "react";
import type { z } from "zod";
import { AppDateTimePicker, AppInput, AppSelect, AppSwitch, AppTextarea } from "~/components/ui/v2";
import { formatDateTime } from "~/lib/date-format";
import { formatJson, parseJson } from "./format";

type FieldControlSpec = Exclude<FieldSpec, { kind: "boolean" }>;

type CalendarListEventsKey = keyof z.infer<typeof calendarListEventsInput>;

/**
 * Edit a staged write's input. Controls derive from the tool's zod `inputSchema`
 * (`toolInputFields`), with a raw-JSON fallback. `system.ask_user` never gets here.
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
  disabled?: boolean | undefined;
  idPrefix: string;
}) {
  const parsed = jsonObjectSchema.safeParse(value);
  const fieldSpecs = toolInputFields(toolName);

  if (!parsed.success || !fieldSpecs) {
    return <JsonFallbackEditor value={value} onChange={onChange} disabled={disabled} />;
  }

  const record = parsed.data;
  const fields = editorFieldsForTool(toolName, fieldSpecs, record);

  return (
    <div className="grid gap-3 rounded-surface bg-app-bg-2/60 p-3 shadow-[0_0_0_1px_var(--app-bg-a2)] sm:grid-cols-2">
      {fields.map((field) => (
        <EditableField
          key={field.key}
          id={`${idPrefix}-${field.key}`}
          field={field}
          record={record}
          disabled={disabled || field.readOnly}
          onChange={(next) => {
            const updated = { ...record };

            if (next === undefined) delete updated[field.key];
            else updated[field.key] = toJsonValue(next);
            onChange(updated);
          }}
        />
      ))}
    </div>
  );
}

/**
 * The same fields as {@link ApprovalInputEditor}, read-only: one label and value per filled
 * field, no controls. Empty fields are left out. Input with no field specs shows as JSON.
 */
export function ApprovalInputFacts({ toolName, value }: { toolName: ToolName; value: unknown }) {
  const parsed = jsonObjectSchema.safeParse(value);
  const fieldSpecs = toolInputFields(toolName);

  if (!parsed.success || !fieldSpecs) {
    return (
      <pre className="overflow-x-auto rounded-surface bg-app-bg-2/60 p-3 font-mono text-[12px] leading-5 whitespace-pre-wrap text-app-fg-3">
        {formatJson(value)}
      </pre>
    );
  }

  const record = parsed.data;

  const facts = editorFieldsForTool(toolName, fieldSpecs, record).flatMap((field) => {
    const text = factText(field, record);

    return text === null ? [] : [{ field, text }];
  });

  if (facts.length === 0) return null;

  return (
    <dl className="grid grid-cols-[minmax(5rem,auto)_1fr] gap-x-4 gap-y-1.5 text-[13px] leading-5">
      {facts.map(({ field, text }) => (
        <div key={field.key} className="contents">
          <dt className="text-app-fg-2">{field.label}</dt>
          <dd className="min-w-0 wrap-break-word whitespace-pre-wrap text-app-fg-4">{text}</dd>
        </div>
      ))}
    </dl>
  );
}

/** One field's value as display text, or `null` when it is empty. */
function factText(field: FieldSpec, record: JsonObject): string | null {
  switch (field.kind) {
    case "boolean": {
      const flag = fieldValue(field, record);

      return flag === undefined ? null : flag ? "Yes" : "No";
    }

    case "select": {
      const picked = fieldValue(field, record);

      if (!picked) return null;

      return field.options.find((option) => option.value === picked)?.label ?? picked;
    }

    case "datetime": {
      const iso = fieldValue(field, record);

      return iso ? formatDateTime(iso, { today: "sentence" }) : null;
    }

    case "text":
    case "email":
    case "textarea": {
      const text = fieldValue(field, record)?.trim();

      return text ? text : null;
    }

    case "number":
    case "integer": {
      const numeric = fieldValue(field, record);

      return numeric === undefined ? null : String(numeric);
    }

    case "string_array": {
      const items = fieldValue(field, record);

      return items.length > 0 ? items.join(", ") : null;
    }

    case "json": {
      const raw = fieldValue(field, record);

      return raw === undefined || raw === null ? null : formatJson(raw);
    }
  }
}

// JSON Schema loses calendarListEventsInput's explicit-vs-relative refine, so
// mirror it here. Typed on z.infer (z.input is `unknown`) so renames fail to compile.
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
  record: JsonObject,
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
  // SAFETY: widening only types `.has`'s argument; a miss is the intended false.
  return (keys as ReadonlySet<string>).has(key);
}

function hasFieldValue(record: JsonObject, key: CalendarListEventsKey): boolean {
  const value = record[key];

  return value !== undefined && value !== null && value !== "";
}

function EditableField({
  id,
  field,
  record,
  disabled,
  onChange,
}: {
  id: string;
  field: FieldSpec;
  record: JsonObject;
  disabled: boolean | undefined;
  onChange: (value: unknown) => void;
}) {
  if (field.kind === "boolean") {
    return (
      <div className="flex min-h-16 items-center justify-between gap-3 rounded-control bg-app-bg-1/70 px-3 py-2 shadow-[0_0_0_1px_var(--app-fg-a1)]">
        <label htmlFor={id} className="min-w-0 text-[12px] font-medium text-app-fg-3">
          {field.label}
        </label>
        <AppSwitch
          id={id}
          checked={fieldValue(field, record) === true}
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
        className="text-[11px] font-medium tracking-tight text-app-fg-2 uppercase"
      >
        {field.label}
      </label>
      <div className="mt-1.5">
        <FieldControl
          id={id}
          field={field}
          record={record}
          disabled={disabled}
          onChange={onChange}
        />
      </div>
    </div>
  );
}

function FieldControl({
  id,
  field,
  record,
  disabled,
  onChange,
}: {
  id: string;
  field: FieldControlSpec;
  record: JsonObject;
  disabled: boolean | undefined;
  onChange: (value: unknown) => void;
}) {
  switch (field.kind) {
    case "select":
      return (
        <AppSelect
          id={id}
          label={field.label}
          value={fieldValue(field, record)}
          onChange={onChange}
          options={field.options}
          clearable={field.optional}
          placeholder={field.optional ? "Any" : "Select…"}
          disabled={disabled}
        />
      );
    case "number":
    case "integer": {
      const numeric = fieldValue(field, record);

      return (
        <AppInput
          id={id}
          type="number"
          inputMode={field.kind === "integer" ? "numeric" : "decimal"}
          min={field.min}
          max={field.max}
          step={field.step ?? (field.kind === "integer" ? 1 : undefined)}
          value={numeric === undefined ? "" : String(numeric)}
          disabled={disabled}
          onChange={(e) => {
            const next = e.target.value.trim();
            onChange(next === "" ? undefined : Number(next));
          }}
          className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
      );
    }

    case "datetime":
      return (
        <AppDateTimePicker
          id={id}
          value={fieldValue(field, record)}
          onChange={onChange}
          disabled={disabled}
        />
      );
    case "string_array":
      return (
        <AppTextarea
          id={id}
          value={fieldValue(field, record).join("\n")}
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
      return (
        <JsonField
          id={id}
          value={fieldValue(field, record)}
          disabled={disabled}
          onChange={onChange}
        />
      );
    case "textarea":
      return (
        <AppTextarea
          id={id}
          value={fieldValue(field, record) ?? ""}
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
          value={fieldValue(field, record) ?? ""}
          disabled={disabled}
          onChange={(e) => onChange(emptyToUndefined(e.target.value, field.optional))}
        />
      );
    default:
      return assertNever(field, "field kind");
  }
}

/** An object/array field edited as JSON, committed only when valid. */
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
  const [prevValue, setPrevValue] = useState(value);

  if (value !== prevValue) {
    setPrevValue(value);
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
  // Re-seed when the staged value changes. Render-phase state, not a ref, so a
  // bailed-out render discards it too.
  const [prevValue, setPrevValue] = useState(value);

  if (value !== prevValue) {
    setPrevValue(value);
    setText(formatJson(value));
    setError(null);
  }

  return (
    <div className="rounded-surface bg-app-bg-2/60 p-3 shadow-[0_0_0_1px_var(--app-bg-a2)]">
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
