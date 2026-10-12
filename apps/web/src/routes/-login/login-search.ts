import { z } from "zod";

export interface LoginSearch {
  redirect?: string | undefined;
}

/** Same-origin paths only: must start with `/`, and `//host` is rejected. */
const redirectSchema = z
  .string()
  .startsWith("/")
  .refine((value) => !value.startsWith("//"));

export function sanitizeRedirect(value: unknown): string | undefined {
  const parsed = redirectSchema.safeParse(value);

  return parsed.success ? parsed.data : undefined;
}
