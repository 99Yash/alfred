/**
 * The footprint projection (ADR-0135): per provider, one query-time answer to "is this in
 * the user's world?". It folds three live stores — the integration connections, the
 * `integration_objects` rows and keys, and the triaged-mail corpus in a lookback window —
 * into a three-state verdict with cited evidence.
 *
 * The verdict is never persisted. Positive footprint is durable truth owned by existing
 * domains; the negative is always an inference over what those stores hold today, so it is
 * recomputed as evidence arrives and never learned from itself (theory principle 5). A
 * faulted read forces `unknown`: the demotion bar is positive sight, never "we couldn't
 * look".
 *
 * The match is identity-keyed, never word-keyed (decision D3): a provider's identity is its
 * domain set, and `isDomainOrSubdomain` on a parsed sender domain, link host, or typed
 * object row is the only match. The word a broadcast repeats is not evidence — a personal
 * project named "render" on Railway stays out of Render's footprint.
 */

import {
  collectLinkParts,
  credentialProviderOf,
  credentialSatisfies,
  domainSchema,
  emailDomain,
  INTEGRATIONS,
  isDomainOrSubdomain,
  isLiveProviderSlug,
  type IntegrationSlug,
  type LiveProviderSlug,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import {
  documents,
  emailTriage,
  integrationCredentials,
  integrationObjectKeys,
  integrationObjects,
} from "@alfred/db/schemas";
import { logger } from "@alfred/logging";
import { and, eq, gte, ilike, isNull, or, sql } from "drizzle-orm";
import { loadMailFacts } from "./mail-facts";

/** How far back the triaged-mail corpus leg looks. "Months of mail", per decision D5. */
export const FOOTPRINT_LOOKBACK_DAYS = 90;

/**
 * The smallest triaged-thread count that makes a zero-hit corpus leg count as
 * looked-and-found-nothing. Below it, sight is thin and the verdict stays `unknown`.
 */
export const FOOTPRINT_MIN_CORPUS_THREADS = 100;

/**
 * How many corpus prefilter hits the reader confirms through the mail-facts reader. The
 * prefilter is a substring scan; the cap bounds the parse work on a pathological corpus.
 */
export const FOOTPRINT_CORPUS_CONFIRM_CAP = 25;

/** The three states. Only a confident `not-in-footprint` may change a ranking. */
export type FootprintVerdict = "in-footprint" | "not-in-footprint" | "unknown";

/** Which store an evidence item cites. */
export type FootprintStore = "connection" | "object" | "mail" | "corpus";

/** A connected account the fold matched on. Only a live provider holds a credential row. */
export interface FootprintConnectionHit {
  readonly slug: LiveProviderSlug;
  readonly account: string | null;
}

/** An owned object (or one of its typed keys) the fold matched on. */
export interface FootprintObjectHit {
  readonly objectId: string;
  readonly provider: string;
  readonly kind: string;
  readonly title: string | null;
  readonly url: string | null;
}

/** A triaged thread whose sender or a link host sits on the provider's domains. */
export interface FootprintMailHit {
  readonly documentId: string;
  readonly threadId: string | null;
  /** The query domain the match went through, in normalized form. */
  readonly matchedDomain: string;
}

/** One evidence item. The demotion carries its own absence proof as the `corpus` arm. */
export type FootprintEvidence =
  | { readonly store: "connection"; readonly hit: FootprintConnectionHit }
  | { readonly store: "object"; readonly hit: FootprintObjectHit }
  | { readonly store: "mail"; readonly hit: FootprintMailHit }
  | {
      readonly store: "corpus";
      readonly threadsRead: number;
      readonly lookbackDays: number;
    };

/** What one projection query asks about (decision D3). */
export interface FootprintQuery {
  /**
   * The registry slug when the broadcast's provider is one Alfred catalogs, else `null`. A
   * live slug gives the fold a connection leg; any cataloged slug gives the typed object
   * leg, because a planned provider's reducer can still own objects.
   */
  readonly slug: IntegrationSlug | null;
  /**
   * The provider's identity domains: the registry entry's `domain` when the slug is known,
   * and the broadcast mail's own sender and link domains. Normalized and deduplicated at
   * the boundary; entries that are not valid domains are dropped.
   */
  readonly domains: readonly string[];
}

/** What the three stores answered for one query. The pure fold reads only this. */
export interface FootprintSight {
  readonly connections: readonly FootprintConnectionHit[];
  readonly objects: readonly FootprintObjectHit[];
  readonly corpus: {
    /** Triaged threads inside the lookback window, hits or not. */
    readonly threadsRead: number;
    readonly lookbackDays: number;
    readonly hits: readonly FootprintMailHit[];
  };
  /** The legs that could not be read. Any fault withholds the negative verdict. */
  readonly faults: readonly FootprintStore[];
}

export interface FootprintAnswer {
  readonly verdict: FootprintVerdict;
  /** Non-empty for `in-footprint` and for a confident `not-in-footprint`. */
  readonly evidence: readonly FootprintEvidence[];
}

/** Parse, lowercase, drop a trailing dot, and keep only valid domains, in first-seen order. */
function footprintDomains(domains: readonly string[]): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const raw of domains) {
    const parsed = domainSchema.safeParse(raw);

    if (!parsed.success) continue;

    const domain = parsed.data;

    if (seen.has(domain)) continue;

    seen.add(domain);
    out.push(domain);
  }

  return out;
}

/** The first query domain that covers `host`, or null. Both sides normalized. */
function matchedDomain(host: string, domains: readonly string[]): string | null {
  for (const domain of domains) {
    if (isDomainOrSubdomain(host, domain)) return domain;
  }

  return null;
}

/** The link hosts of a text, in order, deduplicated, normalized. */
function linkHosts(text: string): readonly string[] {
  const hosts: string[] = [];
  const seen = new Set<string>();

  for (const { host } of collectLinkParts(text)) {
    if (seen.has(host)) continue;

    seen.add(host);
    hosts.push(host);
  }

  return hosts;
}

/**
 * The fold (decision D1). Positive sight in any store is `in-footprint`; otherwise a
 * lookback window with at least {@link FOOTPRINT_MIN_CORPUS_THREADS} triaged threads and no
 * hit is `not-in-footprint`; anything thinner, or any faulted leg, is `unknown`. The fold
 * never sees the stores directly, so an eval or a fixture grades it without a database.
 */
export function foldFootprint(query: FootprintQuery, sight: FootprintSight): FootprintAnswer {
  if (sight.faults.length > 0) return { verdict: "unknown", evidence: [] };

  const evidence: FootprintEvidence[] = [];

  if (query.slug !== null) {
    for (const hit of sight.connections) {
      if (hit.slug === query.slug) evidence.push({ store: "connection", hit });
    }
  }

  for (const hit of sight.objects) evidence.push({ store: "object", hit });

  for (const hit of sight.corpus.hits) evidence.push({ store: "mail", hit });

  if (evidence.length > 0) return { verdict: "in-footprint", evidence };

  if (sight.corpus.threadsRead >= FOOTPRINT_MIN_CORPUS_THREADS) {
    return {
      verdict: "not-in-footprint",
      evidence: [
        {
          store: "corpus",
          threadsRead: sight.corpus.threadsRead,
          lookbackDays: sight.corpus.lookbackDays,
        },
      ],
    };
  }

  return { verdict: "unknown", evidence: [] };
}

/**
 * Reads the sight from the live stores and folds it. Every leg degrades on its own: a read
 * fault marks the leg faulted, which holds the verdict at `unknown` instead of ever
 * producing an unbacked negative.
 */
export async function readFootprint(args: {
  userId: string;
  query: FootprintQuery;
  /** The read instant; the corpus window ends here. Defaults to now. */
  at?: Date;
}): Promise<FootprintAnswer> {
  const { userId, query } = args;
  const at = args.at ?? new Date();
  const domains = footprintDomains(query.domains);

  const faults: FootprintStore[] = [];

  const connections = await readConnections(userId, query, domains, faults);
  const objects = await readFootprintObjects(userId, query, domains, faults);
  const corpus = await readCorpus(userId, domains, at, faults);

  return foldFootprint({ slug: query.slug, domains }, { connections, objects, corpus, faults });
}

async function readConnections(
  userId: string,
  query: FootprintQuery,
  domains: readonly string[],
  faults: FootprintStore[],
): Promise<readonly FootprintConnectionHit[]> {
  // Without a slug there is no credential store to ask, and no domain ask either: the
  // broadcast's own domains carry the identity (decision D3). The guard also narrows the
  // entry: only a live provider holds a credential row.
  if (query.slug === null || domains.length === 0) return [];

  if (!isLiveProviderSlug(query.slug)) return [];

  const slug = query.slug;
  const entry = INTEGRATIONS[slug];

  try {
    const rows = await db()
      .select({
        status: integrationCredentials.status,
        scopes: integrationCredentials.scopes,
        installationId: integrationCredentials.installationId,
        accountLabel: integrationCredentials.accountLabel,
      })
      .from(integrationCredentials)
      .where(
        and(
          eq(integrationCredentials.userId, userId),
          eq(integrationCredentials.provider, credentialProviderOf(slug)),
        ),
      );

    return rows
      .filter((row) => credentialSatisfies(entry.credential, row))
      .map((row) => ({ slug, account: row.accountLabel }));
  } catch (err) {
    faults.push("connection");
    logger.warn({ err, slug: query.slug }, "footprint: the connection leg could not be read");

    return [];
  }
}

/**
 * The object-leg admission rule (decision D3): a typed provider match, or an identity value
 * (the row's own URL, or a typed key's value) whose host sits on the provider's domains.
 * The title and every other prose field never enter, so a personal project named like the
 * provider matches nothing.
 */
export function admitsFootprintObject(args: {
  slug: IntegrationSlug | null;
  domains: readonly string[];
  row: { readonly provider: string; readonly identity: string | null; readonly url: string | null };
}): boolean {
  if (args.slug !== null && args.row.provider === args.slug) return true;

  for (const identity of [args.row.identity, args.row.url]) {
    if (!identity) continue;

    if (identityHostMatches(identity, args.domains)) return true;
  }

  return false;
}

async function readFootprintObjects(
  userId: string,
  query: FootprintQuery,
  domains: readonly string[],
  faults: FootprintStore[],
): Promise<readonly FootprintObjectHit[]> {
  if (domains.length === 0 && query.slug === null) return [];

  try {
    const direct = await db()
      .select({
        objectId: integrationObjects.id,
        provider: integrationObjects.provider,
        kind: integrationObjects.kind,
        title: integrationObjects.title,
        url: integrationObjects.url,
      })
      .from(integrationObjects)
      .where(
        and(
          eq(integrationObjects.userId, userId),
          isNull(integrationObjects.validUntil),
          or(
            query.slug === null ? undefined : eq(integrationObjects.provider, query.slug),
            ...domains.map((domain) => ilike(integrationObjects.url, `%${domain}%`)),
          ),
        ),
      );

    const keyed = await db()
      .select({
        objectId: integrationObjectKeys.objectId,
        provider: integrationObjectKeys.provider,
        keyValue: integrationObjectKeys.keyValue,
        kind: integrationObjects.kind,
        title: integrationObjects.title,
        url: integrationObjects.url,
      })
      .from(integrationObjectKeys)
      .innerJoin(integrationObjects, eq(integrationObjects.id, integrationObjectKeys.objectId))
      .where(
        and(
          eq(integrationObjectKeys.userId, userId),
          or(
            query.slug === null ? undefined : eq(integrationObjectKeys.provider, query.slug),
            ...domains.map((domain) => ilike(integrationObjectKeys.keyValue, `%${domain}%`)),
          ),
        ),
      );

    // The hits: a typed provider match, or an identity value whose host sits on the
    // provider's domains. The `ILIKE` rows are a prefilter; the admission rule decides.
    const byObject = new Map<string, FootprintObjectHit>();

    for (const row of direct) {
      if (
        !admitsFootprintObject({
          slug: query.slug,
          domains,
          row: { provider: row.provider, identity: row.url, url: row.url },
        })
      ) {
        continue;
      }

      byObject.set(row.objectId, {
        objectId: row.objectId,
        provider: row.provider,
        kind: row.kind,
        title: row.title,
        url: row.url,
      });
    }

    for (const row of keyed) {
      if (
        !admitsFootprintObject({
          slug: query.slug,
          domains,
          row: { provider: row.provider, identity: row.keyValue, url: row.url },
        })
      ) {
        continue;
      }

      byObject.set(row.objectId, {
        objectId: row.objectId,
        provider: row.provider,
        kind: row.kind,
        title: row.title,
        url: row.url,
      });
    }

    return [...byObject.values()];
  } catch (err) {
    faults.push("object");
    logger.warn({ err }, "footprint: the object leg could not be read");

    return [];
  }
}

/** True when the text holds a link whose host sits on one of the domains. */
function identityHostMatches(identity: string, domains: readonly string[]): boolean {
  return linkHosts(identity).some((host) => matchedDomain(host, domains) !== null);
}

async function readCorpus(
  userId: string,
  domains: readonly string[],
  at: Date,
  faults: FootprintStore[],
): Promise<FootprintSight["corpus"]> {
  const lookbackDays = FOOTPRINT_LOOKBACK_DAYS;
  const windowStart = new Date(at.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  const read = async (): Promise<FootprintSight["corpus"]> => {
    const [counted] = await db()
      .select({ threads: sql<number>`count(*)::int` })
      .from(emailTriage)
      .where(and(eq(emailTriage.userId, userId), gte(emailTriage.classifiedAt, windowStart)));

    const threadsRead = counted?.threads ?? 0;
    const hits: FootprintMailHit[] = [];

    if (threadsRead > 0 && domains.length > 0) {
      // A substring scan only nominates candidates; the mail-facts reader's parsed sender
      // and link hosts decide, so a word lookalike (`render.commerce.io`) matches nothing.
      const prefetched = await db()
        .select({
          documentId: emailTriage.documentId,
          threadId: emailTriage.sourceThreadId,
        })
        .from(emailTriage)
        .innerJoin(documents, eq(documents.id, emailTriage.documentId))
        .where(
          and(
            eq(emailTriage.userId, userId),
            gte(emailTriage.classifiedAt, windowStart),
            or(...domains.map((domain) => sql`${documents.raw}::text ilike ${`%${domain}%`}`)),
          ),
        )
        .limit(FOOTPRINT_CORPUS_CONFIRM_CAP);

      const ids = prefetched.map((row) => row.documentId).filter((id): id is string => id !== null);

      const facts = await loadMailFacts(userId, ids);

      for (const row of prefetched) {
        if (row.documentId === null) continue;

        const mail = facts.get(row.documentId);

        if (!mail) continue;

        const senderDomain = matchedDomain(emailDomain(mail.sender.address) ?? "", domains);

        if (senderDomain !== null) {
          hits.push({
            documentId: row.documentId,
            threadId: row.threadId,
            matchedDomain: senderDomain,
          });
          continue;
        }

        const linkHit = linkHosts(mail.body)
          .map((host) => matchedDomain(host, domains))
          .find((domain) => domain !== null);

        if (linkHit !== undefined) {
          hits.push({
            documentId: row.documentId,
            threadId: row.threadId,
            matchedDomain: linkHit,
          });
        }
      }
    }

    return { threadsRead, lookbackDays, hits };
  };

  try {
    return await read();
  } catch (err) {
    faults.push("corpus");
    logger.warn({ err }, "footprint: the corpus leg could not be read");

    return { threadsRead: 0, lookbackDays, hits: [] };
  }
}
