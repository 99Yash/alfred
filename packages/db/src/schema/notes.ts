import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { createId, lifecycle_dates } from "../helpers";
import { user } from "./auth";

export const notes = pgTable("notes", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId("note")),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  rowVersion: integer("row_version").notNull().default(0),
  ...lifecycle_dates,
});
