import { treaty } from "@elysiajs/eden";
import type { App } from "@alfred/http";
import type { z } from "zod";

export const API_URL =
  // SAFETY: Vite injects `import.meta.env`; the optional read falls back outside Vite.
  (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL ?? "http://localhost:3001";

/** `credentials: "include"` sends the session cookie cross-origin (3000 to 3001), or every route 401s. */
export const client = treaty<App>(API_URL, {
  fetch: { credentials: "include" },
});

/**
 * The success body of an Eden call, so types follow the route instead of a copied DTO.
 * Only the outer `data` null is removed; nullable fields inside stay nullable.
 */
export type EdenData<T extends (...args: never[]) => Promise<{ data: unknown }>> = NonNullable<
  Awaited<ReturnType<T>>["data"]
>;

/** JSON as the server sent it, timestamps as ISO strings. */
type WireBody = string | number | boolean | null | WireBody[] | { [key: string]: WireBody };

/**
 * Eden turns every ISO-like string into a `Date`, which breaks zod string timestamps.
 * Turn them back. Any non-JSON leaf is a transport bug, so throw.
 */
function restoreWireTimestamps(value: unknown): WireBody {
  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) return value.map(restoreWireTimestamps);

  if (typeof value === "object" && value !== null) {
    const out: { [key: string]: WireBody } = {};

    for (const [key, entry] of Object.entries(value)) out[key] = restoreWireTimestamps(entry);

    return out;
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }

  throw new TypeError(`Eden body holds a non-JSON leaf: ${typeof value}`);
}

/** Undo Eden's date revival, then parse. A failure is a contract break, so it throws. */
export function parseEdenBody<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  return schema.parse(restoreWireTimestamps(body));
}
