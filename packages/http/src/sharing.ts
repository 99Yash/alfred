/**
 * TRANSPORT ONLY. This file reads the request and writes the response; it takes
 * no decision that outlives either. What a snapshot may contain, when a share
 * is reused rather than minted, and what an unauthenticated visitor may read
 * are all decided in `@alfred/assistant/sharing` (ADR-0089/0102).
 *
 * THE ONE THING THIS FILE DOES DECIDE is which routes are behind `auth` and
 * which is not. Read that split carefully before editing:
 *
 *   - `/api/threads/:threadId/share`  (POST)   — owner only
 *   - `/api/threads/:threadId/shares` (GET)    — owner only
 *   - `/api/shares/:sharedThreadId`   (DELETE) — owner only
 *   - `/api/shared/:urlSlug`          (GET)    — PUBLIC, no session
 *
 * The public route is the only unauthenticated data route in the API. It is
 * mounted as a separate Elysia instance rather than as an exception inside the
 * guarded one, because an `auth: true` guard applies to every route declared in
 * its block and a future route added next to a `{ auth: false }` sibling would
 * inherit the wrong side of that line by default. Two instances make the
 * boundary structural: the guarded block cannot accidentally leak a route, and
 * this one has exactly one member that a reviewer can see in full.
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

/** Owner-only share management. Every route here needs a session AND onboarding. */
const ownerSharingRoutes = new Elysia({ prefix: "/api", normalize: "typebox" })
  .use(authMacro)
  .use(requireOnboarded)
  .guard({ auth: true, requireOnboarded: true }, (app) =>
    app
      .post(
        /**
         * Publish the thread, or return the existing share that already covers
         * it. Idempotent for an unchanged thread, so a double click does not
         * scatter two public URLs (see `shareThread`).
         */
        "/threads/:threadId/share",
        async ({ params, user }) =>
          await shareThread({ userId: user.id, threadId: params.threadId }),
        { params: t.Object({ threadId: t.String({ minLength: 1, maxLength: 120 }) }) },
      )
      .get(
        /** Live shares of this thread, so the dialog can list and revoke them. */
        "/threads/:threadId/shares",
        async ({ params, user }) => ({
          shares: await listThreadShares({ userId: user.id, threadId: params.threadId }),
        }),
        { params: t.Object({ threadId: t.String({ minLength: 1, maxLength: 120 }) }) },
      )
      .delete(
        /**
         * Revoke a share. `revokeSharedThread` scopes the delete by `user_id`,
         * so an id alone cannot revoke someone else's link. A miss answers 404
         * rather than 204: the caller asked to remove a specific share and
         * should learn it was not theirs to remove, and a UI that already
         * removed the row treats either answer the same way.
         */
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
 * The public read. No `authMacro`, no `requireOnboarded`, no `user` in scope —
 * the slug is the whole capability.
 *
 * A missing slug answers 404 with no detail. Do not enrich that message with
 * "revoked" versus "never existed": the difference tells a prober whether a
 * guessed slug was ever real.
 */
const publicSharingRoutes = new Elysia({ prefix: "/api", normalize: "typebox" }).get(
  "/shared/:urlSlug",
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
