import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { lifecycle_dates } from "../helpers";
import { user } from "./auth";

export const replicacheClientGroup = pgTable("replicache_client_group", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  cvrVersion: integer("cvr_version").notNull().default(0),
  ...lifecycle_dates,
});

export const replicacheClient = pgTable(
  "replicache_client",
  {
    id: text("id").primaryKey(),
    clientGroupId: text("client_group_id")
      .notNull()
      .references(() => replicacheClientGroup.id, { onDelete: "cascade" }),
    lastMutationId: integer("last_mutation_id").notNull().default(0),
    lastModified: timestamp("last_modified", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("replicache_client_group_idx").on(t.clientGroupId)],
);

export type ReplicacheClientGroup = typeof replicacheClientGroup.$inferSelect;
export type ReplicacheClient = typeof replicacheClient.$inferSelect;
