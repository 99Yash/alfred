import type { ToolName } from "@alfred/contracts";
import { cardFields } from "./card-spec";
import { formatJson } from "./format";

/**
 * Read-only render of a staged tool's proposed input. Uses the per-`ToolName`
 * card spec for a structured field layout; tools without a spec fall back to a
 * raw-JSON block so they always render safely. Editing happens elsewhere
 * (progressive-disclosure JSON editor on the card) — this is display only.
 */
export function InputRenderer({ toolName, input }: { toolName: ToolName; input: unknown }) {
  const fields = cardFields(toolName, input);

  if (!fields) {
    return (
      <pre className="max-h-72 overflow-auto rounded-xl bg-app-bg-2/60 p-3 font-mono text-[12px] leading-5 text-app-fg-4 shadow-[0_0_0_1px_rgba(0,0,0,0.05)]">
        {formatJson(input)}
      </pre>
    );
  }

  return (
    <div className="grid gap-2 rounded-xl bg-app-bg-2/60 p-3 shadow-[0_0_0_1px_rgba(0,0,0,0.05)] sm:grid-cols-2">
      {fields.map((field) => (
        <div key={field.label} className={field.multiline ? "sm:col-span-2" : undefined}>
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
            {field.value.trim() || "—"}
          </p>
        </div>
      ))}
    </div>
  );
}
