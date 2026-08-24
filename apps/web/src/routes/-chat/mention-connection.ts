import { useMemo } from "react";
import { getIntegrationProvider, PROVIDER_BACKEND } from "~/lib/integrations/integrations";
import { useResolvedIntegrationsWithReady } from "~/lib/integrations/use-integration-status";
import { MENTION_OPTIONS } from "./mention-options";

/**
 * How a mentionable source stands relative to the user's real connections.
 * `@`-mentions stay prompt hints, not tool gates (ADR-0053) — this only
 * drives what the palette shows and whether picking a row offers a connect
 * CTA instead of silently inserting a chip the model can't act on.
 */
export type MentionConnection =
  /** No integration behind it (web search, memory, notes) — always usable. */
  | "internal"
  /** An integration whose backend reports an active credential. */
  | "connected"
  /** A real backend exists but nothing is connected yet — connectable. */
  | "connectable"
  /** Catalog-only provider with no connect flow yet (Slack, Linear). */
  | "unavailable"
  /** Credential queries are still in flight — render rows stateless. */
  | "loading";

export type MentionConnectionMap = ReadonlyMap<string, MentionConnection>;

/** What {@link useMentionConnections} hands the composer and palette. */
export interface MentionConnections {
  connections: MentionConnectionMap;
}

/**
 * Classify one mention value against resolved provider statuses. Pure so the
 * palette rows, the pick handler, and stale-chip rendering all answer through
 * one rule; the hook below just feeds it.
 */
export function classifyMentionValue(
  value: string,
  statusByProviderId: ReadonlyMap<string, string>,
): MentionConnection {
  const provider = getIntegrationProvider(value);
  if (!provider) return "internal";
  // No credential route family → no way to connect from anywhere, so an
  // always-"not connected" nudge would be dishonest. Matches how
  // `ConnectToolsBar` scopes its nudges to providers with a backend.
  if (!PROVIDER_BACKEND.has(provider.id)) return "unavailable";
  return statusByProviderId.get(provider.id) === "connected" ? "connected" : "connectable";
}

/** Connection state for every mention option, plus whether state is settled. */
export function useMentionConnections(): MentionConnections {
  const { integrations, ready } = useResolvedIntegrationsWithReady();
  return useMemo(() => {
    const statusByProviderId = new Map(integrations.map((p) => [p.id, p.status]));
    const map = new Map<string, MentionConnection>(
      MENTION_OPTIONS.map((option) => [
        option.value,
        ready ? classifyMentionValue(option.value, statusByProviderId) : "loading",
      ]),
    );
    return { connections: map };
  }, [integrations, ready]);
}
