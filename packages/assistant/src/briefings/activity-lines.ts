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
 * The briefing activity line of one event, or of one run of pushes. A run of pushes by one actor
 * to one object is one line with a `rollup` count, so a day of pushes does not fill the list.
 */
export function activityItemsOf(
  events: readonly ActivityEvent[],
  max: number,
): IntegrationActivityItem[] {
  const newest = [...events].reverse();
  const pushRuns = new Map<string, { item: IntegrationActivityItem; count: number }>();
  const items: IntegrationActivityItem[] = [];

  for (const event of newest) {
    if (event.source.kind !== "integration") continue;
    const actor = activityActorLabel(event.actor);

    if (event.verb === "pushed" && event.object) {
      const key = `${actor}\u001f${event.object}`;
      const run = pushRuns.get(key);

      if (run) {
        run.count += 1;
        run.item.rollup = { eventCount: run.count };
        continue;
      }
    }

    if (items.length >= max) continue;
    const objectLabel = event.title ?? event.object ?? event.source.slug;

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

    if (event.verb === "pushed" && event.object) {
      pushRuns.set(`${actor}\u001f${event.object}`, { item, count: 1 });
    }
  }

  return items;
}
