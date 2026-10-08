export interface LoginSearch {
  redirect?: string | undefined;
}

/** Same-origin paths only: must start with `/`, and `//host` is rejected. */
export function sanitizeRedirect(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  if (!value.startsWith("/") || value.startsWith("//")) return undefined;

  return value;
}
