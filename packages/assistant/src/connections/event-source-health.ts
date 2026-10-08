/**
 * Delivery health for every event source of one user (#976, ADR-0097 item 5, ADR-0100).
 * Lives in `connections/` so both readiness and the delivery alert can import it.
 */

import {
  credentialSatisfies,
  EVENT_SOURCES,
  eventDeliveryAccounts,
  isInboundEventSource,
  type AccountGrainEventSource,
  type CredentialRowsByProvider,
  type EventDeliveryAccounts,
  type EventSource,
  type EventSourceEntryOf,
  type InProcessEventSource,
  type ProviderAvailability,
} from "@alfred/contracts";
import { readGmailEventHealth } from "./ingestion/gmail-event-health";
import { readInboundTriggerHealth } from "./ingress/health";
import type { EventDeliveryHealth } from "./ingress/descriptor";

/**
 * Health at the grain the source's entry declares.
 * `healthOf` is a function of the row, not a map by account id, so a lookup cannot miss.
 */
export type EventSourceHealth =
  | { grain: "source"; health: EventDeliveryHealth }
  | {
      grain: "account";
      accounts: EventDeliveryAccounts;
      healthOf(row: ProviderAvailability): EventDeliveryHealth;
    };

export type EventSourceHealthMap = Readonly<Record<EventSource, EventSourceHealth>>;

export type AccountDeliveryHealthReader = (
  userId: string,
  rows: CredentialRowsByProvider,
  now: Date,
) => Promise<(row: ProviderAvailability) => EventDeliveryHealth>;

type SourceDeliveryHealthReader = (
  userId: string,
  rows: CredentialRowsByProvider,
  now: Date,
) => Promise<EventDeliveryHealth>;

/**
 * `healthy_by_construction`: this process publishes the events, so nothing can lapse.
 * Only allowed at source grain. Every in-process source must pick a shape.
 */
type InProcessHealthReader<S extends InProcessEventSource> =
  // Distributive on purpose: a union of per-source shapes.
  S extends InProcessEventSource
    ? EventSourceEntryOf<S>["delivery"]["grain"] extends "account"
      ? { grain: "account"; accounts: EventDeliveryAccounts; read: AccountDeliveryHealthReader }
      : { grain: "source"; read: SourceDeliveryHealthReader } | "healthy_by_construction"
    : never;

function accountGrain<S extends AccountGrainEventSource & InProcessEventSource>(
  source: S,
  read: AccountDeliveryHealthReader,
): InProcessHealthReader<S> {
  // SAFETY: `S` is account-grain, so this is the account arm; TS cannot reduce a generic conditional.
  return {
    grain: "account",
    accounts: eventDeliveryAccounts(source),
    read,
  } as InProcessHealthReader<S>;
}

const IN_PROCESS_HEALTH = {
  gmail: accountGrain("gmail", readGmailEventHealth),
  "google.oauth.callback": "healthy_by_construction",
  "learn-skill": "healthy_by_construction",
  "email-triage": "healthy_by_construction",
} satisfies { readonly [S in InProcessEventSource]: InProcessHealthReader<S> };

function inProcessReader(
  source: InProcessEventSource,
): InProcessHealthReader<InProcessEventSource> {
  return IN_PROCESS_HEALTH[source];
}

const HEALTHY: EventDeliveryHealth = { healthy: true };

/** Inbound sources read their descriptor; in-process sources read `IN_PROCESS_HEALTH`. */
export async function readEventSourceHealth(
  userId: string,
  rows: CredentialRowsByProvider,
  now: Date,
): Promise<EventSourceHealthMap> {
  const inbound = readInboundTriggerHealth(userId, rows);

  const entries = await Promise.all(
    EVENT_SOURCES.map(async (source): Promise<[EventSource, EventSourceHealth]> => {
      if (isInboundEventSource(source)) {
        return [source, { grain: "source", health: (await inbound)[source] }];
      }

      const reader = inProcessReader(source);

      if (reader === "healthy_by_construction")
        return [source, { grain: "source", health: HEALTHY }];

      if (reader.grain === "account") {
        const healthOf = await reader.read(userId, rows, now);

        return [source, { grain: "account", accounts: reader.accounts, healthOf }];
      }

      return [source, { grain: "source", health: await reader.read(userId, rows, now) }];
    }),
  );

  // SAFETY: the keys come from EVENT_SOURCES.
  return Object.fromEntries(entries) as Record<EventSource, EventSourceHealth>;
}

/** Rows that pass the connected rule (ADR-0093). Readiness and alerts share it, so they count the same rows. */
export function eventDeliveryRows(
  rows: CredentialRowsByProvider,
  accounts: EventDeliveryAccounts,
): ProviderAvailability[] {
  return (rows.get(accounts.provider) ?? []).filter((row) =>
    credentialSatisfies(accounts.credential, row),
  );
}
