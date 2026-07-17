import { FEATURE_FLAG_KEYS, type FeatureFlagKey } from "@alfred/contracts";
import { getPreference } from "../memory/preferences";

/**
 * Feature toggles for background agents — the Settings → Features control
 * plane (dimension-style "Background agents" list). The `feature.*` keys
 * themselves live in `@alfred/contracts` so the UI and these gates share one
 * source of truth.
 *
 * Each switch maps to a `feature.*` boolean key in `user_preferences`.
 * **UNSET means ON**: a user who has never opened the settings page keeps
 * the current default behavior, so shipping these gates is a no-op until
 * someone flips a switch — no migration, no backfill.
 *
 * The dimension UI implies six independent switches, but Alfred's backend
 * doesn't model them 1:1. Two entanglements the gates resolve:
 *
 *   - **Morning vs evening briefing** share one workflow (`daily-briefing`,
 *     `slot` param). Gated per-slot in `briefing/queue.ts` `handleTick`, not
 *     via `workflows.status`.
 *   - **Email tagging vs action items** share the `email-triage` classify
 *     step: one classify call, two independently-gated outputs — the Gmail
 *     label (apply-label step) and the todo suggestion (classify step).
 */
export interface FeatureFlags {
  /** Morning briefing email. */
  morningBriefing: boolean;
  /** Evening recap email (same workflow as morning, `slot: 'evening'`). */
  eveningRecap: boolean;
  /** Write Gmail category labels on inbound mail. */
  emailTagging: boolean;
  /** Mint `suggested` todos off triage classification. */
  actionItems: boolean;
}

/**
 * Coerce a stored pref value to a boolean. UNSET (the `null` row passed by
 * callers) and any non-false value resolve to ON; only an explicit `false`
 * (or its tolerated string/number serializations) turns the agent off.
 */
function flagOn(value: unknown): boolean {
  if (value === false || value === "false" || value === 0) return false;
  return true;
}

/** Single flag; defaults to ON when the pref row is absent. */
export async function getFeatureFlag(userId: string, key: FeatureFlagKey): Promise<boolean> {
  const row = await getPreference(userId, key);
  return row ? flagOn(row.value) : true;
}

/** All background-agent flags for a user in one shot. */
export async function resolveFeatureFlags(userId: string): Promise<FeatureFlags> {
  const [morningBriefing, eveningRecap, emailTagging, actionItems] = await Promise.all([
    getFeatureFlag(userId, FEATURE_FLAG_KEYS.morningBriefing),
    getFeatureFlag(userId, FEATURE_FLAG_KEYS.eveningRecap),
    getFeatureFlag(userId, FEATURE_FLAG_KEYS.emailTagging),
    getFeatureFlag(userId, FEATURE_FLAG_KEYS.actionItems),
  ]);
  return { morningBriefing, eveningRecap, emailTagging, actionItems };
}
