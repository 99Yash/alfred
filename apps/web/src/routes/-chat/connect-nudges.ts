import type { ChatConnectNudge } from "@alfred/contracts";
import type { SyncedChatToolCall } from "@alfred/sync";
import {
  getIntegrationProvider,
  PROVIDER_BACKEND,
  type IntegrationProvider,
  type IntegrationStatus,
} from "~/lib/integrations/integrations";

/**
 * Client side of the connection-health bounce (#378 item 3). When the dispatch
 * floor refuses a tool call because the integration behind it isn't usable,
 * the server attaches the repair to the refusal (`chat.tool` event and the
 * durable tool-call entry); this module turns those payloads into what the
 * chat renders: which provider to fix, what to call the fix, and whether the
 * offer still stands.
 */

/** One rendered repair offer, resolved against the integration catalog. */
export interface ConnectNudgeView {
  /** Stable identity — one offer per integration even after several bounces. */
  integration: string;
  action: "connect" | "reconnect";
  /** Catalog provider id (`google_gmail`), the connect route's param. */
  providerId: string;
  /** Display name (`Gmail`). */
  name: string;
  brand: IntegrationProvider["brand"];
  /** The one-line explanation above the action ("Gmail isn't connected."). */
  line: string;
  /** The primary action label ("Connect Gmail"). */
  cta: string;
}

/**
 * Pull the repair offers out of a persisted turn's tool-call log, deduped by
 * integration in first-appearance order. Everything else in the log is a
 * drawable card and passes through untouched, so callers feed `cards` to the
 * trail exactly as they fed the raw list before — a bounced entry must never
 * draw as a failed step, inflate the run summary, or leak into source
 * extraction.
 */
export function splitPersistedToolCalls(toolCalls: readonly SyncedChatToolCall[]): {
  cards: SyncedChatToolCall[];
  nudges: ChatConnectNudge[];
} {
  const cards: SyncedChatToolCall[] = [];
  const seen = new Set<string>();
  const nudges: ChatConnectNudge[] = [];
  for (const call of toolCalls) {
    if (call.connectNudge === undefined) {
      cards.push(call);
      continue;
    }
    if (!seen.has(call.connectNudge.integration)) {
      seen.add(call.connectNudge.integration);
      nudges.push(call.connectNudge);
    }
  }
  return { cards, nudges };
}

/**
 * Resolve raw offers into renderable views. `statusByProviderId` is the live
 * credential overlay once ready and `undefined` while queries are in flight —
 * matching the mention palette's rule that rows stay stateless during load
 * rather than flash an offer that may already be stale:
 *
 *  - no catalog provider, or no connect backend behind it → no view. There is
 *    no flow to send the user to, so an actionable offer would be dishonest
 *    (the same rule that keeps Slack/Linear out of the composer's nudges).
 *  - already connected → no view. The repair happened; re-offering it would
 *    read as broken even though the bounce was real when it streamed.
 */
export function presentConnectNudges(
  nudges: readonly ChatConnectNudge[],
  statusByProviderId: ReadonlyMap<string, IntegrationStatus> | undefined,
): ConnectNudgeView[] {
  if (statusByProviderId === undefined) return [];
  const views: ConnectNudgeView[] = [];
  for (const nudge of nudges) {
    // Short Google slugs (`calendar`) resolve through the same alias table the
    // mention palette uses; unknown slugs yield no provider and no offer.
    const provider = getIntegrationProvider(nudge.integration);
    if (!provider || !PROVIDER_BACKEND.has(provider.id)) continue;
    if (statusByProviderId.get(provider.id) === "connected") continue;
    views.push({
      integration: nudge.integration,
      action: nudge.action,
      providerId: provider.id,
      name: provider.name,
      brand: provider.brand,
      line:
        nudge.action === "connect"
          ? `${provider.name} isn't connected.`
          : `${provider.name} needs to be reconnected.`,
      cta: `${nudge.action === "connect" ? "Connect" : "Reconnect"} ${provider.name}`,
    });
  }
  return views;
}
