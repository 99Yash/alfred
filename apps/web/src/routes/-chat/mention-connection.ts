import { isCatalogSlug, isPlannedSlug } from "@alfred/contracts";
import { useMemo } from "react";
import type { IntegrationStatus } from "~/lib/integrations/integrations";
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

/**
 * Answers "how does this mention value stand relative to the user's real
 * connections?" for any mention value, including ids outside `MENTION_OPTIONS`
 * (a stale chip's id). Produced by {@link useMentionConnections} and consumed
 * by the palette rows, the pick handler, and stale-chip rendering so all three
 * answer through one rule.
 */
export type MentionConnectionLookup = (value: string) => MentionConnection;

/**
 * Classify one mention value against resolved provider statuses. Pure so the
 * palette rows, the pick handler, and stale-chip rendering all answer through
 * one rule; the hook below just feeds it.
 */
export function classifyMentionValue(
  value: string,
  statusBySlug: ReadonlyMap<string, IntegrationStatus>,
): MentionConnection {
  if (!isCatalogSlug(value)) return "internal";
  // A planned provider has no credential store → no way to connect from
  // anywhere, so an always-"not connected" nudge would be dishonest. Matches
  // how `ConnectToolsBar` scopes its nudges to live providers.
  if (isPlannedSlug(value)) return "unavailable";
  return statusBySlug.get(value) === "connected" ? "connected" : "connectable";
}

/** Connection state for every mention option, plus whether state is settled. */
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
    // The lookup owns the unknown-value rule ("an unknown id is internal, not
    // a phantom nudge") so no call site re-defaults with its own fallback.
    return (value: string) => map.get(value) ?? "internal";
  }, [integrations, ready]);
}
