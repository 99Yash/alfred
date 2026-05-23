/**
 * Shared formatting helpers for the approvals UI. Pure functions only —
 * no React imports — so they're free of the no-multi-comp lint scope.
 */

type JsonParseResult = { ok: true; value: unknown } | { ok: false; message: string };

export function parseJson(value: string): JsonParseResult {
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Invalid JSON" };
  }
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
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
    return `today at ${d.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    })}`;
  }
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
