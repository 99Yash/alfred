import { treaty } from "@elysiajs/eden";
import type { App } from "@alfred/http";
import type { z } from "zod";

// SAFETY: Vite injects VITE_API_URL at build time; the optional read keeps
// non-Vite contexts (unit tests) working via the dev-server fallback.
export const API_URL =
  // SAFETY: import.meta.env is Vite's injected env record; this only types the
  // optional field access.
  (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL ?? "http://localhost:3001";

/**
 * `credentials: 'include'` lets Better Auth's session cookie ride along on
 * cross-origin requests from apps/web (port 3000) → apps/server (port 3001).
 * Without this, every protected route 401s in dev because the cookie is
 * stripped by the browser's default same-origin policy.
 */
export const client = treaty<App>(API_URL, {
  fetch: { credentials: "include" },
});

/**
 * Unwrap the success `data` payload of an Eden Treaty call. Every treaty
 * response resolves to `{ data: T; error: null } | { data: null; error: E }`,
 * so a successful body is `NonNullable<…["data"]>`. Deriving hook/response
 * types from this pins them to the live wire contract instead of a hand-copied
 * DTO that can silently drift from the route (code-style §1).
 *
 * Only the outer `data` null is stripped. A field that is itself nullable in
 * the success payload stays nullable — apply your own `NonNullable` to it (see
 * `use-latest-briefing`, which unwraps the `briefing` field on top of this).
 *
 * Usage: `EdenData<typeof client.api.me.meetings.get>["items"][number]`.
 */
export type EdenData<T extends (...args: never[]) => Promise<{ data: unknown }>> = NonNullable<
  Awaited<ReturnType<T>>["data"]
>;

/**
 * A response body as the server serialized it: JSON, with every timestamp an
 * ISO-8601 string. This is the input shape every wire contract in
 * `@alfred/contracts` describes.
 */
type WireBody = string | number | boolean | null | WireBody[] | { [key: string]: WireBody };

/**
 * Eden Treaty revives every ISO-8601-shaped string in a response body to a
 * `Date`, recursively. A body that is then parsed with a zod contract expecting
 * ISO strings fails on every timestamp. Walk the value once and put the
 * strings back; arrays and plain objects recurse, JSON scalars pass through.
 * The body came out of `JSON.parse` plus that revival, so any other leaf is a
 * transport bug and throws rather than being smuggled into the contract parse.
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

/**
 * Parse an Eden success body with the wire contract the server owns. The body
 * is normalized back to its wire form first (see `restoreWireTimestamps`), so
 * a `z.string()` timestamp parses as the server sent it. A parse failure is a
 * contract break between the route and the hook and throws on purpose.
 */
export function parseEdenBody<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  return schema.parse(restoreWireTimestamps(body));
}
