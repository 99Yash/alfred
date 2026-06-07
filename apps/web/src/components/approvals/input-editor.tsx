import { toolInputFields, type FieldSpec, type ToolName } from "@alfred/contracts";
import { useEffect, useState } from "react";
import { AppInput, AppSwitch, AppTextarea } from "~/components/ui/v2";
import { cn } from "~/lib/utils";
import { formatJson, parseJson } from "./format";

type JsonRecord = Record<string, unknown>;

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
  const fields = toolInputFields(toolName);

  if (!record || !fields) {
    return <JsonFallbackEditor value={value} onChange={onChange} disabled={disabled} />;
  }

  return (
    <div className="grid gap-3 rounded-xl bg-app-bg-2/60 p-3 shadow-[0_0_0_1px_rgba(0,0,0,0.05)] sm:grid-cols-2">
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
  field: FieldSpec;
  value: unknown;
  disabled: boolean | undefined;
  onChange: (value: unknown) => void;
}) {
  if (field.kind === "select") {
    return (
      <select
        id={id}
        value={typeof value === "string" ? value : ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value || undefined)}
        className={cn(
          "h-9 w-full rounded-xl bg-app-bg-1 px-3 text-sm text-app-fg-4",
          "app-elevated outline-none transition-shadow",
          "focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-4 focus-visible:ring-offset-app-background",
          "disabled:cursor-not-allowed disabled:opacity-60",
        )}
      >
        {field.optional ? <option value="">Any</option> : null}
        {(field.options ?? []).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }

  if (field.kind === "number" || field.kind === "integer") {
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
      />
    );
  }

  if (field.kind === "datetime") {
    return (
      <AppInput
        id={id}
        type="datetime-local"
        value={toDateTimeLocal(value)}
        disabled={disabled}
        onChange={(e) => {
          const next = e.target.value;
          onChange(next ? new Date(next).toISOString() : undefined);
        }}
      />
    );
  }

  if (field.kind === "string_array") {
    return (
      <AppTextarea
        id={id}
        value={Array.isArray(value) ? value.filter((v) => typeof v === "string").join("\n") : ""}
        rows={3}
        disabled={disabled}
        placeholder="One per line"
        onChange={(e) => {
          const items = e.target.value
            .split(/[,\n]/)
            .map((item) => item.trim())
            .filter(Boolean);
          onChange(items.length > 0 ? items : undefined);
        }}
        className="min-h-24"
      />
    );
  }

  if (field.kind === "json") {
    return <JsonField id={id} value={value} disabled={disabled} onChange={onChange} />;
  }

  if (field.kind === "textarea") {
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
  }

  // text + email
  return (
    <AppInput
      id={id}
      type={field.kind === "email" ? "email" : "text"}
      value={typeof value === "string" ? value : value === undefined ? "" : String(value)}
      disabled={disabled}
      onChange={(e) => onChange(emptyToUndefined(e.target.value, field.optional))}
    />
  );
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
  // Re-seed when the staged value changes underneath us (e.g. navigating
  // between approvals reuses this component).
  useEffect(() => {
    setText(formatJson(value));
    setError(null);
  }, [value]);

  return (
    <div className="rounded-xl bg-app-bg-2/60 p-3 shadow-[0_0_0_1px_rgba(0,0,0,0.05)]">
      <p className="text-[12px] leading-5 text-app-fg-3">
        This tool has no structured form yet — edit the raw input below.
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

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function emptyToUndefined(value: string, optional: boolean): string | undefined {
  if (value.trim().length === 0 && optional) return undefined;
  return value;
}

function toDateTimeLocal(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
