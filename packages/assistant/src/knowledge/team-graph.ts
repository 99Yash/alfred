/**
 * Passive team-graph capture (ADR-0059 P4a). Scans ingested Gmail `documents`
 * into the legacy `entities` graph: one contact per correspondent (kind from
 * `classifyContactKind`, #1108), one `organization` per non-consumer sender
 * domain, then a significance pass. Headers only, no LLM.
 *
 * No edge is written: a `works_at` from `person@domain` only restates `From:`.
 * The injected Gmail sender adapter (ADR-0089) already dropped service mail;
 * cold versus warm is the significance signal's job, not an exclusion.
 */
import {
  isFreeMail,
  isRecord,
  type GmailCorrespondentsObservation,
  type PersonToken,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents } from "@alfred/db/schemas";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  previewContactKinds,
  upsertContactByAlias,
  upsertEntity,
  type ContactPreviewCandidate,
  type UpsertContactByAliasArgs,
} from "./entity-graph";
import type { DbTransaction } from "@alfred/db";
import {
  listEvidenceCodes,
  type GmailPayloadSignals,
  type ListEvidenceCode,
} from "./entity-kind-classifier";
import { type CorrespondenceStats, parsePersonEntityMetadata } from "./entity-metadata";
import { gmailPayloadSignalsFromHeaders } from "./gmail-reducer";
import { computeSignificance, loadUserDomains, runSignificancePass } from "./significance";

/** Per-contact accumulator, keyed by lowercased address. */
export interface ContactAggregate {
  address: string;
  domain: string | null;
  /** Longest person-looking display name seen. */
  displayName: string | null;
  inbound: number;
  outbound: number;
  coRecipient: number;
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
  /** List-header codes from mail this contact sent the user (#1198). */
  listEvidence: Set<ListEvidenceCode>;
}

/** Gmail `payload.headers` alone, so a scan never loads bodies. Persisted provider data, so `unknown`. */
export const gmailRawHeadersColumn = sql<unknown>`${documents.raw} -> 'payload' -> 'headers'`;

function touch(
  map: Map<string, ContactAggregate>,
  person: PersonToken,
  field: "inbound" | "outbound" | "coRecipient",
  authoredAt: Date | null,
  listEvidence: readonly ListEvidenceCode[] = [],
): void {
  let agg = map.get(person.address);

  if (!agg) {
    agg = {
      address: person.address,
      domain: person.domain,
      displayName: person.displayName,
      inbound: 0,
      outbound: 0,
      coRecipient: 0,
      firstSeenAt: null,
      lastSeenAt: null,
      listEvidence: new Set(),
    };
    map.set(person.address, agg);
  }

  agg[field] += 1;

  for (const code of listEvidence) agg.listEvidence.add(code);

  if (
    person.displayName &&
    (!agg.displayName || person.displayName.length > agg.displayName.length)
  ) {
    agg.displayName = person.displayName;
  }

  if (authoredAt) {
    if (!agg.firstSeenAt || authoredAt < agg.firstSeenAt) agg.firstSeenAt = authoredAt;

    if (!agg.lastSeenAt || authoredAt > agg.lastSeenAt) agg.lastSeenAt = authoredAt;
  }
}

function toStats(agg: ContactAggregate): CorrespondenceStats {
  return {
    inbound: agg.inbound,
    outbound: agg.outbound,
    coRecipient: agg.coRecipient,
    firstSeenAt: agg.firstSeenAt ? agg.firstSeenAt.toISOString() : null,
    lastSeenAt: agg.lastSeenAt ? agg.lastSeenAt.toISOString() : null,
  };
}

/**
 * Add one document's header contributions to a contacts map. Shared by the
 * backfill and the daily capture. `self` is skipped, so the user is never a contact.
 * `isSent` ignores labelIds, unlike fact-policy's authorship check.
 * `signals` land only on the `From:` contact of a received message (#1198).
 */
export function accumulateDoc(
  contacts: Map<string, ContactAggregate>,
  observation: GmailCorrespondentsObservation,
  authoredAt: Date | null,
  self: string,
  signals: GmailPayloadSignals = {},
): void {
  const { isSent, from, recipients } = observation;

  if (isSent) {
    for (const p of recipients) {
      if (p.address !== self) touch(contacts, p, "outbound", authoredAt);
    }
  } else {
    if (from && from.address !== self) {
      touch(contacts, from, "inbound", authoredAt, listEvidenceCodes([signals]));
    }

    for (const p of recipients) {
      if (p.address !== self) touch(contacts, p, "coRecipient", authoredAt);
    }
  }
}

function minIso(a: string | null, b: string | null): string | null {
  if (!a) return b;

  if (!b) return a;

  return a < b ? a : b;
}

function maxIso(a: string | null, b: string | null): string | null {
  if (!a) return b;

  if (!b) return a;

  return a > b ? a : b;
}

/** Add a run's delta onto the prior aggregate. */
function mergeStats(
  prior: CorrespondenceStats | undefined,
  delta: ContactAggregate,
): CorrespondenceStats {
  const d = toStats(delta);

  return {
    inbound: (prior?.inbound ?? 0) + d.inbound,
    outbound: (prior?.outbound ?? 0) + d.outbound,
    coRecipient: (prior?.coRecipient ?? 0) + d.coRecipient,
    firstSeenAt: minIso(prior?.firstSeenAt ?? null, d.firstSeenAt),
    lastSeenAt: maxIso(prior?.lastSeenAt ?? null, d.lastSeenAt),
  };
}

/**
 * The `buildMetadata` shared by the writer and the dry preview. The aggregate
 * follows `mode`, but list evidence only grows (#1198): a capped or incremental
 * scan can miss bulk mail and must not flip the kind back. `userHasWrittenTo`
 * is sticky for the same reason.
 */
function contactMetadataBuilder(
  agg: ContactAggregate,
  mode: "merge" | "overwrite",
): UpsertContactByAliasArgs["buildMetadata"] {
  return (prior) => {
    const priorMeta = parsePersonEntityMetadata(prior);
    const stats = mode === "merge" ? mergeStats(priorMeta.correspondence, agg) : toStats(agg);

    const listEvidence = [
      ...new Set([...(priorMeta.listEvidence ?? []), ...agg.listEvidence]),
    ].sort();

    const userHasWrittenTo =
      priorMeta.userHasWrittenTo === true ||
      (priorMeta.correspondence?.outbound ?? 0) > 0 ||
      stats.outbound > 0;

    return {
      primaryAddress: agg.address,
      domain: agg.domain,
      correspondence: stats,
      ...(listEvidence.length > 0 ? { listEvidence } : {}),
      ...(userHasWrittenTo ? { userHasWrittenTo } : {}),
    };
  };
}

export interface ApplyIncrementsResult {
  contacts: number;
  organizations: number;
  /** Contacts filed as something other than `person` (#1108). */
  nonPersonContacts: number;
  /** Re-kinds the unique index refused, counted from rows actually written. */
  reKindBlocked: number;
}

/** Non-consumer sender domains with at least one contact. */
function collectOrgDomains(contacts: Map<string, ContactAggregate>): Set<string> {
  const orgDomains = new Set<string>();

  for (const agg of contacts.values()) {
    if (agg.domain && !isFreeMail(agg.domain)) orgDomains.add(agg.domain);
  }

  return orgDomains;
}

/**
 * Persist contacts onto `entities`, matched by alias. `"merge"` adds the delta
 * (the caller must pass only uncaptured docs); `"overwrite"` replaces it, so a
 * re-run converges. Pass `tx` to commit with the caller's capture marker.
 */
async function persistContacts(
  userId: string,
  contacts: Map<string, ContactAggregate>,
  mode: "merge" | "overwrite",
  tx?: DbTransaction,
): Promise<ApplyIncrementsResult> {
  if (contacts.size === 0)
    return { contacts: 0, organizations: 0, nonPersonContacts: 0, reKindBlocked: 0 };

  const orgDomains = collectOrgDomains(contacts);

  for (const domain of orgDomains) {
    await upsertEntity(
      {
        userId,
        kind: "organization",
        canonicalName: domain,
        aliases: [domain],
        metadata: { domain },
      },
      tx,
    );
  }

  let nonPersonContacts = 0;
  let reKindBlocked = 0;

  for (const agg of contacts.values()) {
    // Match by email alias, so a drifted display name lands on the same row.
    const { row, reKindBlocked: blocked } = await upsertContactByAlias(
      {
        userId,
        address: agg.address,
        aliases: [agg.address],
        // Only a new contact takes this display name.
        canonicalNameIfNew: agg.displayName ?? agg.address,
        buildMetadata: contactMetadataBuilder(agg, mode),
      },
      tx,
    );

    if (blocked) reKindBlocked += 1;

    if (row.kind !== "person") nonPersonContacts += 1;
  }

  return {
    contacts: contacts.size,
    organizations: orgDomains.size,
    nonPersonContacts,
    reKindBlocked,
  };
}

/**
 * Increment each contact's aggregate (daily capture). Not safe to re-run over the
 * same delta. Pass `tx` to commit with the `captured_into_graph_at` stamp.
 */
export async function applyCorrespondenceIncrements(
  userId: string,
  contacts: Map<string, ContactAggregate>,
  tx?: DbTransaction,
): Promise<ApplyIncrementsResult> {
  return persistContacts(userId, contacts, "merge", tx);
}

export interface BackfillTeamGraphOpts {
  /** False (default) is a dry run. */
  commit?: boolean;
  /** Max `documents` scanned, newest first. Default 5000. */
  maxDocs?: number;
  /** For the significance recency decay. Defaults to wall clock. */
  now?: Date;
}

export interface BackfillTeamGraphResult {
  docsScanned: number;
  contacts: number;
  organizations: number;
  /** Contacts filed as something other than `person` (#1108). */
  nonPersonContacts: number;
  /** Re-kinds refused by the unique index. Exact when `persisted`, else an estimate. */
  reKindBlocked: number;
  persisted: boolean;
  top: Array<{
    name: string;
    address: string;
    inbound: number;
    outbound: number;
    score: number;
  }>;
}

/** Aggregate `documents` into a per-contact map. Read-only. */
export async function aggregateCorrespondence(
  userId: string,
  userEmail: string,
  parse: (metadata: unknown) => GmailCorrespondentsObservation,
  maxDocs = 5000,
): Promise<{ contacts: Map<string, ContactAggregate>; docsScanned: number }> {
  const self = userEmail.trim().toLowerCase();

  const rows = await db()
    .select({
      authoredAt: documents.authoredAt,
      metadata: documents.metadata,
      headers: gmailRawHeadersColumn,
    })
    .from(documents)
    .where(and(eq(documents.userId, userId), eq(documents.source, "gmail")))
    .orderBy(desc(documents.authoredAt))
    .limit(maxDocs);

  const contacts = new Map<string, ContactAggregate>();

  for (const row of rows) {
    if (!isRecord(row.metadata)) continue;
    accumulateDoc(
      contacts,
      parse(row.metadata),
      row.authoredAt ?? null,
      self,
      gmailPayloadSignalsFromHeaders(row.headers),
    );
  }

  return { contacts, docsScanned: rows.length };
}

/** Backfill the team graph (ADR-0059 P4a). Dry run by default. Idempotent. */
export async function backfillTeamGraph(
  userId: string,
  userEmail: string,
  parse: (metadata: unknown) => GmailCorrespondentsObservation,
  opts: BackfillTeamGraphOpts = {},
): Promise<BackfillTeamGraphResult> {
  const commit = opts.commit ?? false;
  const now = opts.now ?? new Date();
  const userDomains = await loadUserDomains(userId);

  const { contacts, docsScanned } = await aggregateCorrespondence(
    userId,
    userEmail,
    parse,
    opts.maxDocs ?? 5000,
  );

  if (commit) {
    // Overwrite with the scan, then score. Same writer as the incremental path.
    const applied = await persistContacts(userId, contacts, "overwrite");
    const pass = await runSignificancePass(userId, { now, userDomains, commit: true });
    const scoreByAddr = new Map(pass.top.map((t) => [t.address ?? "", t.score]));

    return {
      docsScanned,
      contacts: contacts.size,
      organizations: applied.organizations,
      nonPersonContacts: applied.nonPersonContacts,
      reKindBlocked: applied.reKindBlocked,
      persisted: true,
      top: rankTop(contacts, (addr) => scoreByAddr.get(addr) ?? null, now, userDomains),
    };
  }

  // Dry run: compute significance in memory for the ranking.
  const orgDomains = collectOrgDomains(contacts);
  let nonPersonContacts = 0;

  // Preview the kind a real write would produce. `blockedEstimate` and
  // `nonPersonContacts` can differ from a commit in either direction.
  const {
    kinds,
    unclassifiable,
    blockedEstimate: reKindBlocked,
  } = await previewContactKinds(
    userId,
    new Map<string, ContactPreviewCandidate>(
      [...contacts.values()].map((agg): [string, ContactPreviewCandidate] => [
        agg.address,
        {
          displayName: agg.displayName ?? undefined,
          buildMetadata: contactMetadataBuilder(agg, "overwrite"),
        },
      ]),
    ),
  );

  // Unclassifiable contacts are not counted as non-persons.
  void unclassifiable;

  for (const agg of contacts.values()) {
    // A missing key leaves the contact uncounted.
    const kind = kinds.get(agg.address);

    if (kind !== undefined && kind !== "person") nonPersonContacts += 1;
  }

  return {
    docsScanned,
    contacts: contacts.size,
    organizations: orgDomains.size,
    nonPersonContacts,
    reKindBlocked,
    persisted: false,
    top: rankTop(contacts, () => null, now, userDomains),
  };
}

/** Top N by significance; computes in memory when no score is stored. */
function rankTop(
  contacts: Map<string, ContactAggregate>,
  persistedScore: (address: string) => number | null,
  now: Date,
  userDomains: Set<string>,
): BackfillTeamGraphResult["top"] {
  const ranked = [...contacts.values()].map((agg) => {
    const persisted = persistedScore(agg.address);

    const score =
      persisted ??
      computeSignificance({
        stats: toStats(agg),
        sameOrg: agg.domain ? userDomains.has(agg.domain) : false,
        now,
      }).score;

    return {
      name: agg.displayName ?? agg.address,
      address: agg.address,
      inbound: agg.inbound,
      outbound: agg.outbound,
      score,
    };
  });

  ranked.sort((a, b) => b.score - a.score);

  return ranked.slice(0, 15);
}
