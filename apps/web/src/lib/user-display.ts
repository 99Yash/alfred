/** Shared user-display helpers (greeting line, name derivation). */

export interface SessionUser {
  name?: string | null;
  email?: string | null;
}

/** Capitalize the first letter; leaves the rest untouched. */
export function titleCase(s: string): string {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * First name for greetings: the leading word of the display name, or — when
 * there's no name — the email handle. Empty string when neither is known.
 */
export function firstName(user: SessionUser | null | undefined): string {
  if (!user) return "";
  if (user.name && user.name.trim()) {
    return titleCase(user.name.trim().split(/\s+/)[0] ?? "");
  }
  if (user.email) {
    return titleCase(user.email.split("@")[0] ?? "");
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
