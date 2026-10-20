import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { SealedCredentialSecret } from "../credential-vault";
import { createId, lifecycle_dates } from "../helpers";

export const user = pgTable("user", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId("usr")),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  onboardedAt: timestamp("onboarded_at", { withTimezone: true }),
  ...lifecycle_dates,
});

export const session = pgTable("session", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId("ses")),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  ...lifecycle_dates,
});

/**
 * Better Auth's account table. The token columns hold sealed envelopes.
 * `encryptedAuthAdapter` in `@alfred/auth` seals on write and opens on read.
 * Better Auth does not read these Drizzle types, so the {@link SealedCredentialSecret}
 * brand only governs Alfred's own Drizzle reads and writes, as on `integration_credentials`.
 */
export const account = pgTable("account", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId("acc")),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token").$type<SealedCredentialSecret>(),
  refreshToken: text("refresh_token").$type<SealedCredentialSecret>(),
  idToken: text("id_token").$type<SealedCredentialSecret>(),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  ...lifecycle_dates,
});

export const verification = pgTable("verification", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId("ver")),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ...lifecycle_dates,
});

export type User = typeof user.$inferSelect;

export type Session = typeof session.$inferSelect;

export type Account = typeof account.$inferSelect;

export type Verification = typeof verification.$inferSelect;
