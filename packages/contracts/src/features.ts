/**
 * Background-agent feature toggles — the single source of truth for the
 * `feature.*` `user_preferences` keys, shared between the server gates
 * (`resolveFeatureFlags` in `@alfred/assistant`) and the Settings → Features UI so
 * the key strings can never drift between the two sides.
 *
 * Storage is documented in `packages/db/src/schema/memory.ts`. The default a
 * flag takes when its preference row is ABSENT lives here, in
 * {@link FEATURE_FLAG_DEFAULTS}, and both sides resolve a stored value through
 * {@link isFeatureFlagOn} so the switch shows exactly what the gate will run.
 *
 * Two default classes:
 *
 *   - UNSET = ON for the agents that were live before the settings page
 *     existed (briefings, tagging, action items). Shipping the gate was a
 *     no-op until a user flipped a switch — no migration, no backfill.
 *   - UNSET = OFF for an agent that acts outward on the user's behalf. Reply
 *     drafting (ADR-0025 #5) stages outbound mail, so it must never arm itself
 *     for a user who has not opted in. Same posture as the ADR-0074
 *     passthrough toggles (`isPassthroughPreferenceOn`).
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

/**
 * The value a flag resolves to when no preference row exists. Keyed by the
 * stored key (not the id) because both resolvers hold the key at read time.
 */
export const FEATURE_FLAG_DEFAULTS = {
  "feature.morning_briefing": true,
  "feature.evening_recap": true,
  "feature.email_tagging": true,
  "feature.action_items": true,
  "feature.reply_drafting": false,
} as const satisfies Record<FeatureFlagKey, boolean>;

/**
 * Read a stored `feature.*` preference value as an explicit boolean, or `null`
 * when it is absent or in a serialization neither side recognizes. Only the
 * recognized literals (`true`/`"true"`/`1`, `false`/`"false"`/`0`) move a flag
 * away from its default; anything else falls back to {@link FEATURE_FLAG_DEFAULTS}.
 */
function parseFeatureFlagValue(value: unknown): boolean | null {
  if (value === false || value === "false" || value === 0) return false;
  if (value === true || value === "true" || value === 1) return true;
  return null;
}

/**
 * Effective on/off for one flag given its stored value (or `undefined` when no
 * row exists). The one resolver the server gate and the settings switch share,
 * so a default-OFF flag cannot render as armed on one side and dormant on the
 * other.
 */
export function isFeatureFlagOn(key: FeatureFlagKey, value: unknown): boolean {
  return parseFeatureFlagValue(value) ?? FEATURE_FLAG_DEFAULTS[key];
}
