import type {
  ArtifactContent,
  ArtifactFormat,
  ArtifactKind,
  ArtifactStatus,
} from "@alfred/contracts";
import { index, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";

import { createId, lifecycle_dates } from "../helpers";
import { agentRuns } from "./agent";
import { user } from "./auth";
import { chatMessages, chatThreads } from "./chat";

/**
 * Agent-produced artifacts (ADR-0075). One row is one artifact — a document or
 * a deck/PDF of pages — authored by the boss via the `system.create_artifact` /
 * `append_artifact_page` / `update_artifact` tools and rendered inline in the
 * chat's artifact sidebar. Content lives here (Postgres) and syncs to the web
 * via Replicache; the chat `chat.tool` event only signals "open the sidebar".
 *
 * Like `chat_messages`, the durable row is written by the chat worker as it
 * authors — each authoring tool call rewrites the row and bumps `row_version`,
 * so the sidebar sees pages appear via pokes (page-granular "streaming"; there
 * is no token-level stream in v1). Deleting the message/thread/user cascades.
 */
export const artifacts = pgTable(
  "artifacts",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("art")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** The chat thread that produced this artifact. */
    threadId: text("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    /** The agent run that authored it (audit/replay); kept if the run is reaped. */
    runId: text("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    /**
     * The assistant message that authored it — drives the in-message trigger
     * card. Kept (set null) if the message is somehow removed without the thread.
     */
    messageId: text("message_id").references(() => chatMessages.id, { onDelete: "set null" }),
    /** `document` | `pages` | `spreadsheet` (reserved). Selects the renderer. */
    kind: text("kind").notNull().$type<ArtifactKind>(),
    /** For `pages`: `slides` | `pdf`. Null for `document`. */
    format: text("format").$type<ArtifactFormat>(),
    title: text("title").notNull().default(""),
    /** `generating` while the boss authors, `complete` on turn end, `error` on failure. */
    status: text("status").notNull().default("generating").$type<ArtifactStatus>(),
    /** The artifact body (markdown or ordered HTML pages), discriminated by `kind`. */
    content: jsonb("content").$type<ArtifactContent>(),
    /**
     * R2 object key for heavy binary (ADR-0065 infra) — unused in v1 (content is
     * Postgres-only); the column is the seam for when an artifact needs a blob.
     */
    storageKey: text("storage_key"),
    /** Replicache row-version. Bumped on every content/status change. */
    rowVersion: integer("row_version").notNull().default(0),
    ...lifecycle_dates,
  },
  (t) => [
    index("artifacts_user_idx").on(t.userId),
    index("artifacts_thread_created_idx").on(t.threadId, t.createdAt),
    index("artifacts_run_idx").on(t.runId),
  ],
);

export type Artifact = typeof artifacts.$inferSelect;
export type NewArtifact = typeof artifacts.$inferInsert;
