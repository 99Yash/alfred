/**
 * User settings (ADR-0089 module interface).
 *
 * `setPreference` / `getPreference` / `getPreferences` / `deletePreference`
 * are the single gateway to the `user_preferences` table — explicit,
 * user-driven settings (tone, timezone, feature flags, briefing hours).
 * Last-write-wins upserts that bump `row_version` so Replicache patches
 * reflect changes; every read returns a `PreferenceRow` whose `source` is a
 * validated `MemorySource`.
 *
 * Cross-module callers import this interface (`../settings`), never the
 * `./preferences` leaf.
 */

export * from "./preferences";
export * from "./flags";
