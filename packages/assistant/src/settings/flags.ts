import {
  FEATURE_FLAG_KEYS,
  isFeatureFlagOn,
  type FeatureFlagId,
  type FeatureFlagKey,
} from "@alfred/contracts";
import type { PreferenceRow } from "./preferences";

/**
 * Background-agent toggles from Settings > Features, one boolean per `FEATURE_FLAG_KEYS` entry.
 * Keys and defaults live in `@alfred/contracts`. An unset flag takes its default: ON for most,
 * OFF for `replyDrafting`, which stages mail (ADR-0098; a `manual` run of `reply-drafting`
 * ignores it). Morning and evening share the `daily-briefing` workflow; `briefings/queue.ts`
 * gates each slot. Tagging (Gmail category labels) and action items (`suggested` todos) share
 * one `email-triage` classify call, with separate gated outputs.
 */
export type FeatureFlags = { readonly [Id in FeatureFlagId]: boolean };

/** `rowFor` finds the user's row for a key; an absent row takes the contract default. */
export function featureFlagsFrom(
  rowFor: (key: FeatureFlagKey) => PreferenceRow | undefined,
): FeatureFlags {
  const on = (id: FeatureFlagId) =>
    isFeatureFlagOn(FEATURE_FLAG_KEYS[id], rowFor(FEATURE_FLAG_KEYS[id])?.value);

  return {
    morningBriefing: on("morningBriefing"),
    eveningRecap: on("eveningRecap"),
    emailTagging: on("emailTagging"),
    actionItems: on("actionItems"),
    replyDrafting: on("replyDrafting"),
  };
}
