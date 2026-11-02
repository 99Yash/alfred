import { INTEGRATION_ACTIVITY_TITLE_MAX, type IntegrationActivityItem } from "@alfred/contracts";
import type { ActivityEvent } from "../knowledge";

/**
 * The briefing's words for the activity record (ADR-0118 decision 6). `knowledge` reads the
 * record; this file makes the lines and the actor names that the gather and the composer tools show.
 */

/** The actor as a briefing names it: `you` for the user, else the provider login. */
export function activityActorLabel(actor: ActivityEvent["actor"]): string {
  return actor.kind === "user" ? "you" : (actor.login ?? "someone");
}

/**
 * The key of the actor of one act. It uses the stable identity of the actor, not the label, so two
 * actors with no login do not share a key.
 */
function activityActorKey(actor: ActivityEvent["actor"]): string {
  return actor.kind === "user" ? "user" : `${actor.identity.kind}:${actor.identity.value}`;
}

/**
 * The briefing activity lines of `events`, newest first, at most `max`. All the pushes of one actor
 * to one object in the window are one push group: one line, at the newest push, with a `rollup`
 * count. Other acts can come between two pushes of a group. So a day of pushes does not fill the
 * list.
 */
export function activityItemsOf(
  events: readonly ActivityEvent[],
  max: number,
): IntegrationActivityItem[] {
  const pushGroups = new Map<string, { item: IntegrationActivityItem; count: number }>();
  const items: IntegrationActivityItem[] = [];

  for (const event of events.toReversed()) {
    if (event.source.kind !== "integration") continue;

    const pushGroupKey =
      event.verb === "pushed" && event.object
        ? `${activityActorKey(event.actor)}\u001f${event.object}`
        : null;

    const group = pushGroupKey === null ? undefined : pushGroups.get(pushGroupKey);

    if (group) {
      group.count += 1;
      group.item.rollup = { eventCount: group.count };
      continue;
    }

    if (items.length >= max) continue;
    const objectLabel = event.title ?? event.object ?? event.source.slug;
    const actor = activityActorLabel(event.actor);

    const item: IntegrationActivityItem = {
      id: event.id,
      provider: event.source.slug,
      source: "direct_api",
      activityCategory: "work",
      providerKind: `${event.source.slug}.${event.verb}`,
      title: `${actor} ${event.verb}: ${objectLabel}`.slice(0, INTEGRATION_ACTIVITY_TITLE_MAX),
      severity: "info",
      occurredAt: event.occurredAt.toISOString(),
      ...(event.url ? { url: event.url } : {}),
    };

    items.push(item);

    if (pushGroupKey !== null) pushGroups.set(pushGroupKey, { item, count: 1 });
  }

  return items;
}
