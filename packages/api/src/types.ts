// Domain types derived from Drizzle schema — populated as schema grows
import type { InferSelectModel } from "drizzle-orm";
import type { user, session } from "@alfred/db/schemas";

export type User = InferSelectModel<typeof user>;
export type Session = InferSelectModel<typeof session>;
