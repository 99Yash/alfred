import type {
  ArtifactContent,
  ArtifactFormat,
  ArtifactKind,
  ArtifactStatus,
} from "@alfred/contracts";
import { index, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

import { createId, lifecycle_dates } from "../helpers";
import { agentRuns } from "./agent";
import { user } from "./auth";
import { chatMessages, chatThreads } from "./chat";

/**
 * One agent-made document or page deck, shown in the chat sidebar (ADR-0075).
 * Each authoring tool call rewrites the row, so pages appear one at a time through Replicache.
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
    threadId: text("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    /** Set null so the artifact outlives a reaped run. */
    runId: text("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    /** The message that shows the artifact card. */
    messageId: text("message_id").references(() => chatMessages.id, { onDelete: "set null" }),
    /** Selects the renderer. */
    kind: text("kind").notNull().$type<ArtifactKind>(),
    /** NULL for `document`. */
    format: text("format").$type<ArtifactFormat>(),
    title: text("title").notNull().default(""),
    status: text("status").notNull().default("generating").$type<ArtifactStatus>(),
    content: jsonb("content").$type<ArtifactContent>(),
    /** Not used yet. Reserved for an R2 blob key. */
    storageKey: text("storage_key"),
    rowVersion: integer("row_version").notNull().default(0),
    ...lifecycle_dates,
  },
  (t) => [
    // Replicache pull window (`recentArtifacts`): user_id filter + created_at DESC,
    // id DESC order, served by a backward scan of these plain columns.
    index("artifacts_user_created_idx").on(t.userId, t.createdAt, t.id),
    index("artifacts_thread_created_idx").on(t.threadId, t.createdAt),
    index("artifacts_run_idx").on(t.runId),
  ],
);

export type Artifact = typeof artifacts.$inferSelect;

export type NewArtifact = typeof artifacts.$inferInsert;

/**
 * One body for each `(artifactId, rowVersion)` (ADR-0130 amendment (g)). Chat admission writes the
 * selected version when a turn context names it and it is not yet stored, so a body is stored one
 * time for each version, not one time for each message. Each write to `artifacts` adds 1 to its
 * `row_version`, so a row here never changes. Server-only.
 */
export const artifactVersions = pgTable(
  "artifact_versions",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    rowVersion: integer("row_version").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    kind: text("kind").notNull().$type<ArtifactKind>(),
    format: text("format").$type<ArtifactFormat>(),
    status: text("status").notNull().$type<ArtifactStatus>(),
    content: jsonb("content").$type<ArtifactContent>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.artifactId, t.rowVersion] })],
);

export type ArtifactVersion = typeof artifactVersions.$inferSelect;

export type NewArtifactVersion = typeof artifactVersions.$inferInsert;
