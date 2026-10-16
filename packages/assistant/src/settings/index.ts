/**
 * User settings (ADR-0089). The only gateway to `user_preferences`: bind
 * `settings({ userId })` and read or write through it. Upserts bump `row_version`
 * for Replicache. Import `../settings`, never a file in it.
 */

export { settings, type UserSettings } from "./user-settings";

export { setPreferenceArgsSchema, type PreferenceRow } from "./preferences";

export { type FeatureFlags } from "./flags";

export * from "./self-identity";
