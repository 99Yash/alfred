import { FEATURE_FLAG_KEYS, isFeatureFlagOn, type FeatureFlagKey } from "@alfred/contracts";
import { getPreference } from "./preferences";

/**
 * Background-agent toggles from Settings > Features. Keys and defaults live in `@alfred/contracts`.
 * An unset flag takes its default: ON for most, OFF for `replyDrafting`, which stages mail.
 * Morning and evening share the `daily-briefing` workflow; `briefings/queue.ts` gates each slot.
 * Tagging and action items share one `email-triage` classify call, with separate gated outputs.
 */
export interface FeatureFlags {
  morningBriefing: boolean;
  eveningRecap: boolean;
  /** Gmail category labels. */
  emailTagging: boolean;
  /** `suggested` todos from triage. */
  actionItems: boolean;
  /** ADR-0098. A `manual` run of `reply-drafting` ignores this flag. */
  replyDrafting: boolean;
}

async function getFeatureFlag(userId: string, key: FeatureFlagKey): Promise<boolean> {
  const row = await getPreference(userId, key);

  return isFeatureFlagOn(key, row?.value);
}

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
