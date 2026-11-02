import {
  assertNever,
  GATHER_PROVENANCE_MAX,
  GATHER_PROVENANCE_TEXT_MAX,
  GATHER_STALE_PROVENANCE_MAX,
  INTEGRATIONS,
  isLiveProviderSlug,
  type BlockingGatherProvenance,
  type GatherInput,
  type GatherProvenance,
  type IanaTimezone,
  type IntegrationActivityItem,
  type IntegrationHealth,
  type LiveProviderSlug,
  type Place,
  type SourceIdentity,
} from "@alfred/contracts";
import { GoogleCredentialSelectionError, type GoogleCredential } from "@alfred/integrations/google";
import { logger } from "@alfred/logging";
import {
  ACTIVITY_DELIVERY_GRACE_MS,
  readIntegrationAvailability,
  type ActivityCoverage,
} from "@alfred/assistant/connections";
import type { EventDeliveryRecovery } from "@alfred/assistant/connections/ingress";
import type {
  GithubMergedReadOutcome,
  VerifiedPullOutcome,
} from "@alfred/assistant/connections/verified-pull";
import type { StatedPlace, UserLocation } from "../knowledge";

/** At least one statement. A producer cannot return an empty list for an input. */
export type StatedProvenance = readonly [GatherProvenance, ...GatherProvenance[]];

/**
 * A gather input's value and the statement of how Alfred got it (ADR-0117 decision 1). The
 * statement is non-empty, and the gather's table is total over `GATHER_INPUTS`, so each input
 * states at least one entry.
 */
export interface Sourced<T> {
  readonly value: T;
  readonly provenance: StatedProvenance;
}

export function live(input: GatherInput): GatherProvenance {
  return { input, state: "live" };
}

export function readFailed(input: GatherInput, reason: string): GatherProvenance {
  return { input, state: "unavailable", cause: "read_failed", reason, recovery: { kind: "retry" } };
}

/** No account for the input. No block row, because a deliberate disconnect leaves the same state. */
function notConnected(input: GatherInput, integration: LiveProviderSlug): GatherProvenance {
  return {
    input,
    state: "unavailable",
    cause: "not_connected",
    reason: `${INTEGRATIONS[integration].displayName} is not connected.`,
    recovery: { kind: "none" },
  };
}

/**
 * Who reads one entry (ADR-0117 decision 2). This is the one owner of that rule.
 *
 * - `blockRow`: the entry as a row in the connection block. The row also stops a quiet morning.
 *   `null`: no row.
 * - `composerFact`: the composer gets the entry as a fact, for an input that the composer reads.
 *   The composer keeps its own list of the inputs that it reads.
 * - `log`: the entry is a line in the operator log.
 */
export interface ProvenanceAudience {
  readonly blockRow: BlockingGatherProvenance | null;
  readonly composerFact: boolean;
  readonly log: boolean;
}

const NO_AUDIENCE: ProvenanceAudience = { blockRow: null, composerFact: false, log: false };

/** A statement that the composer and the operator read, but that is not a block row. */
const FACT_AND_LOG: ProvenanceAudience = { blockRow: null, composerFact: true, log: true };

/** A statement for the operator only. */
const LOG_ONLY: ProvenanceAudience = { blockRow: null, composerFact: false, log: true };

export function provenanceAudience(entry: GatherProvenance): ProvenanceAudience {
  switch (entry.state) {
    case "live":
      return NO_AUDIENCE;
    // No surface can set the replaced fact, so it is not a row.
    case "fallback":
      return FACT_AND_LOG;
    // An old item is not news. Only the activity input states `stale`, and the composer reads that
    // input through `list_activity`, which never returns the old item. So the entry is a log line.
    case "stale":
      return LOG_ONLY;
    case "unavailable":
      switch (entry.cause) {
        // The user can reconnect, so the entry is a row. A `not_delivered` row merges with the
        // delivery alert of the same integration (`listBrokenConnections`).
        case "scope_missing":
        case "needs_reauth":
        case "not_delivered":
          return { blockRow: entry, composerFact: true, log: true };
        case "read_failed":
          return FACT_AND_LOG;
        // The composer says that the source is not connected. No row: a deliberate disconnect
        // leaves the same state (ADR-0100 amendment 2026-10-28, item 3).
        case "not_connected":
          return FACT_AND_LOG;
        case "no_place":
          return FACT_AND_LOG;
        // A past gap or a hole in the record: no reconnect repairs it, but the window is not quiet.
        case "silent":
        case "record_incomplete":
          return FACT_AND_LOG;
        default:
          return assertNever(entry, "unavailable provenance cause");
      }

    default:
      return assertNever(entry, "provenance state");
  }
}

/** The entries that are rows in the connection block. */
export function blockingProvenance(
  provenance: readonly GatherProvenance[],
): BlockingGatherProvenance[] {
  return provenance.flatMap((entry) => {
    const { blockRow } = provenanceAudience(entry);

    return blockRow ? [blockRow] : [];
  });
}

/**
 * A Google credential that does not select. `scope_required`: the account is connected without
 * this input's grant. `connection_required`: no active row. The availability read tells the two
 * cases apart: a row that is not active (`needs_reauth`) is a repair, and no row is the state
 * that a deliberate disconnect leaves (ADR-0100 amendment 2026-10-28, item 3).
 */
export async function googleSelectionProvenance(
  userId: string,
  input: GatherInput,
  integration: LiveProviderSlug,
  err: GoogleCredentialSelectionError,
): Promise<GatherProvenance> {
  const name = INTEGRATIONS[integration].displayName;

  switch (err.reason) {
    case "scope_required":
      return {
        input,
        state: "unavailable",
        cause: "scope_missing",
        reason: `${name} is connected, but without the permission that Alfred needs to read it.`,
        recovery: { kind: "connect", integration },
      };
    case "connection_required":
      return connectionRequiredProvenance(userId, input, integration);
    default:
      return assertNever(err.reason, "Google credential selection reason");
  }
}

async function connectionRequiredProvenance(
  userId: string,
  input: GatherInput,
  integration: LiveProviderSlug,
): Promise<GatherProvenance> {
  let health: IntegrationHealth | null;

  try {
    const snapshot = await readIntegrationAvailability(userId);

    health = snapshot.integrations.get(integration)?.health ?? null;
  } catch (err) {
    logger.warn({ err, userId, integration }, "[briefing.gather] availability read failed");

    return readFailed(
      input,
      `Alfred could not check the ${INTEGRATIONS[integration].displayName} connection.`,
    );
  }

  switch (health) {
    case null:
      return notConnected(input, integration);
    case "needs_reauth":
      return {
        input,
        state: "unavailable",
        cause: "needs_reauth",
        reason: `${INTEGRATIONS[integration].displayName} is connected, but its sign-in no longer works.`,
        recovery: { kind: "connect", integration },
      };
    // A row became active between the two reads. The next run reads it.
    case "active":
      return readFailed(
        input,
        `The ${INTEGRATIONS[integration].displayName} connection changed during the read.`,
      );
    default:
      return assertNever(health, "integration health");
  }
}

/**
 * The email input reads `email_triage`, not Gmail. A failed `email_triage` read throws and fails
 * the gather: the row is `failed`, the watermark does not move, and the next run reads the same
 * window. A stored email statement therefore always follows a completed read. A gather that
 * continued past a failed read would send or suppress, and so move the watermark past mail that
 * it never read.
 *
 * The statement then says whether the source that fills that table can read mail: a Gmail account
 * that selects. A delivery break is not part of it: the history poll still runs, and
 * `broken_connections` carries that fact (ADR-0100 amendment 2026-10-28, revision to item 1). A
 * fault of the credential check is `read_failed`, because Alfred cannot say whether the triaged
 * mail is current. That check must not fail the gather that it describes.
 */
export async function emailProvenance(
  userId: string,
  readCredential: () => Promise<GoogleCredential>,
): Promise<GatherProvenance> {
  try {
    await readCredential();

    return live("email");
  } catch (err) {
    if (err instanceof GoogleCredentialSelectionError) {
      return googleSelectionProvenance(userId, "email", "gmail", err);
    }

    logger.warn({ err, userId }, "[briefing.gather] Gmail credential read failed");

    return readFailed(
      "email",
      "Alfred could not check the Gmail account that fills the email list.",
    );
  }
}

/** `no_connection` is the miss; every other status but `completed` is a fault of the read. */
export function githubMergedProvenance(outcome: GithubMergedReadOutcome): GatherProvenance {
  switch (outcome.status) {
    case "completed":
      return live("github_merged");
    case "no_connection":
      return notConnected("github_merged", "github");
    case "truncated":
      return readFailed("github_merged", "The merged pull request read hit its bounds.");
    case "bad_shape":
      return readFailed(
        "github_merged",
        "The merged pull request read returned an unreadable result.",
      );
    case "failed":
      return readFailed("github_merged", "The merged pull request read failed.");
    default:
      return assertNever(outcome, "GitHub merged read status");
  }
}

/**
 * The verified pull's activity lines and their statement. A pull that faulted is `read_failed`,
 * because its empty list does not prove that nothing changed.
 *
 * An item is stale only when its time is the provider's event time and that time is before the
 * window start. Such an item is real but not news: it leaves the list, and its statement goes to
 * the log (ADR-0117 decision 2). A `delivered` or `observed` time is Alfred's clock, not the
 * event's, so it cannot prove that the event is old, and the item stays. An unreadable time stays
 * for the same reason.
 */
export function splitVerifiedPullActivity(
  outcomes: readonly VerifiedPullOutcome[],
  windowStart: Date,
): Sourced<IntegrationActivityItem[]> {
  const fresh: IntegrationActivityItem[] = [];
  const stale: GatherProvenance[] = [];
  const failed: string[] = [];

  for (const outcome of outcomes) {
    if (outcome.status === "failed") {
      failed.push(INTEGRATIONS[outcome.provider].displayName);
      continue;
    }

    for (const { item, clock } of outcome.items) {
      const occurredAt = Date.parse(item.occurredAt);

      if (
        clock !== "provider_event" ||
        Number.isNaN(occurredAt) ||
        occurredAt >= windowStart.getTime()
      ) {
        fresh.push(item);
        continue;
      }

      stale.push({
        input: "integration_activity",
        state: "stale",
        title: item.title,
        occurredAt: item.occurredAt,
        recovery: { kind: "none" },
      });
    }
  }

  const read: GatherProvenance =
    failed.length === 0
      ? live("integration_activity")
      : readFailed(
          "integration_activity",
          `The live deploy status read failed for ${failed.join(", ")}.`,
        );

  return { value: fresh, provenance: [read, ...stale] };
}

type CoverageFailure = Extract<ActivityCoverage, { state: "unavailable" }>["failure"];

type SilentCoverageFailure = Extract<CoverageFailure, { cause: "silent" }>;

/**
 * What the activity record says about the activity input (ADR-0118 decision 4, in the ADR-0117
 * vocabulary). One entry for each source with a reducer, as of the gather.
 *
 * A source with no reducer (`no_record`: a `tools_only` or `live` source) is one log line for all
 * such sources, not a stored entry, so the list stays inside `GATHER_PROVENANCE_MAX`. The record
 * never held events from such a source, so the briefing does not lose a read that it had before.
 *
 * A silence is the one case that the record cannot settle by itself: GitHub may have had nothing
 * to send, or its deliveries may have stopped. `reconcileSilence` asks the GitHub merged read,
 * which does not depend on a delivery. The merged read covers the same window as the record.
 */
export function activityRecordProvenance(args: {
  userId: string;
  coverage: readonly ActivityCoverage[];
  githubMerged: GithubMergedReadOutcome;
  /** The coverage's "now". A merge younger than the delivery grace can still be in the queue. */
  now: Date;
}): GatherProvenance[] {
  const { userId, coverage, githubMerged, now } = args;
  const noRecord: string[] = [];
  const entries: GatherProvenance[] = [];

  for (const entry of coverage) {
    if (entry.state === "live") {
      entries.push(live("integration_activity"));
      continue;
    }

    const { source, failure } = entry;

    if (failure.cause === "no_record") {
      noRecord.push(sourceName(source));
      continue;
    }

    entries.push(coverageFailureProvenance({ userId, source, failure, githubMerged, now }));
  }

  if (noRecord.length > 0) {
    logger.info(
      { userId, sources: noRecord },
      "[briefing.gather] activity record holds no events from these sources",
    );
  }

  return entries;
}

function coverageFailureProvenance(args: {
  userId: string;
  source: SourceIdentity;
  failure: Exclude<CoverageFailure, { cause: "no_record" }>;
  githubMerged: GithubMergedReadOutcome;
  now: Date;
}): GatherProvenance {
  const { userId, source, failure, githubMerged, now } = args;
  const name = sourceName(source);

  switch (failure.cause) {
    case "record_incomplete":
      return {
        input: "integration_activity",
        state: "unavailable",
        cause: "record_incomplete",
        reason: provenanceText(
          `${failure.acts} ${name} events reached Alfred, but the activity record does not hold them.`,
        ),
        recovery: { kind: "none" },
      };
    case "silent":
      return reconcileSilence({
        userId,
        name,
        failure,
        integration: failure.integration,
        githubMerged,
        now,
      });
    // `Omit` over the delivery union does not keep the pairs, so the recovery is read again.
    case "never_connected": {
      const integration = connectSlug(failure.recovery);

      return integration
        ? notConnected("integration_activity", integration)
        : silent(notReaching(name, failure.reason));
    }

    case "broken": {
      const integration = connectSlug(failure.recovery);

      if (integration) return notDelivered(integration, notReaching(name, failure.reason));

      return failure.recovery.kind === "retry"
        ? readFailed(
            "integration_activity",
            provenanceText(`Alfred could not check whether ${name} events reach it.`),
          )
        : silent(notReaching(name, failure.reason));
    }

    case "unknown":
      return silent(
        provenanceText(`Alfred cannot tell whether ${name} events reach it: ${failure.reason}.`),
      );
    default:
      return assertNever(failure, "activity coverage failure");
  }
}

/** The integration that the user can connect to repair a failure, when it is a live provider. */
function connectSlug(recovery: EventDeliveryRecovery): LiveProviderSlug | null {
  return recovery.kind === "connect" && isLiveProviderSlug(recovery.integration)
    ? recovery.integration
    : null;
}

function notReaching(name: string, reason: string): string {
  return provenanceText(`${name} events do not reach Alfred: ${reason}.`);
}

/**
 * A delivery gap longer than the source's bound. The merged read (`is:pr is:merged author:@me`)
 * is a provider call, so it sees a merge whose delivery never came. It covers the briefing window,
 * so the part of a gap before the window start is not checked: an act from then is not in the
 * window either. A merge younger than the delivery grace does not count, because its delivery
 * can still be in the queue.
 *
 * - The read holds a merge in the gap: GitHub had an event to send, and it did not arrive. When
 *   the gap reaches now, the user can reconnect, so the entry is a block row. A past gap cannot
 *   be repaired now, so the entry is `silent`.
 * - The read holds every merge of the window, and none is in the gap: the user did nothing that
 *   the read can see, for example on a weekend. The source counts as live, and the operator log
 *   keeps the gap.
 * - The read did not complete, or it holds only one page of the merges and none of them is in the
 *   gap: Alfred cannot tell the two cases apart, so the window is not quiet.
 *
 * The read sees only the user's own merges, so a silence with other acts but no merge reads as a
 * quiet window. That is the residual risk of ADR-0118 slice 3.
 *
 * `integration` is `"github"` because the merged read is a GitHub read. A second activity source
 * does not compile here until it has its own read.
 */
function reconcileSilence(args: {
  userId: string;
  name: string;
  failure: SilentCoverageFailure;
  integration: "github";
  githubMerged: GithubMergedReadOutcome;
  now: Date;
}): GatherProvenance {
  const { userId, name, failure, integration, githubMerged, now } = args;
  const { gap } = failure;
  const reachesNow = failure.recovery.kind === "connect";

  const noDelivery = reachesNow
    ? gap.from
      ? `No ${name} event has reached Alfred since ${gap.from.toISOString()}`
      : `No ${name} event has reached Alfred in this window`
    : gap.from
      ? `No ${name} event reached Alfred from ${gap.from.toISOString()} to ${gap.to.toISOString()}`
      : `No ${name} event reached Alfred before ${gap.to.toISOString()}`;

  const unconfirmed = silent(
    provenanceText(
      `${noDelivery}, and Alfred could not confirm whether ${name} had anything to send.`,
    ),
  );

  if (githubMerged.status !== "completed") return unconfirmed;

  const { items, total } = githubMerged.read;
  const settled = now.getTime() - ACTIVITY_DELIVERY_GRACE_MS;

  const missed = items.filter((item) => {
    const at = item.mergedAt.getTime();

    return (gap.from === null || at > gap.from.getTime()) && at < gap.to.getTime() && at <= settled;
  }).length;

  if (missed === 0) {
    if (items.length < total) return unconfirmed;

    logger.info(
      { userId, source: name, gapFrom: gap.from, gapTo: gap.to },
      "[briefing.gather] activity silence reconciled as no events: the merged read found no merge",
    );

    return live("integration_activity");
  }

  const reason = provenanceText(
    `${noDelivery}, but ${missed} of the user's pull requests merged in that time.`,
  );

  return reachesNow && isLiveProviderSlug(integration)
    ? notDelivered(integration, reason)
    : silent(reason);
}

function silent(reason: string): GatherProvenance {
  return {
    input: "integration_activity",
    state: "unavailable",
    cause: "silent",
    reason,
    recovery: { kind: "none" },
  };
}

function notDelivered(integration: LiveProviderSlug, reason: string): GatherProvenance {
  return {
    input: "integration_activity",
    state: "unavailable",
    cause: "not_delivered",
    reason,
    recovery: { kind: "connect", integration },
  };
}

function sourceName(source: SourceIdentity): string {
  return source.kind === "integration"
    ? INTEGRATIONS[source.slug].displayName
    : `the custom MCP server ${source.serverId}`;
}

/**
 * One input's statement from several producers. A `live` entry says only that its producer read
 * the source, so it drops when another producer states a gap: the gap is what the readers act on.
 * When every producer read its source, one `live` entry stays.
 */
export function mergeInputProvenance(
  input: GatherInput,
  entries: readonly GatherProvenance[],
): StatedProvenance {
  const [first, ...rest] = entries.filter((entry) => entry.state !== "live");

  return first === undefined ? [live(input)] : [first, ...rest];
}

/**
 * The stored list, inside `GATHER_PROVENANCE_MAX`. Every entry that is not `stale` stays, then the
 * stale entries up to `GATHER_STALE_PROVENANCE_MAX`. A drop is a log line, so a long list cannot
 * fail the parse of the stored gather.
 */
export function boundProvenance(
  userId: string,
  provenance: readonly GatherProvenance[],
): GatherProvenance[] {
  const stated = provenance.filter((entry) => entry.state !== "stale");
  const stale = provenance.filter((entry) => entry.state === "stale");
  const kept = [...stated, ...stale.slice(0, GATHER_STALE_PROVENANCE_MAX)];
  const dropped = provenance.length - Math.min(kept.length, GATHER_PROVENANCE_MAX);

  if (dropped > 0) {
    logger.warn(
      { userId, dropped, stated: stated.length, stale: stale.length },
      "[briefing.gather] provenance over its bound; extra entries dropped",
    );
  }

  return kept.slice(0, GATHER_PROVENANCE_MAX);
}

/**
 * Write each entry that `provenanceAudience` gives to the log. The block rule and the composer
 * read the stored list; the log is for the operator (ADR-0117 decision 2).
 */
export function logProvenance(userId: string, provenance: readonly GatherProvenance[]): void {
  const logged = provenance.filter((entry) => provenanceAudience(entry).log);

  if (logged.length === 0) return;

  logger.info({ userId, provenance: logged }, "[briefing.gather] inputs not live");
}

/** A statement that Alfred used a default in place of a user fact. */
export type FallbackProvenance = Extract<GatherProvenance, { state: "fallback" }>;

/**
 * The warnings `fallback` entry, or `undefined` when the warnings are for the user's place. An
 * entry says that Alfred read the feeds for the default city of the time zone (`used`), not for a
 * place that the user gave. `placeProvenance` writes it, and the stored list keeps it, because
 * `boundProvenance` drops only `stale` entries. A gather from before the provenance field has no
 * list, so it has no entry.
 */
export function officialWarningsFallback(
  provenance: readonly GatherProvenance[] | undefined,
): FallbackProvenance | undefined {
  return provenance?.find(
    (entry): entry is FallbackProvenance =>
      entry.input === "official_warnings" && entry.state === "fallback",
  );
}

/** The inputs that read the user's place. */
export type PlaceInput = Extract<GatherInput, "weather" | "official_warnings">;

/** How the fallback statement opens, for each input that reads the place. */
const FALLBACK_SUBJECT = {
  weather: "The weather is for",
  official_warnings: "Official warnings were checked for",
} as const satisfies Record<PlaceInput, string>;

/**
 * What the place read says about an input that reads the place, before the input's own read
 * (ADR-0117 decision 3). `place: null`: no read, and `statement` is the whole statement.
 * Otherwise the input reads `place`, and `statement` is the `fallback` entry that goes beside the
 * read, or `null` for the user's own place.
 *
 * - `fault`: `read_failed` with `retry`. A failed fact read or geocode is temporary, so Alfred
 *   does not put a default city in place of the user's place.
 * - `none`: `no_place`. Alfred has no place, and the zone has no default city.
 * - `timezone_default`: `fallback` with recovery `none`. No surface can set the city yet.
 */
export function placeProvenance(
  input: PlaceInput,
  located: UserLocation,
  timezone: IanaTimezone,
):
  | { readonly place: null; readonly statement: GatherProvenance }
  | { readonly place: Place; readonly statement: FallbackProvenance | null } {
  switch (located.basis) {
    case "preference":
    case "home_fact":
    case "location_fact":
      return { place: located.place, statement: null };
    case "timezone_default":
      return {
        place: located.place,
        statement: {
          input,
          state: "fallback",
          used: provenanceText(located.place.label),
          reason: provenanceText(
            `${FALLBACK_SUBJECT[input]} ${located.place.label}, the default city for the time zone ${timezone}. ${noUserPlaceSentence(located.unplaced)}`,
          ),
          recovery: { kind: "none" },
        },
      };
    case "none":
      return {
        place: null,
        statement: {
          input,
          state: "unavailable",
          cause: "no_place",
          reason: provenanceText(
            `${noUserPlaceSentence(located.unplaced)} The time zone ${timezone} has no default city.`,
          ),
          recovery: { kind: "none" },
        },
      };
    case "fault":
      return {
        place: null,
        statement: readFailed(
          input,
          provenanceText(
            located.step === "fact_read"
              ? "Alfred could not read the facts that give the user's place."
              : `Alfred could not look up the place of the confirmed ${STATED_PLACE_NAME[located.stated.key]} "${located.stated.text}".`,
          ),
        ),
      };
    default:
      return assertNever(located, "user location basis");
  }
}

/**
 * The warnings statement (ADR-0117 decision 4), at most two entries, after the feed reads:
 *
 * 1. The place: the `fallback` entry of a default city, or else `no_place` when Alfred read only
 *    GDACS for the user's place. `coverageGap` is that sentence. A fallback wins over the gap: the
 *    default city is not the user's place, so its feed coverage says nothing about the user, and
 *    the fallback already says that the briefing may miss warnings for the user's area. So each
 *    entry is one statement, and no statement joins two sentences that could pass the bound.
 * 2. `read_failed` with `retry`, when a feed or a part of it could not be read. `failures` names
 *    each one.
 *
 * With neither, the input is `live`. A place `fault` or `none` reads no feed, so its statement
 * comes from `placeProvenance` alone and does not pass here.
 */
export function officialWarningsProvenance(args: {
  fallback: FallbackProvenance | null;
  coverageGap: string | null;
  failures: readonly string[];
}): StatedProvenance {
  const { fallback, coverageGap, failures } = args;
  const entries: GatherProvenance[] = [];

  if (fallback !== null) {
    entries.push(fallback);
  } else if (coverageGap !== null) {
    entries.push({
      input: "official_warnings",
      state: "unavailable",
      cause: "no_place",
      reason: provenanceText(coverageGap),
      recovery: { kind: "none" },
    });
  }

  if (failures.length > 0)
    entries.push(readFailed("official_warnings", provenanceText(failures.join(" "))));

  const [first, ...rest] = entries;

  return first === undefined ? [live("official_warnings")] : [first, ...rest];
}

const STATED_PLACE_NAME = {
  home_city: "home city",
  location: "location",
} as const satisfies Record<StatedPlace["key"], string>;

/**
 * Why the weather does not use the user's own place. A confirmed fact that the geocode did not
 * match is a different fact from no fact: the default won over a confirmed fact (decision 3).
 */
function noUserPlaceSentence(unplaced: StatedPlace | null): string {
  return unplaced === null
    ? "Alfred knows no place for the user."
    : `Alfred could not place the confirmed ${STATED_PLACE_NAME[unplaced.key]} "${unplaced.text}".`;
}

/**
 * Longest name that a provenance sentence holds (a place label). Each sentence that holds one name
 * has fewer than `GATHER_PROVENANCE_TEXT_MAX - PROVENANCE_NAME_MAX` fixed characters, so the name
 * is cut, and the sentence is not. The place reader keeps a fact inside `PLACE_TEXT_MAX` (100), so
 * only a long `location` preference label meets this cut.
 */
const PROVENANCE_NAME_MAX = 100;

/** A name for a provenance sentence, inside `PROVENANCE_NAME_MAX`. */
export function provenanceName(name: string): string {
  return clip(name, PROVENANCE_NAME_MAX);
}

/**
 * A sentence inside `GATHER_PROVENANCE_TEXT_MAX`, so a long name cannot fail the parse of the
 * stored gather. The place reader keeps a fact inside `PLACE_TEXT_MAX`, so the cut is a backstop.
 */
function provenanceText(text: string): string {
  return clip(text, GATHER_PROVENANCE_TEXT_MAX);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}
