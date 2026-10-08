import { eventTriggerPhrase, humanizeSlug } from "@alfred/contracts";

export type JsonParseResult = { ok: true; value: unknown } | { ok: false; message: string };

/** Provenance line: `manual` → "Run now", a Gmail event → "Triggered by Gmail message". */
export function triggerLabel(trigger: {
  kind: string;
  source?: string | null | undefined;
  type?: string | null | undefined;
  rawKind?: string | null | undefined;
}): string {
  switch (trigger.kind) {
    case "manual":
      return "Run now";
    case "cron":
      return "Scheduled";
    case "on_signal":
      return "Signal";
    case "event": {
      // Runs from before ADR-0047 have no source.
      const phrase = trigger.source
        ? eventTriggerPhrase({
            source: trigger.source,
            type: trigger.type,
            rawKind: trigger.rawKind,
          })
        : "an event";

      return `Triggered by ${phrase}`;
    }

    default:
      return humanizeSlug(trigger.kind);
  }
}

export function parseJson(value: string): JsonParseResult {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Invalid JSON" };
  }
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

export function shortId(value: string): string {
  return value.length > 14 ? `${value.slice(0, 10)}…` : value;
}

export function formatTimestamp(iso: string): string {
  const d = new Date(iso);

  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();

  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();

  if (sameDay) {
    return `today at ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  }

  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
