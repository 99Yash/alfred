/**
 * Passive team-graph capture — backfill (ADR-0059 P4a).
 *
 * The missing extractor behind "prod `entities` = 0". Scans the user's
 * already-ingested mail (`documents`, `source='gmail'`) and populates the
 * `entities` / `entity_relations` graph the Sender-relationship resolver and
 * `isKnownContact` read:
 *   - one `person` entity per human correspondent (email in `aliases`, so
 *     `isKnownContact` matches; correspondence aggregate in `metadata`),
 *   - one `organization` entity per non-consumer sender domain, with a
 *     `works_at` edge from each contact on that domain,
 *   - a first significance pass over the result.
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
 * Person inclusion keys off `extractSenderContext`'s header classification
 * (`fromKind === 'person'`): real humans — including cold one-way senders — are
 * captured; `noreply`/notification/role/service envelopes are excluded. The
 * cold-vs-warm distinction is then made by the *significance* signal
 * (reciprocity + frequency), not by excluding the entity.
 */
import { isRecord } from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents } from "@alfred/db/schemas";
import { and, desc, eq } from "drizzle-orm";
import { isConsumerEmailDomain } from "../cold-start/signals";
import { extractSenderContext, isHumanLikeSender } from "../triage/sender-context";
import { upsertEntity, upsertPersonByAlias, linkEntities, type DbExecutor } from "./entities";
import { type CorrespondenceStats, parsePersonEntityMetadata } from "./entity-metadata";
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
}

function metaStr(meta: Record<string, unknown>, key: string): string | null {
  const v = meta[key];
  return typeof v === "string" && v.trim() ? v : null;
}

/**
 * Split a `To:`/`Cc:` header into individual address tokens. Commas inside a
 * quoted display name (`"Doe, Jane" <j@x.com>`) or inside angle brackets are
 * not separators, so a naive `split(',')` corrupts those — track quote/angle
 * depth instead.
 */
export function splitAddressList(raw: string | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  let buf = "";
  let inQuote = false;
  let inAngle = false;
  for (const ch of raw) {
    if (ch === '"') inQuote = !inQuote;
    else if (ch === "<") inAngle = true;
    else if (ch === ">") inAngle = false;
    if (ch === "," && !inQuote && !inAngle) {
      const t = buf.trim();
      if (t) out.push(t);
      buf = "";
      continue;
    }
    buf += ch;
  }
  const last = buf.trim();
  if (last) out.push(last);
  return out;
}

const ANGLE_NAME_RE = /^(.*?)<[^>]+>\s*$/;

/** Extract just the display-name part of a `Name <addr>` token (null if bare address). */
function parseDisplayName(token: string): string | null {
  const m = token.trim().match(ANGLE_NAME_RE);
  if (!m || m[1] === undefined) return null;
  const name = m[1]
    .trim()
    .replace(/^"+|"+$/g, "")
    .trim();
  return name || null;
}

interface ParsedPerson {
  address: string;
  domain: string | null;
  displayName: string | null;
}

/**
 * Parse one header token into a *person* contact, reusing triage's curated
 * sender classification so `noreply`/role/service envelopes are dropped here
 * (returns `null`). Address/domain come from `extractSenderContext` (the
 * authoritative normalizer); only the display name is parsed locally.
 *
 * Triage classifies whole service domains (`google.com`, `github.com`, …) as
 * `service`, which would silently drop a real colleague at one of them. The
 * graph wants the human, so a non-`person` sender is rescued when it passes the
 * `isHumanLikeSender` reality check (person-like name or `first.last` local, and
 * not an automated envelope) — see that helper for why triage itself is left
 * untouched.
 */
function parsePersonToken(token: string): ParsedPerson | null {
  const sc = extractSenderContext({ fromHeader: token, subject: null, body: "" });
  if (!sc.senderAddress) return null;
  const displayName = parseDisplayName(token);
  if (sc.context.fromKind !== "person") {
    const localPart = sc.senderAddress.slice(0, sc.senderAddress.indexOf("@"));
    if (!isHumanLikeSender(localPart, displayName)) return null;
  }
  return {
    address: sc.senderAddress,
    domain: sc.senderDomain,
    displayName,
  };
}

function touch(
  map: Map<string, ContactAggregate>,
  person: ParsedPerson,
  field: "inbound" | "outbound" | "coRecipient",
  authoredAt: Date | null,
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
    };
    map.set(person.address, agg);
  }
  agg[field] += 1;
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
 * incremental capture (ADR-0059 P4a). `self` is the user's own lowercased
 * address — skipped so the user never becomes their own contact.
 */
export function accumulateDoc(
  contacts: Map<string, ContactAggregate>,
  meta: Record<string, unknown>,
  authoredAt: Date | null,
  self: string,
): void {
  const isSent = meta.isSent === true;
  const fromPerson = parsePersonToken(metaStr(meta, "from") ?? "");
  const recipientTokens = [
    ...splitAddressList(metaStr(meta, "to")),
    ...splitAddressList(metaStr(meta, "cc")),
  ];

  if (isSent) {
    for (const token of recipientTokens) {
      const p = parsePersonToken(token);
      if (p && p.address !== self) touch(contacts, p, "outbound", authoredAt);
    }
  } else {
    if (fromPerson && fromPerson.address !== self) {
      touch(contacts, fromPerson, "inbound", authoredAt);
    }
    for (const token of recipientTokens) {
      const p = parsePersonToken(token);
      if (p && p.address !== self) touch(contacts, p, "coRecipient", authoredAt);
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

export interface ApplyIncrementsResult {
  contacts: number;
  organizations: number;
  relations: number;
}

/** Non-consumer sender domains worth an organization node (≥1 contact). */
function collectOrgDomains(contacts: Map<string, ContactAggregate>): Set<string> {
  const orgDomains = new Set<string>();
  for (const agg of contacts.values()) {
    if (agg.domain && !isConsumerEmailDomain(agg.domain)) orgDomains.add(agg.domain);
  }
  return orgDomains;
}

/**
 * Persist a contacts map onto the `entities` / `entity_relations` graph. Shared
 * by the daily incremental capture and the from-scratch backfill; the only
 * difference is how each contact's correspondence aggregate combines with what
 * is already stored:
 *   - `"merge"` (incremental) — ADD the delta onto the prior aggregate. The
 *     CALLER guarantees idempotency by passing only un-captured docs.
 *   - `"overwrite"` (backfill) — REPLACE the aggregate with the full scan, so a
 *     re-run reconciles to the same value.
 *
 * Either way, each person is matched by ADDRESS (alias) via
 * `upsertPersonByAlias` and keeps its established `canonicalName`, so a later
 * message with a different display name updates the same row instead of minting
 * a duplicate — the property both call sites depend on for safe re-runs.
 *
 * Pass `tx` to enlist every write in a caller's transaction (the incremental
 * path does, so the increments commit atomically with its capture marker).
 */
async function persistContacts(
  userId: string,
  contacts: Map<string, ContactAggregate>,
  mode: "merge" | "overwrite",
  tx?: DbExecutor,
): Promise<ApplyIncrementsResult> {
  if (contacts.size === 0) return { contacts: 0, organizations: 0, relations: 0 };

  const orgDomains = collectOrgDomains(contacts);

  // Organizations first, so we can wire `works_at` as we go.
  const orgIdByDomain = new Map<string, string>();
  for (const domain of orgDomains) {
    const org = await upsertEntity(
      {
        userId,
        kind: "organization",
        canonicalName: domain,
        aliases: [domain],
        metadata: { domain },
      },
      tx,
    );
    orgIdByDomain.set(domain, org.id);
  }

  let relations = 0;
  for (const agg of contacts.values()) {
    // Match the existing person by EMAIL ALIAS so the write lands on the same
    // row even when the display name drifts (and never collides onto a
    // different person who happens to share a canonical name).
    const person = await upsertPersonByAlias(
      {
        userId,
        address: agg.address,
        aliases: [agg.address],
        // Only a brand-new contact takes the freshly-parsed display name;
        // an existing row keeps its established canonical name.
        canonicalNameIfNew: agg.displayName ?? agg.address,
        buildMetadata: (prior) => {
          const priorStats =
            mode === "merge" ? parsePersonEntityMetadata(prior).correspondence : undefined;
          const stats = mode === "merge" ? mergeStats(priorStats, agg) : toStats(agg);
          return {
            primaryAddress: agg.address,
            domain: agg.domain,
            correspondence: stats,
          };
        },
      },
      tx,
    );

    const orgId = agg.domain ? orgIdByDomain.get(agg.domain) : undefined;
    if (orgId) {
      await linkEntities(
        {
          userId,
          fromEntityId: person.id,
          toEntityId: orgId,
          relation: "works_at",
        },
        tx,
      );
      relations += 1;
    }
  }

  return { contacts: contacts.size, organizations: orgDomains.size, relations };
}

/**
 * Apply a contacts delta map onto the graph by INCREMENTING each contact's
 * correspondence aggregate (ADR-0059 amendment — daily incremental capture, as
 * opposed to the backfill's overwrite). Each person is matched by ADDRESS
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
  tx?: DbExecutor,
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
  /** `works_at` edges (contacts on a non-consumer domain). */
  relations: number;
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
  maxDocs = 5000,
): Promise<{ contacts: Map<string, ContactAggregate>; docsScanned: number }> {
  const self = userEmail.trim().toLowerCase();
  const rows = await db()
    .select({
      authoredAt: documents.authoredAt,
      metadata: documents.metadata,
    })
    .from(documents)
    .where(and(eq(documents.userId, userId), eq(documents.source, "gmail")))
    .orderBy(desc(documents.authoredAt))
    .limit(maxDocs);

  const contacts = new Map<string, ContactAggregate>();

  for (const row of rows) {
    if (!isRecord(row.metadata)) continue;
    accumulateDoc(contacts, row.metadata, row.authoredAt ?? null, self);
  }

  return { contacts, docsScanned: rows.length };
}

/**
 * Backfill the team graph over already-ingested mail (ADR-0059 P4a). Dry-run by
 * default; pass `commit: true` to write. Idempotent: `persistContacts` matches
 * each contact by address alias (so a re-run with a drifted display name updates
 * the same row instead of minting a duplicate), overwrites the correspondence
 * aggregate from the scan, and the significance pass overwrites in turn;
 * `linkEntities` is a no-op on conflict.
 */
export async function backfillTeamGraph(
  userId: string,
  userEmail: string,
  opts: BackfillTeamGraphOpts = {},
): Promise<BackfillTeamGraphResult> {
  const commit = opts.commit ?? false;
  const now = opts.now ?? new Date();
  const userDomains = await loadUserDomains(userId);

  const { contacts, docsScanned } = await aggregateCorrespondence(
    userId,
    userEmail,
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
      relations: applied.relations,
      persisted: true,
      top: rankTop(contacts, (addr) => scoreByAddr.get(addr) ?? null, now, userDomains),
    };
  }

  // Dry run — compute significance in-memory for the ranking, persist nothing.
  const orgDomains = collectOrgDomains(contacts);
  let relations = 0;
  for (const agg of contacts.values()) {
    if (agg.domain && orgDomains.has(agg.domain)) relations += 1;
  }
  return {
    docsScanned,
    contacts: contacts.size,
    organizations: orgDomains.size,
    relations,
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
