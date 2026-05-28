import type { ToolName } from "@alfred/contracts";
import { formatJson, stringArray, stringValue } from "./format";

interface Field {
  label: string;
  value: string;
  multiline?: boolean;
}

/**
 * Web-only registry of human-readable field layouts, keyed by `ToolName`.
 * A tool without an entry falls back to the raw-JSON renderer below, so new
 * tools render safely before anyone designs a bespoke card. Server runtime
 * values never cross into this bundle — only the structural input shape.
 */
const FIELD_BUILDERS: Partial<Record<ToolName, (input: Record<string, unknown>) => Field[]>> = {
  "gmail.send_draft": (input) => [
    { label: "To", value: stringArray(input.to).join(", ") },
    { label: "Cc", value: stringArray(input.cc).join(", ") },
    { label: "Subject", value: stringValue(input.subject) },
    { label: "Thread", value: stringValue(input.threadId) },
    { label: "Body", value: stringValue(input.bodyText), multiline: true },
  ],
  "calendar.create_event": (input) => [
    { label: "Summary", value: stringValue(input.summary) },
    { label: "Start", value: stringValue(input.start) },
    { label: "End", value: stringValue(input.end) },
    { label: "Attendees", value: stringArray(input.attendees).join(", ") },
    { label: "Description", value: stringValue(input.description), multiline: true },
  ],
};

export function InputRenderer({
  toolName,
  input,
}: {
  toolName: ToolName;
  input: unknown;
}) {
  const builder = FIELD_BUILDERS[toolName];
  const record = input && typeof input === "object" ? (input as Record<string, unknown>) : null;

  if (!builder || !record) {
    return (
      <pre className="max-h-72 overflow-auto rounded-xl bg-vs-bg-2/60 p-3 font-mono text-[12px] leading-5 text-vs-fg-4 shadow-[0_0_0_1px_rgba(0,0,0,0.05)]">
        {formatJson(input)}
      </pre>
    );
  }

  return (
    <div className="grid gap-2 rounded-xl bg-vs-bg-2/60 p-3 shadow-[0_0_0_1px_rgba(0,0,0,0.05)] sm:grid-cols-2">
      {builder(record).map((field) => (
        <div key={field.label} className={field.multiline ? "sm:col-span-2" : undefined}>
          <p className="text-[11px] font-medium uppercase tracking-tight text-vs-fg-2">
            {field.label}
          </p>
          <p
            className={
              field.multiline
                ? "mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs leading-5 text-vs-fg-4"
                : "mt-1 break-words text-xs leading-5 text-vs-fg-4"
            }
          >
            {field.value.trim() || "—"}
          </p>
        </div>
      ))}
    </div>
  );
}
