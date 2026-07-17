/** Shared user-display helpers (greeting line, name derivation). */

import type { authClient } from "./auth/auth-client";
import { capitalize } from "./strings";

/**
 * Display fields these helpers read off the session user. Derived from Better
 * Auth's inferred session type so it tracks the real user shape — we only need
 * `name`/`email` here, hence the `Pick`.
 */
export type SessionUser = Pick<(typeof authClient)["$Infer"]["Session"]["user"], "name" | "email">;

/**
 * First name for greetings: the leading word of the display name, or — when
 * there's no name — the email handle. Empty string when neither is known.
 */
export function firstName(user: SessionUser | null | undefined): string {
  if (!user) return "";
  if (user.name && user.name.trim()) {
    return capitalize(user.name.trim().split(/\s+/)[0] ?? "");
  }
  if (user.email) {
    return capitalize(user.email.split("@")[0] ?? "");
  }
  return "";
}

/** "Good morning" / "Good afternoon" / "Good evening" by local hour. */
export function greeting(date: Date): string {
  const h = date.getHours();
  if (h >= 5 && h < 12) return "Good morning";
  if (h >= 12 && h < 18) return "Good afternoon";
  return "Good evening";
}
