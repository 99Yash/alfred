/**
 * `feature.*` preference keys, shared by the server gate and the settings page.
 * A flag that sends anything outward, such as reply drafting, is off until the user turns it on.
 */
export const FEATURE_FLAG_KEYS = {
  morningBriefing: "feature.morning_briefing",
  eveningRecap: "feature.evening_recap",
  emailTagging: "feature.email_tagging",
  actionItems: "feature.action_items",
  replyDrafting: "feature.reply_drafting",
} as const;

export type FeatureFlagId = keyof typeof FEATURE_FLAG_KEYS;

export type FeatureFlagKey = (typeof FEATURE_FLAG_KEYS)[FeatureFlagId];

export const FEATURE_FLAG_KEY_LIST: readonly FeatureFlagKey[] = Object.values(FEATURE_FLAG_KEYS);

/** The value when no preference row exists. */
export const FEATURE_FLAG_DEFAULTS = {
  "feature.morning_briefing": true,
  "feature.evening_recap": true,
  "feature.email_tagging": true,
  "feature.action_items": true,
  "feature.reply_drafting": false,
} as const satisfies Record<FeatureFlagKey, boolean>;

/** `null` for anything other than `true`/`"true"`/`1` or `false`/`"false"`/`0`. */
function parseFeatureFlagValue(value: unknown): boolean | null {
  if (value === false || value === "false" || value === 0) return false;

  if (value === true || value === "true" || value === 1) return true;

  return null;
}

/** The server gate and the settings switch both use this, so they always agree. */
export function isFeatureFlagOn(key: FeatureFlagKey, value: unknown): boolean {
  return parseFeatureFlagValue(value) ?? FEATURE_FLAG_DEFAULTS[key];
}
