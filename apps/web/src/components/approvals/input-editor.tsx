import type { ToolName } from "@alfred/contracts";
import { AppInput, AppSwitch, AppTextarea } from "~/components/ui/v2";
import { cn } from "~/lib/utils";
import { formatJson } from "./format";

type JsonRecord = Record<string, unknown>;

interface SelectOption {
  value: string;
  label: string;
}

interface FieldMeta {
  label: string;
  kind?: "text" | "textarea" | "datetime" | "number" | "boolean" | "select" | "string_array";
  options?: readonly SelectOption[];
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  optional?: boolean;
  alwaysShow?: boolean;
}

const GITHUB_STATE_OPTIONS: readonly SelectOption[] = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "merged", label: "Merged" },
  { value: "all", label: "All" },
];

const CALENDAR_WINDOW_OPTIONS: readonly SelectOption[] = [
  { value: "today", label: "Today" },
  { value: "tomorrow", label: "Tomorrow" },
  { value: "next_7_days", label: "Next 7 days" },
];

const PART_OF_DAY_OPTIONS: readonly SelectOption[] = [
  { value: "full_day", label: "Full day" },
  { value: "morning", label: "Morning" },
  { value: "afternoon", label: "Afternoon" },
  { value: "evening", label: "Evening" },
];

const TOOL_FIELD_ORDER: Partial<Record<ToolName, readonly string[]>> = {
  "github.search_pull_requests": [
    "query",
    "state",
    "author",
    "closedWithinDays",
    "createdWithinDays",
    "perPage",
  ],
  "calendar.list_events": ["window", "partOfDay", "timeMin", "timeMax", "maxResults"],
  "calendar.create_event": [
    "calendarId",
    "summary",
    "start",
    "end",
    "timeZone",
    "location",
    "attendees",
    "description",
  ],
};

const FIELD_META: Partial<Record<ToolName, Record<string, FieldMeta>>> = {
  "github.search_pull_requests": {
    query: {
      label: "Search query",
      kind: "text",
      placeholder: "repo:owner/name label:bug",
      optional: true,
      alwaysShow: true,
    },
    state: {
      label: "State",
      kind: "select",
      options: GITHUB_STATE_OPTIONS,
      alwaysShow: true,
    },
    author: {
      label: "Author",
      kind: "text",
      placeholder: "@me",
      alwaysShow: true,
    },
    closedWithinDays: {
      label: "Closed within days",
      kind: "number",
      min: 1,
      max: 365,
      step: 1,
      optional: true,
    },
    createdWithinDays: {
      label: "Created within days",
      kind: "number",
      min: 1,
      max: 365,
      step: 1,
      optional: true,
    },
    perPage: {
      label: "Results",
      kind: "number",
      min: 1,
      max: 100,
      step: 1,
      alwaysShow: true,
    },
  },
  "calendar.list_events": {
    window: {
      label: "Window",
      kind: "select",
      options: CALENDAR_WINDOW_OPTIONS,
      alwaysShow: true,
    },
    partOfDay: {
      label: "Part of day",
      kind: "select",
      options: PART_OF_DAY_OPTIONS,
      alwaysShow: true,
    },
    timeMin: { label: "Starts after", kind: "datetime", optional: true },
    timeMax: { label: "Ends before", kind: "datetime", optional: true },
    maxResults: { label: "Max events", kind: "number", min: 1, max: 50, step: 1, alwaysShow: true },
  },
  "calendar.create_event": {
    calendarId: { label: "Calendar", kind: "text", placeholder: "primary", alwaysShow: true },
    summary: { label: "Title", kind: "text", alwaysShow: true },
    start: { label: "Start", kind: "datetime", alwaysShow: true },
    end: { label: "End", kind: "datetime", alwaysShow: true },
    timeZone: {
      label: "Timezone",
      kind: "text",
      placeholder: "Asia/Kolkata",
      optional: true,
    },
    location: { label: "Location", kind: "text", optional: true },
    attendees: {
      label: "Attendees",
      kind: "string_array",
      placeholder: "one@email.com\nanother@email.com",
      optional: true,
    },
    description: { label: "Description", kind: "textarea", optional: true },
  },
};

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

  if (!record) {
    return (
      <div className="rounded-xl bg-app-bg-2/60 p-3 shadow-[0_0_0_1px_rgba(0,0,0,0.05)]">
        <p className="text-[12px] leading-5 text-app-fg-3">
          This input is not an editable object yet. Review the raw value below.
        </p>
        <pre className="mt-2 max-h-52 overflow-auto rounded-lg bg-app-bg-1 p-3 font-mono text-[12px] leading-5 text-app-fg-4 shadow-[0_0_0_1px_var(--app-fg-a1)]">
          {formatJson(value)}
        </pre>
      </div>
    );
  }

  const keys = editableKeys(toolName, record);
  return (
    <div className="grid gap-3 rounded-xl bg-app-bg-2/60 p-3 shadow-[0_0_0_1px_rgba(0,0,0,0.05)] sm:grid-cols-2">
      {keys.map((key) => {
        const meta = fieldMeta(toolName, key);
        const fieldValue = record[key];
        return (
          <EditableField
            key={key}
            id={`${idPrefix}-${key}`}
            fieldKey={key}
            meta={meta}
            value={fieldValue}
            disabled={disabled}
            onChange={(next) => {
              const updated = { ...record };
              if (next === undefined) delete updated[key];
              else updated[key] = next;
              onChange(updated);
            }}
          />
        );
      })}
    </div>
  );
}

function EditableField({
  id,
  fieldKey,
  meta,
  value,
  disabled,
  onChange,
}: {
  id: string;
  fieldKey: string;
  meta: FieldMeta;
  value: unknown;
  disabled: boolean | undefined;
  onChange: (value: unknown) => void;
}) {
  const kind = meta.kind ?? inferKind(value);
  const label = meta.label;

  if (kind === "boolean") {
    return (
      <div className="flex min-h-16 items-center justify-between gap-3 rounded-lg bg-app-bg-1/70 px-3 py-2 shadow-[0_0_0_1px_var(--app-fg-a1)]">
        <label htmlFor={id} className="min-w-0 text-[12px] font-medium text-app-fg-3">
          {label}
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
    <div className={kind === "textarea" || kind === "string_array" ? "sm:col-span-2" : undefined}>
      <label
        htmlFor={id}
        className="text-[11px] font-medium uppercase tracking-tight text-app-fg-2"
      >
        {label}
      </label>
      <div className="mt-1.5">
        {renderControl({ id, fieldKey, kind, meta, value, disabled, onChange })}
      </div>
    </div>
  );
}

function renderControl({
  id,
  fieldKey,
  kind,
  meta,
  value,
  disabled,
  onChange,
}: {
  id: string;
  fieldKey: string;
  kind: FieldMeta["kind"];
  meta: FieldMeta;
  value: unknown;
  disabled: boolean | undefined;
  onChange: (value: unknown) => void;
}) {
  if (kind === "select") {
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
        {meta.optional ? <option value="">Any</option> : null}
        {(meta.options ?? []).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }

  if (kind === "number") {
    return (
      <AppInput
        id={id}
        type="number"
        inputMode="numeric"
        min={meta.min}
        max={meta.max}
        step={meta.step ?? 1}
        value={typeof value === "number" && Number.isFinite(value) ? String(value) : ""}
        disabled={disabled}
        placeholder={meta.placeholder}
        onChange={(e) => {
          const next = e.target.value.trim();
          onChange(next === "" ? undefined : Number(next));
        }}
      />
    );
  }

  if (kind === "datetime") {
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

  if (kind === "textarea") {
    return (
      <AppTextarea
        id={id}
        value={typeof value === "string" ? value : ""}
        rows={3}
        disabled={disabled}
        placeholder={meta.placeholder}
        onChange={(e) => onChange(emptyToUndefined(e.target.value, meta))}
        className="min-h-24"
      />
    );
  }

  if (kind === "string_array") {
    return (
      <AppTextarea
        id={id}
        value={Array.isArray(value) ? value.filter((v) => typeof v === "string").join("\n") : ""}
        rows={3}
        disabled={disabled}
        placeholder={meta.placeholder}
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

  if (kind === "text") {
    return (
      <AppInput
        id={id}
        value={typeof value === "string" ? value : value === undefined ? "" : String(value)}
        disabled={disabled}
        placeholder={meta.placeholder}
        onChange={(e) => onChange(emptyToUndefined(e.target.value, meta))}
      />
    );
  }

  return (
    <pre className="max-h-40 overflow-auto rounded-xl bg-app-bg-1 p-3 font-mono text-[12px] leading-5 text-app-fg-4 shadow-[0_0_0_1px_var(--app-fg-a1)]">
      {formatJson({ [fieldKey]: value })}
    </pre>
  );
}

function editableKeys(toolName: ToolName, record: JsonRecord): string[] {
  const order = TOOL_FIELD_ORDER[toolName] ?? [];
  const meta = FIELD_META[toolName] ?? {};
  const seen = new Set<string>();
  const keys: string[] = [];

  for (const key of order) {
    const show = Object.hasOwn(record, key) || meta[key]?.alwaysShow;
    if (show && !seen.has(key)) {
      keys.push(key);
      seen.add(key);
    }
  }

  for (const key of Object.keys(record)) {
    if (!seen.has(key)) keys.push(key);
  }

  return keys;
}

function fieldMeta(toolName: ToolName, key: string): FieldMeta {
  return FIELD_META[toolName]?.[key] ?? { label: humanizeKey(key) };
}

function inferKind(value: unknown): FieldMeta["kind"] {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return value.length > 90 ? "textarea" : "text";
  if (Array.isArray(value) && value.every((item) => typeof item === "string"))
    return "string_array";
  return undefined;
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function emptyToUndefined(value: string, meta: FieldMeta): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0 && meta.optional) return undefined;
  return value;
}

function toDateTimeLocal(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function humanizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
