import { FEATURE_FLAG_KEYS, isFeatureFlagOn, type FeatureFlagKey } from "@alfred/contracts";
import { getPreference } from "./preferences";

/**
 * Feature toggles for background agents — the Settings → Features control
 * plane (dimension-style "Background agents" list). The `feature.*` keys, the
 * per-flag default, and the value parser all live in `@alfred/contracts`
 * (`FEATURE_FLAG_DEFAULTS`, `isFeatureFlagOn`) so the UI and these gates share
 * one source of truth.
 *
 * Each switch maps to a `feature.*` boolean key in `user_preferences`. For the
 * four original agents **UNSET means ON**: a user who has never opened the
 * settings page keeps the current default behavior, so shipping those gates
 * was a no-op until someone flipped a switch — no migration, no backfill.
 * `replyDrafting` is the first **UNSET means OFF** flag: it stages outbound
 * mail on the user's behalf, so it arms only on an explicit opt-in.
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
  /**
   * Proactive reply drafting off the triage tail (ADR-0097). Default OFF. A
   * `manual` invocation of the `reply-drafting` workflow ignores this flag.
   */
  replyDrafting: boolean;
}

/** Single flag; the contracts resolver applies the per-key default when the pref row is absent. Module-private —
 * only `resolveFeatureFlags` calls it, so it stays off the settings interface. */
async function getFeatureFlag(userId: string, key: FeatureFlagKey): Promise<boolean> {
  const row = await getPreference(userId, key);
  return isFeatureFlagOn(key, row?.value);
}

/** All background-agent flags for a user in one shot. */
export async function resolveFeatureFlags(userId: string): Promise<FeatureFlags> {
  const [morningBriefing, eveningRecap, emailTagging, actionItems, replyDrafting] =
    await Promise.all([
      getFeatureFlag(userId, FEATURE_FLAG_KEYS.morningBriefing),
      getFeatureFlag(userId, FEATURE_FLAG_KEYS.eveningRecap),
      getFeatureFlag(userId, FEATURE_FLAG_KEYS.emailTagging),
      getFeatureFlag(userId, FEATURE_FLAG_KEYS.actionItems),
      getFeatureFlag(userId, FEATURE_FLAG_KEYS.replyDrafting),
    ]);
  return { morningBriefing, eveningRecap, emailTagging, actionItems, replyDrafting };
}
