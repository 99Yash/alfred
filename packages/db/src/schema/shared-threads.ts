import type { SharedThreadArtifact, SharedThreadMessage } from "@alfred/contracts";
import { index, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

import { createId, lifecycle_dates } from "../helpers";
import { user } from "./auth";
import { chatThreads } from "./chat";

/**
 * A public, read-only publication of one chat thread (ADR-0102).
 *
 * The row is an IMMUTABLE SNAPSHOT, not a visibility flag on `chat_threads`.
 * A share therefore keeps showing the thread as it read at publish time, and a
 * later turn in the live thread changes nothing a visitor sees. That is the
 * property a visibility flag cannot give: with a flag, every new turn — and
 * every tool result inside it — publishes itself the moment it lands.
 *
 * WHAT THE SNAPSHOT MAY HOLD. `messages` and `artifacts` carry the redacted
 * publication shapes from `@alfred/sync`, never the raw synced rows. The
 * redaction happens at WRITE time, in `buildSharedThreadSnapshot`, so a tool
 * call's `argsPreview` / `resultPreview` — which routinely hold raw Gmail
 * bodies, calendar entries, and file contents — never reach this table at all.
 * No read path can leak a field the row does not store. Do not widen these
 * columns to the synced types to "keep the sidebar richer"; that reintroduces
 * exactly the leak the split shape exists to make unrepresentable.
 *
 * THE SLUG IS THE CAPABILITY. There is no token column, no `visibility` enum,
 * and no per-visitor grant: whoever holds `url_slug` can read the snapshot
 * unauthenticated. The slug therefore carries a 16-char random suffix so it is
 * not guessable from the thread title (ADR-0102 D2).
 *
 * REVOKE IS A HARD DELETE. There is no `revoked_at` column on purpose. A
 * revoked share must stop existing, not become a row that some later query
 * forgets to filter; deleting it also removes the snapshot bytes. Both foreign
 * keys cascade, so deleting the thread or the user revokes every share of it.
 */
export const sharedThreads = pgTable(
  "shared_threads",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("share")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /**
     * The thread this snapshot was taken from. Cascades: deleting the thread
     * un-publishes it. Dimension's equivalent column is `set null`, which
     * leaves a public page alive after its source is gone — deliberately not
     * copied.
     */
    sourceThreadId: text("source_thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    /** Public URL segment: `kebab-title-<16 random chars>`. The read capability. */
    urlSlug: text("url_slug").notNull(),
    /** Thread title frozen at publish time, so a later rename does not rewrite a published page. */
    title: text("title").notNull(),
    /** The redacted transcript, in thread order. */
    messages: jsonb("messages").$type<SharedThreadMessage[]>().notNull(),
    /** The redacted `complete` artifacts of the thread. Empty array when it produced none. */
    artifacts: jsonb("artifacts").$type<SharedThreadArtifact[]>().notNull(),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("shared_threads_url_slug_idx").on(t.urlSlug),
    // Serves the owner's "which shares exist for this thread?" list, which the
    // share dialog reads to offer Revoke.
    index("shared_threads_source_thread_idx").on(t.sourceThreadId, t.createdAt),
    index("shared_threads_user_idx").on(t.userId),
  ],
);

export type SharedThread = typeof sharedThreads.$inferSelect;

export type NewSharedThread = typeof sharedThreads.$inferInsert;
