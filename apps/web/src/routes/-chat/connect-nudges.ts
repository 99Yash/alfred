import {
  isLiveProviderSlug,
  type ChatConnectNudge,
  type LiveProviderSlug,
} from "@alfred/contracts";
import type { SyncedChatToolCall } from "@alfred/sync";
import {
  integrationPage,
  type IntegrationPage,
  type IntegrationStatus,
} from "~/lib/integrations/integrations";

// Connection-health bounce, client side (#378 item 3): turn the server's repair payloads into chat views.

/** One repair offer, resolved against the integration catalog. */
export interface ConnectNudgeView {
  /** One offer per integration, even after several bounces. */
  integration: string;
  action: ChatConnectNudge["action"];
  /** The connect route's param (`gmail`). */
  slug: LiveProviderSlug;
  name: string;
  brand: IntegrationPage["brand"];
  /** "Gmail isn't connected." */
  line: string;
  /** "Connect Gmail" */
  cta: string;
}

export interface PersistedToolCallSplit {
  cards: SyncedChatToolCall[];
  nudges: ChatConnectNudge[];
}

/**
 * Split a persisted turn into cards and repair offers, deduped like the live stream:
 * first-appearance order, last offer wins. A bounce must never draw as a failed step.
 */
export function splitPersistedToolCalls(
  toolCalls: readonly SyncedChatToolCall[],
): PersistedToolCallSplit {
  const cards: SyncedChatToolCall[] = [];
  const offers = new Map<string, ChatConnectNudge>();

  for (const call of toolCalls) {
    if (call.connectNudge === undefined) {
      cards.push(call);
      continue;
    }

    // A bounce whose repair no longer parses: neither card nor offer.
    if (call.connectNudge === null) continue;
    offers.set(call.connectNudge.integration, call.connectNudge);
  }

  return { cards, nudges: [...offers.values()] };
}

/**
 * Resolve offers into views. `statusBySlug` is `undefined` while loading, so no stale offer flashes.
 * No view for a provider with no connect flow, or one already connected again.
 */
export function presentConnectNudges(
  nudges: readonly ChatConnectNudge[],
  statusBySlug: ReadonlyMap<string, IntegrationStatus> | undefined,
): ConnectNudgeView[] {
  if (statusBySlug === undefined) return [];
  const views: ConnectNudgeView[] = [];

  for (const nudge of nudges) {
    const slug = nudge.integration;

    if (!isLiveProviderSlug(slug)) continue;

    if (statusBySlug.get(slug) === "connected") continue;
    const { name, brand } = integrationPage(slug);
    views.push({
      integration: slug,
      action: nudge.action,
      slug,
      name,
      brand,
      line:
        nudge.action === "connect"
          ? `${name} isn't connected.`
          : `${name} needs to be reconnected.`,
      cta: `${nudge.action === "connect" ? "Connect" : "Reconnect"} ${name}`,
    });
  }

  return views;
}
