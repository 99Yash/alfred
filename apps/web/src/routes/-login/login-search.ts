import { z } from "zod";

export interface LoginSearch {
  redirect?: string | undefined;
}

/**
 * Same-origin paths only: must start with `/`, and `//host` is rejected. `/login` is rejected
 * too, so a login URL can never nest inside its own `redirect`.
 */
const redirectSchema = z
  .string()
  .startsWith("/")
  .refine((value) => !value.startsWith("//"))
  .refine((value) => !/^\/login\/?$/.test(new URL(value, "https://alfred.invalid").pathname));

export function sanitizeRedirect(value: unknown): string | undefined {
  const parsed = redirectSchema.safeParse(value);

  return parsed.success ? parsed.data : undefined;
}
