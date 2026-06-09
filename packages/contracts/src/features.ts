/**
 * Background-agent feature toggles — the single source of truth for the
 * `feature.*` `user_preferences` keys, shared between the server gates
 * (`resolveFeatureFlags` in `@alfred/api`) and the Settings → Features UI so
 * the key strings can never drift between the two sides.
 *
 * Storage + semantics (UNSET = ON) are documented in
 * `packages/db/src/schema/memory.ts`.
 */
export const FEATURE_FLAG_KEYS = {
  morningBriefing: "feature.morning_briefing",
  eveningRecap: "feature.evening_recap",
  emailTagging: "feature.email_tagging",
  actionItems: "feature.action_items",
} as const;

export type FeatureFlagId = keyof typeof FEATURE_FLAG_KEYS;
export type FeatureFlagKey = (typeof FEATURE_FLAG_KEYS)[FeatureFlagId];

export const FEATURE_FLAG_KEY_LIST: readonly FeatureFlagKey[] = Object.values(FEATURE_FLAG_KEYS);
