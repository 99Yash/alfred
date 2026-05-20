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
 * Pull a human-readable message out of an Eden error envelope. Eden wraps
 * server `status(4xx, { message })` responses as `{ error: { value } }`;
 * this collapses the safe path into a single string + a fallback.
 */
export function edenErrorMessage(error: unknown, fallback: string): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "value" in error &&
    typeof (error as { value: unknown }).value === "object" &&
    (error as { value: unknown }).value !== null &&
    "message" in ((error as { value: object }).value as object)
  ) {
    return String((error as { value: { message: unknown } }).value.message);
  }
  return fallback;
}
