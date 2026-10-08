import { isCatalogSlug, isPlannedSlug } from "@alfred/contracts";
import { useMemo } from "react";
import type { IntegrationStatus } from "~/lib/integrations/integrations";
import { useResolvedIntegrationsWithReady } from "~/lib/integrations/use-integration-status";
import { MENTION_OPTIONS } from "./mention-options";

/**
 * A mention source against the user's connections. Mentions are hints, not tool gates (ADR-0053).
 * Drives the palette and whether a pick offers a connect prompt.
 */
export type MentionConnection =
  /** No integration behind it (web search, memory, notes). */
  | "internal"
  | "connected"
  /** A backend exists but nothing is connected. */
  | "connectable"
  /** No connect flow yet (Slack, Linear). */
  | "unavailable"
  /** Credentials still loading; render rows stateless. */
  | "loading";

/** For any value, including a stale chip's id outside `MENTION_OPTIONS`. */
export type MentionConnectionLookup = (value: string) => MentionConnection;

/** Pure, so palette rows, picks, and stale chips share one rule. */
export function classifyMentionValue(
  value: string,
  statusBySlug: ReadonlyMap<string, IntegrationStatus>,
): MentionConnection {
  if (!isCatalogSlug(value)) return "internal";

  // A planned provider has no connect flow, so do not nudge. Same scope as `ConnectToolsBar`.
  if (isPlannedSlug(value)) return "unavailable";

  return statusBySlug.get(value) === "connected" ? "connected" : "connectable";
}

export function useMentionConnections(): MentionConnectionLookup {
  const { integrations, ready } = useResolvedIntegrationsWithReady();

  return useMemo(() => {
    const statusBySlug = new Map(integrations.map((p) => [p.slug, p.status]));

    const map = new Map<string, MentionConnection>(
      MENTION_OPTIONS.map((option) => [
        option.value,
        ready ? classifyMentionValue(option.value, statusBySlug) : "loading",
      ]),
    );

    // An unknown id is internal, so call sites need no fallback.
    return (value: string) => map.get(value) ?? "internal";
  }, [integrations, ready]);
}
