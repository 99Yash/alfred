/**
 * User settings (ADR-0089). The only gateway to `user_preferences`: bind
 * `settings({ userId })` and read or write through it. Upserts bump `row_version`
 * for Replicache. Also the one read of the user's own addresses and domains:
 * `userIdentity({ userId })`. Import `../settings`, never a file in it.
 */

export { settings, type UserSettings } from "./user-settings";

export { userIdentity, type UserIdentity } from "./user-identity";

export { type PreferenceRow } from "./preferences";

export { parseMemorySourceOrDefault } from "./memory-source";

export { type FeatureFlags } from "./flags";

export {
  type SelfIdentity,
  resolveSelfIdentity,
  webOrigin,
  emailLogoUrl,
  formatSelfIdentityGrounding,
  selfIdentityGrounding,
} from "./self-identity";
