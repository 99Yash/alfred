export interface LoginSearch {
  redirect?: string;
}

/**
 * Only same-origin absolute paths survive: reject anything that isn't a
 * leading-slash path, and reject protocol-relative `//host` values.
 */
export function sanitizeRedirect(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!value.startsWith("/") || value.startsWith("//")) return undefined;
  return value;
}
