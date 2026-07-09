import { treaty } from "@elysiajs/eden";
import type { App } from "@alfred/api";

const API_URL =
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
 * Usage: `EdenData<typeof client.api.me.meetings.get>["items"][number]`.
 */
export type EdenData<T extends (...args: never[]) => Promise<{ data: unknown }>> = NonNullable<
  Awaited<ReturnType<T>>["data"]
>;
