/**
 * Transport only; decisions live in `@alfred/assistant/sharing` (ADR-0089/0102).
 * This file decides one thing: which routes need a session. The public read is a
 * separate instance on the narrow `/api/shared` prefix, so a new route cannot
 * become public by accident.
 */
import { Errors } from "@alfred/contracts";
import { Elysia, t } from "elysia";

import {
  listThreadShares,
  readSharedThreadPage,
  revokeSharedThread,
  shareThread,
} from "@alfred/assistant/sharing";
import { authMacro } from "./middleware/auth";
import { requireOnboarded } from "./middleware/onboarding";
import { publicRateLimit } from "./middleware/public-rate-limit";

const ownerSharingRoutes = new Elysia({ prefix: "/api", normalize: "typebox" })
  .use(authMacro)
  .use(requireOnboarded)
  .guard({ auth: true, requireOnboarded: true }, (app) =>
    app
      .post(
        /** Idempotent for an unchanged thread, so a double click makes one URL. */
        "/threads/:threadId/share",
        async ({ params, user }) =>
          await shareThread({ userId: user.id, threadId: params.threadId }),
        { params: t.Object({ threadId: t.String({ minLength: 1, maxLength: 120 }) }) },
      )
      .get(
        "/threads/:threadId/shares",
        async ({ params, user }) => ({
          shares: await listThreadShares({ userId: user.id, threadId: params.threadId }),
        }),
        { params: t.Object({ threadId: t.String({ minLength: 1, maxLength: 120 }) }) },
      )
      .delete(
        /** Scoped by `user_id`. A miss is a 404, not a 204. */
        "/shares/:sharedThreadId",
        async ({ params, user, set }) => {
          const removed = await revokeSharedThread({
            userId: user.id,
            sharedThreadId: params.sharedThreadId,
          });

          if (!removed) throw Errors.NotFoundError("Share not found");

          set.status = 204;

          return null;
        },
        { params: t.Object({ sharedThreadId: t.String({ minLength: 1, maxLength: 120 }) }) },
      ),
  );

/**
 * Public read: the slug is the whole capability.
 * Keep the 404 vague: "revoked" vs "never existed" tells a prober the slug was real.
 */
const publicSharingRoutes = new Elysia({ prefix: "/api/shared", normalize: "typebox" })
  .use(publicRateLimit("shared-thread"))
  .get(
    "/:urlSlug",
    async ({ params }) => {
      const page = await readSharedThreadPage(params.urlSlug);

      if (!page) throw Errors.NotFoundError("This shared thread is not available.");

      return page;
    },
    { params: t.Object({ urlSlug: t.String({ minLength: 1, maxLength: 200 }) }) },
  );

export const sharingRoutes = new Elysia({ name: "sharing", normalize: "typebox" })
  .use(publicSharingRoutes)
  .use(ownerSharingRoutes);
