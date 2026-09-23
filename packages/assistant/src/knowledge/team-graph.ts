/**
 * Passive team-graph capture — backfill (ADR-0059 P4a).
 *
 * The missing extractor behind "prod `entities` = 0". Scans the user's
 * already-ingested mail (`documents`, `source='gmail'`) and populates the
 * `entities` graph the Sender-relationship resolver and `isKnownContact`
 * read:
 *   - one contact entity per correspondent (email in `aliases`, so
 *     `isKnownContact` matches; correspondence aggregate in `metadata`). The
 *     kind comes from `classifyContactKind`, applied by the writer to the
 *     row's stored canonical name and stored list-header evidence
 *     (`metadata.listEvidence`, #1198), so a non-human envelope or a bulk
 *     sender is filed as `other` instead of `person` (#1108). The dry run below previews that
 *     same bar through `previewContactKinds`, which shares the classifier
 *     and the alias predicate with the writer,
 *   - one `organization` entity per non-consumer sender domain,
 *   - a first significance pass over the result.
 *
 * **No edge is written.** A `works_at` edge minted from `person@domain` only
 * restates the `From:` header, so the writer that minted one is gone (#1108).
 * A GROUNDED `works_at` — read out of a signature block or an introduction —
 * belongs to the ADR-0067 `entity_edges` table, not to this legacy graph.
 *
 * **Header-level only, no LLM.** Direction (inbound/outbound) and reciprocity
 * come straight from `from`/`to`/`cc` + the `isSent` flag. Job *title*
 * (`theirDesignation`) is NOT in headers — it waits on web-search enrichment
 * (P4b); the resolver degrades to `null` until then.
 *
 * **Scope:** v1 reads `documents` only. Calendar is not yet ingested into
 * `documents` (no `gcal` persist path), so attendee edges are deferred to when
 * that lands — an honest limit, not a silent gap.
 *
 * Person inclusion is decided upstream in the injected Gmail sender adapter
 * (ADR-0089): it keys off triage's header classification (`fromKind ===
 * 'person'`) plus the human-rescue, so real humans — including cold one-way
 * senders — arrive here as `PersonToken`s while `noreply`/notification/role/
 * service envelopes are already dropped. This module only aggregates the
 * observation; the cold-vs-warm distinction is then made by the *significance*
 * signal (reciprocity + frequency), not by excluding the entity.
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

/** Per-contact accumulator built during the scan, keyed by lowercased address. */
export interface ContactAggregate {
  address: string;
  domain: string | null;
  /** Best (longest) person-looking display name seen across messages. */
  displayName: string | null;
  inbound: number;
  outbound: number;
  coRecipient: number;
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
  /**
   * List-header evidence codes carried by mail this contact SENT the user
   * (#1198). Only the `From:` of a received message earns it: the headers
   * describe the sender's message, not its recipients.
   */
  listEvidence: Set<ListEvidenceCode>;
}

/**
 * The raw Gmail `payload.headers` array of a `documents` row, selected alone so
 * a scan never loads message bodies. `unknown`: persisted provider data, read
 * by {@link gmailPayloadSignalsFromHeaders}.
 */
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

  // Keep the richest display name (longest non-empty).
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
 * Accumulate ONE document's header contributions into a contacts map. The pure
 * per-doc core shared by the from-scratch backfill scan and the daily
 * incremental capture (ADR-0059 P4a). Consumes an already-parsed
 * `GmailCorrespondentsObservation` (ADR-0089) — the `From:`/`To:`/`Cc:` parse
 * and the human-rescue happen in the injected triage adapter, not here. `self`
 * is the user's own lowercased address — skipped so the user never becomes
 * their own contact.
 *
 * `observation.isSent` is `meta.isSent === true` only (labelIds ignored) — the
 * deliberate divergence from fact-policy's authorship signal.
 *
 * `signals` are the document's list/bulk headers
 * ({@link gmailPayloadSignalsFromHeaders}). They land on the `From:` contact of
 * a received message only (#1198); an omitted argument records none.
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

/** Add a per-run delta onto a contact's prior correspondence aggregate (increment, not overwrite). */
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
 * The `buildMetadata` a contact write applies, shared by the committing writer
 * and the dry preview so the preview classifies the bag a commit would store.
 *
 * The correspondence aggregate follows `mode` (see {@link persistContacts}).
 * The list-header evidence does NOT: both modes UNION the scan's codes onto the
 * stored set and never drop one (#1198). An overwrite scan is capped to the
 * newest `maxDocs` documents, and an incremental run sees only new ones, so a
 * run that happens to miss the sender's bulk mail must not erase the evidence
 * and flip the kind back. Grow-only keeps the stored set a stable input.
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

    return {
      primaryAddress: agg.address,
      domain: agg.domain,
      correspondence: stats,
      ...(listEvidence.length > 0 ? { listEvidence } : {}),
    };
  };
}

export interface ApplyIncrementsResult {
  contacts: number;
  organizations: number;
  /** Contacts the kind bar filed as something other than `person` (#1108). */
  nonPersonContacts: number;
  /**
   * Wanted re-kinds the unique index refused — kept the current kind (#1108).
   * EXACT: counted from the rows the committer actually wrote.
   */
  reKindBlocked: number;
}

/** Non-consumer sender domains worth an organization node (≥1 contact). */
function collectOrgDomains(contacts: Map<string, ContactAggregate>): Set<string> {
  const orgDomains = new Set<string>();

  for (const agg of contacts.values()) {
    if (agg.domain && !isFreeMail(agg.domain)) orgDomains.add(agg.domain);
  }

  return orgDomains;
}

/**
 * Persist a contacts map onto the `entities` graph. Shared
 * by the daily incremental capture and the from-scratch backfill; the only
 * difference is how each contact's correspondence aggregate combines with what
 * is already stored:
 *   - `"merge"` (incremental) — ADD the delta onto the prior aggregate. The
 *     CALLER guarantees idempotency by passing only un-captured docs.
 *   - `"overwrite"` (backfill) — REPLACE the aggregate with the full scan, so a
 *     re-run reconciles to the same value.
 *
 * Either way, each contact is matched by ADDRESS (alias) via
 * `upsertContactByAlias` and keeps its established `canonicalName`, so a later
 * message with a different display name updates the same row instead of minting
 * a duplicate — the property both call sites depend on for safe re-runs. The
 * same match spans `person` and `other`, so a contact the kind bar
 * re-classifies moves in place on the next run.
 *
 * Pass `tx` to enlist every write in a caller's transaction (the incremental
 * path does, so the increments commit atomically with its capture marker).
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
    // Match the existing contact by EMAIL ALIAS so the write lands on the same
    // row even when the display name drifts (and never collides onto a
    // different contact who happens to share a canonical name). The writer
    // derives the kind from the row's stored canonical name, so the count below
    // reads the kind that was actually written.
    const { row, reKindBlocked: blocked } = await upsertContactByAlias(
      {
        userId,
        address: agg.address,
        aliases: [agg.address],
        // Only a brand-new contact takes the freshly-parsed display name;
        // an existing row keeps its established canonical name.
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
 * Apply a contacts delta map onto the graph by INCREMENTING each contact's
 * correspondence aggregate (ADR-0059 amendment — daily incremental capture, as
 * opposed to the backfill's overwrite). Each contact is matched by ADDRESS
 * (alias), not canonical name, so a later message with a different display name
 * merges onto the same row rather than minting a duplicate. Idempotency is the
 * CALLER's responsibility (it must pass only docs not previously captured) —
 * this function is not safe to re-run over the same delta.
 *
 * Pass `tx` to enlist the increments in the caller's transaction, so they
 * commit atomically with whatever marks those docs captured (the daily
 * memory-extraction step does this with `captured_into_graph_at`).
 */
export async function applyCorrespondenceIncrements(
  userId: string,
  contacts: Map<string, ContactAggregate>,
  tx?: DbTransaction,
): Promise<ApplyIncrementsResult> {
  return persistContacts(userId, contacts, "merge", tx);
}

export interface BackfillTeamGraphOpts {
  /** When false (default), aggregate + rank but write nothing — a dry run. */
  commit?: boolean;
  /** Cap on `documents` scanned (newest first). Default 5000. */
  maxDocs?: number;
  /** Reference "now" for the significance recency decay. Defaults to wall clock. */
  now?: Date;
}

export interface BackfillTeamGraphResult {
  docsScanned: number;
  /** Distinct human contacts found. */
  contacts: number;
  /** Distinct non-consumer organization domains found. */
  organizations: number;
  /** Contacts the kind bar filed as something other than `person` (#1108). */
  nonPersonContacts: number;
  /**
   * Wanted re-kinds the unique index refused — kept the current kind (#1108).
   * `persisted` is the discriminant: EXACT when true, a pre-run ESTIMATE
   * (`~B`) when false — it can differ in either direction wherever two
   * contact rows share one email alias (item 98), and a mid-loop insert can
   * occupy a later row's target (item 95).
   */
  reKindBlocked: number;
  persisted: boolean;
  /** Top contacts by significance, for logging. */
  top: Array<{
    name: string;
    address: string;
    inbound: number;
    outbound: number;
    score: number;
  }>;
}

/**
 * Aggregate correspondence from `documents` into a per-contact map. Pure read —
 * the caller decides whether to persist. Exposed for the dry-run script.
 */
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

/**
 * Backfill the team graph over already-ingested mail (ADR-0059 P4a). Dry-run by
 * default; pass `commit: true` to write. Idempotent: `persistContacts` matches
 * each contact by address alias (so a re-run with a drifted display name updates
 * the same row instead of minting a duplicate), overwrites the correspondence
 * aggregate from the scan, and the significance pass overwrites in turn.
 */
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
    // Reconcile the graph to the scan (overwrite), then score it. Shares the
    // alias-matched writer with the incremental path so the two cannot diverge.
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

  // Dry run — compute significance in-memory for the ranking, persist nothing.
  const orgDomains = collectOrgDomains(contacts);
  let nonPersonContacts = 0;

  // Nothing is persisted here, so preview the kind a real write WOULD produce:
  // the stored canonical name for an existing row, the scan's display name for
  // a brand-new row only. One call — the stored read lives inside the preview,
  // which shares the classifier and the alias predicate with the writer. The
  // preview's `blockedEstimate` is a two-sided ESTIMATE of what a commit would
  // refuse, never an equality, for two reasons neither side can close here:
  // the committer INSERTS new contact rows as it loops, and a new row can
  // occupy the coordinate a later stored row wants, which the pre-run
  // snapshot never models (item 95, under-count); and wherever two contact
  // rows share one email alias the two sides can resolve it to different
  // rows — the preview is last-write-wins over an unordered SELECT while the
  // writer takes `.limit(1)` with no `ORDER BY` (item 98, either direction).
  // `nonPersonContacts` is a reported number, never
  // a write, and its dry-vs-commit delta is unsigned: dry counts the
  // would-be kind while commit counts the written kind, so a blocked
  // `other → person` promotion moves it the other way from a blocked
  // demotion.
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

  // The dry report has no unclassifiable count: absence is never counted as
  // a non-person, so the list is named here and left uncounted.
  void unclassifiable;

  for (const agg of contacts.values()) {
    // Keyed by the caller's own address string: a hit by construction. An
    // absent key (a key empty after trim) leaves the contact
    // alone — it is never counted as a non-person.
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

/** Build the top-N-by-significance log slice; falls back to in-memory compute when no persisted score. */
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
