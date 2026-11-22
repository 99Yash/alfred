import { z } from "zod";

/**
 * The `/api/auth/get-session` response. The session object omits `token`, `ipAddress`, and
 * `userAgent`: `token` is the value behind the HttpOnly cookie, so a script must not read it.
 * The SPA reads only `user`. A `z.object` strips unknown keys, so a new Better Auth session field
 * stays on the server until this schema names it.
 */
export const authSessionResponseSchema = z.object({
  user: z.looseObject({ id: z.string() }),
  session: z.object({
    id: z.string(),
    userId: z.string(),
    expiresAt: z.date(),
    createdAt: z.date(),
    updatedAt: z.date(),
  }),
});

export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>;
