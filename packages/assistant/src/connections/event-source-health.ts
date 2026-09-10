/**
 * Every event source's delivery health for one user (#976, ADR-0097 item 5,
 * ADR-0100).
 *
 * It sits in `connections/`, beside the credential rows and the ingestion state
 * that every verdict is read from, and not in `automation/`, where its first
 * reader lives. Two readers want it now: workflow trigger readiness, and the
 * inbound delivery alert that rides the integration-status read. `automation ->
 * connections` is an edge the module graph already carries, and the reverse is
 * not, so a fold placed in `automation/` would have forced the alert reader to
 * fold a strict subset of the sources instead. That subset is exactly how
 * Gmail's lapsed watch went unread.
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
 * Delivery health for one event source, at the grain its `EVENT_SOURCE_ENTRIES`
 * entry declares (#976).
 *
 * - `source`: one verdict per user.
 * - `account`: `healthOf(row)` answers for one connected account of
 *   `accounts.integration`. It is a function of the row, not a map keyed by
 *   account id, so the resolver's lookup cannot miss: the resolver selects the
 *   row from the same credential rows the reader received, and a row the
 *   reader never saw still gets that reader's verdict for "no delivery state".
 *
 * The grain sits on the value, so the reader of the map handles both; a
 * `(source, accountRef)` key would need a sentinel ref for every source-grain
 * entry.
 */
export type EventSourceHealth =
  | { grain: "source"; health: EventDeliveryHealth }
  | {
      grain: "account";
      accounts: EventDeliveryAccounts;
      healthOf(row: ProviderAvailability): EventDeliveryHealth;
    };

/** One entry per `EventSource`, as `readEventSourceHealth` fills it. */
export type EventSourceHealthMap = Readonly<Record<EventSource, EventSourceHealth>>;

/** Read one account's delivery verdict from the state the reader gathered. */
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
 * What the reader table may hold for one in-process source, decided by the
 * grain its entry declares. `healthy_by_construction` is the explicit claim
 * that this process publishes the source's events and there is no subscription
 * to lose; it is only admissible at source grain, and every in-process source
 * must claim one of the shapes, so a new source with a watch that can lapse
 * cannot read healthy by omission.
 */
type InProcessHealthReader<S extends InProcessEventSource> =
  // Distributive on purpose: `InProcessHealthReader<InProcessEventSource>` must be
  // the union of each source's own admissible shapes, not one shape for the union.
  S extends InProcessEventSource
    ? EventSourceEntryOf<S>["delivery"]["grain"] extends "account"
      ? { grain: "account"; accounts: EventDeliveryAccounts; read: AccountDeliveryHealthReader }
      : { grain: "source"; read: SourceDeliveryHealthReader } | "healthy_by_construction"
    : never;

function accountGrain<S extends AccountGrainEventSource & InProcessEventSource>(
  source: S,
  read: AccountDeliveryHealthReader,
): InProcessHealthReader<S> {
  // SAFETY: `S` is constrained to account-grain sources, so the conditional
  // resolves to the account arm; TypeScript does not reduce it while `S` is a parameter.
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

/**
 * One delivery-health entry per `EventSource` for one user (#976, ADR-0097
 * item 5). Inbound sources come from their descriptors' `subscription.health`
 * at source grain; in-process sources come from the reader table above. A new
 * inbound source appears here with its descriptor and no edit to readiness; a
 * new in-process source does not compile until the table names its reader.
 */
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
  // SAFETY: `Object.fromEntries` types its keys as `string`; the pairs are built
  // from EVENT_SOURCES, so the keys are exactly EventSource.
  return Object.fromEntries(entries) as Record<EventSource, EventSourceHealth>;
}

/**
 * The rows an account-grain source may deliver from: the ones that prove its
 * integration connected (ADR-0093's rule, {@link credentialSatisfies}).
 *
 * One helper for both readers of {@link EventSourceHealthMap}. Workflow
 * readiness asks which row a trigger's `accountRef` resolves against; the
 * delivery alert asks every row whose delivery could have stopped. A second
 * copy of the filter would let one surface count a row the other ignores.
 */
export function eventDeliveryRows(
  rows: CredentialRowsByProvider,
  accounts: EventDeliveryAccounts,
): ProviderAvailability[] {
  return (rows.get(accounts.provider) ?? []).filter((row) =>
    credentialSatisfies(accounts.credential, row),
  );
}
