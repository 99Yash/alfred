import type { authClient } from "./auth/auth-client";
import { capitalize } from "./strings";

export type SessionUser = Pick<(typeof authClient)["$Infer"]["Session"]["user"], "name" | "email">;

/** The first word of the name, else the email handle, else "". */
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

export function greeting(date: Date): string {
  const h = date.getHours();

  if (h >= 5 && h < 12) return "Good morning";

  if (h >= 12 && h < 18) return "Good afternoon";

  return "Good evening";
}
