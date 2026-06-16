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
import { extractSenderContext } from "../triage/sender-context";
import { upsertEntity, linkEntities } from "./entities";
import { type CorrespondenceStats } from "./entity-metadata";
import { computeSignificance, loadUserDomains, runSignificancePass } from "./significance";

/** Per-contact accumulator built during the scan, keyed by lowercased address. */
interface ContactAggregate {
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
 */
function parsePersonToken(token: string): ParsedPerson | null {
  const sc = extractSenderContext({ fromHeader: token, subject: null, body: "" });
  if (sc.context.fromKind !== "person" || !sc.senderAddress) return null;
  return {
    address: sc.senderAddress,
    domain: sc.senderDomain,
    displayName: parseDisplayName(token),
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
    const meta = row.metadata;
    const authoredAt = row.authoredAt ?? null;
    const isSent = meta.isSent === true;

    const fromPerson = parsePersonToken(metaStr(meta, "from") ?? "");
    const recipientTokens = [
      ...splitAddressList(metaStr(meta, "to")),
      ...splitAddressList(metaStr(meta, "cc")),
    ];

    if (isSent) {
      // The user authored it → every parsed recipient is an outbound contact.
      for (const token of recipientTokens) {
        const p = parsePersonToken(token);
        if (p && p.address !== self) touch(contacts, p, "outbound", authoredAt);
      }
    } else {
      // Received → the sender is an inbound contact; other recipients are
      // co-recipients (a weaker shared-context signal). Skip the user's self.
      if (fromPerson && fromPerson.address !== self) {
        touch(contacts, fromPerson, "inbound", authoredAt);
      }
      for (const token of recipientTokens) {
        const p = parsePersonToken(token);
        if (p && p.address !== self) touch(contacts, p, "coRecipient", authoredAt);
      }
    }
  }

  return { contacts, docsScanned: rows.length };
}

/**
 * Backfill the team graph over already-ingested mail (ADR-0059 P4a). Dry-run by
 * default; pass `commit: true` to write. Idempotent — `upsertEntity` merges,
 * `linkEntities` is a no-op on conflict, and the significance pass overwrites.
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

  // Organization domains worth a node: non-consumer, and at least one contact.
  const orgDomains = new Set<string>();
  for (const agg of contacts.values()) {
    if (agg.domain && !isConsumerEmailDomain(agg.domain)) orgDomains.add(agg.domain);
  }

  let relations = 0;

  if (commit) {
    // 1) Organization entities first, so we can wire `works_at` as we go.
    const orgIdByDomain = new Map<string, string>();
    for (const domain of orgDomains) {
      const org = await upsertEntity({
        userId,
        kind: "organization",
        canonicalName: domain,
        aliases: [domain],
        metadata: { domain },
      });
      orgIdByDomain.set(domain, org.id);
    }

    // 2) Person entities + their `works_at` edge.
    for (const agg of contacts.values()) {
      const person = await upsertEntity({
        userId,
        kind: "person",
        canonicalName: agg.displayName ?? agg.address,
        aliases: [agg.address],
        metadata: {
          primaryAddress: agg.address,
          domain: agg.domain,
          correspondence: toStats(agg),
        },
      });
      const orgId = agg.domain ? orgIdByDomain.get(agg.domain) : undefined;
      if (orgId) {
        await linkEntities({
          userId,
          fromEntityId: person.id,
          toEntityId: orgId,
          relation: "works_at",
        });
        relations += 1;
      }
    }

    // 3) First significance pass over the now-populated graph.
    const pass = await runSignificancePass(userId, { now, userDomains, commit: true });
    const scoreByAddr = new Map(pass.top.map((t) => [t.address ?? "", t.score]));
    return {
      docsScanned,
      contacts: contacts.size,
      organizations: orgDomains.size,
      relations,
      persisted: true,
      top: rankTop(contacts, (addr) => scoreByAddr.get(addr) ?? null, now, userDomains),
    };
  }

  // Dry run — compute significance in-memory for the ranking, persist nothing.
  for (const agg of contacts.values()) {
    if (agg.domain && !isConsumerEmailDomain(agg.domain)) relations += 1;
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
