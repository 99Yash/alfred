/**
 * The footprint projection (ADR-0135): per provider, one query-time answer to "is this in
 * the user's world?". It folds three live stores — the integration connections (native
 * credentials and ready MCP connections), the `integration_objects` rows and keys, and the
 * triaged-mail corpus in a lookback window — into a three-state verdict with cited evidence.
 *
 * The verdict is never persisted. Positive footprint is durable truth owned by existing
 * domains; the negative is always an inference over what those stores hold today, so it is
 * recomputed as evidence arrives and never learned from itself (theory principle 5). A
 * positive stands on its own store's truth; a faulted or partial leg only ever holds the
 * negative back, so the demotion bar is positive sight, never "we couldn't look".
 *
 * The match is identity-keyed, never word-keyed (decision D3): a provider's identity is its
 * domain set, and `isDomainOrSubdomain` on a parsed sender domain, link host, or typed
 * object row is the only match. The word a broadcast repeats is not evidence — a personal
 * project named "render" on Railway stays out of Render's footprint.
 */

import {
  builtInMCPProvidersOf,
  collectLinkParts,
  credentialProviderOf,
  credentialSatisfies,
  domainSchema,
  extractGmailDocumentBody,
  INTEGRATIONS,
  isCatalogSlug,
  isDomainOrSubdomain,
  isLiveProviderSlug,
  parseGmailDocumentMetadata,
  parseMailbox,
  type IntegrationSlug,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import {
  documents,
  emailTriage,
  integrationCredentials,
  integrationObjectKeys,
  integrationObjects,
} from "@alfred/db/schemas";
import {
  proposeReconcileCandidates,
  readGmailDeliveryFacts,
  reconcileEvidence,
} from "@alfred/assistant/connections";
import {
  builtInProviderForEndpoint,
  listOwnedConnections,
} from "@alfred/assistant/connections/mcp";
import {
  extractMessageContent,
  extractMessageHtml,
  parseStoredGmailMessage,
} from "@alfred/integrations/google";
import { logger } from "@alfred/logging";
import { and, desc, eq, gte, ilike, isNull, lte, or, sql } from "drizzle-orm";
import { gmailHeaderLookup } from "./gmail-reducer";

/** How far back the triaged-mail corpus leg looks. "Months of mail", per decision D5. */
export const FOOTPRINT_LOOKBACK_DAYS = 90;

/**
 * The smallest searchable-triage count that makes a zero-hit corpus leg count as
 * looked-and-found-nothing. The number is held, not measured (ADR-0135 D5 amendment): one
 * busy triage day can meet it, and no measurement has sized a real window yet, so the
 * corpus-coverage measurement owns the value.
 */
export const FOOTPRINT_MIN_CORPUS_THREADS = 100;

/**
 * How many corpus nominations the reader confirms through the stored-message parse. The
 * prefilter is a substring scan; the cap bounds the parse work on a pathological corpus.
 * A nomination past the cap is uncovered, and an uncovered nomination withholds the
 * negative (decision D5 amendment).
 */
export const FOOTPRINT_CORPUS_CONFIRM_CAP = 25;

/** The three states. Only a confident `not-in-footprint` may change a ranking. */
export type FootprintVerdict = "in-footprint" | "not-in-footprint" | "unknown";

/**
 * One store leg's answer, each state its own value: a complete read with hits, a complete
 * read with nothing, or a read that faulted. A miss and a fault never share a shape, so the
 * fold can tell "looked and found nothing" from "could not look".
 */
export type FootprintLeg<Hit> =
  | { readonly status: "hit"; readonly hits: readonly Hit[] }
  | { readonly status: "empty" }
  | { readonly status: "unreadable" };

/** A connected account the fold matched on. */
export interface FootprintConnectionHit {
  readonly slug: IntegrationSlug;
  readonly account: string | null;
  /** A native credential row, or a ready MCP connection's endpoint (decision D3). */
  readonly via: "credential" | "mcp";
}

/** What admitted one object row: the typed provider, an identity value, or a named key. */
export type FootprintObjectMatch =
  | { readonly via: "provider"; readonly provider: string }
  | { readonly via: "identity"; readonly value: string; readonly domain: string }
  | { readonly via: "named-key"; readonly value: string };

/** An owned object (or one of its typed keys) the fold matched on, with what matched. */
export interface FootprintObjectHit {
  readonly objectId: string;
  readonly provider: string;
  readonly kind: string;
  readonly title: string | null;
  readonly url: string | null;
  /** Which key value or URL matched, and the matched domain. Never the row alone. */
  readonly matched: FootprintObjectMatch;
}

/** A triaged thread whose decoded mail touches the provider's domains without being its own. */
export interface FootprintMailHit {
  readonly documentId: string;
  readonly threadId: string | null;
  /** The query domain the match went through, in normalized form. */
  readonly matchedDomain: string;
  /** A link host on the provider's domains, or a whole-label mention in the decoded text. */
  readonly via: "link" | "mention";
}

/** The pure touch question the corpus reader asks of one mail's decoded identities. */
export interface FootprintMailTouchInput {
  /** The sender's parsed domain, or null when the header does not parse. */
  readonly senderDomain: string | null;
  /** Hosts of every link in the mail's full decoded body and its full HTML part. */
  readonly linkHosts: readonly string[];
  /** The subject and the full decoded body: the plain text a mention can sit in. */
  readonly text: string;
}

/** How one mail touches the provider's domains, when it may count as use evidence. */
export type FootprintMailTouch =
  | { readonly via: "link"; readonly domain: string }
  | { readonly via: "mention"; readonly domain: string };

/**
 * Whether one mail may count as use evidence, and through what (D5 amendment). The
 * broadcast-sender rule: the provider's own mail is the broadcast class itself, so a sender
 * on the provider's domains is never evidence, however many provider links it carries. A
 * person's or a third party's mail touching the provider's domains, through a link host or
 * a whole-label mention, is.
 */
export function footprintMailTouch(
  mail: FootprintMailTouchInput,
  domains: readonly string[],
): FootprintMailTouch | null {
  if (mail.senderDomain !== null && matchedDomain(mail.senderDomain, domains) !== null) return null;

  for (const host of mail.linkHosts) {
    const domain = matchedDomain(host, domains);

    if (domain !== null) return { via: "link", domain };
  }

  const mention = mentionDomain(mail.text, domains);

  return mention === null ? null : { via: "mention", domain: mention };
}

/** The corpus leg of one query: what the reader could actually see, not what exists. */
export type FootprintCorpusLeg =
  | {
      readonly status: "read";
      readonly lookbackDays: number;
      /** Triaged threads in the window whose mail is stored: the rows the search could read. */
      readonly threadsRead: number;
      /** Triaged threads in the window with no stored mail. A positive count holds the negative. */
      readonly unreadMail: number;
      /** Prefilter nominations. The confirm cap bounds the parses, never this count. */
      readonly nominated: number;
      /** Nominated mails actually parsed and checked against the domains. */
      readonly mailsChecked: number;
      /** Gmail recorded an unrepaired history gap; a gapped window backs no negative. */
      readonly historyGapped: boolean;
      readonly hits: readonly FootprintMailHit[];
    }
  | { readonly status: "skipped"; readonly reason: "named-scope" | "no-domains" }
  | { readonly status: "unreadable" };

/** One evidence item. The demotion carries its own absence proof as the `corpus` arm. */
export type FootprintEvidence =
  | { readonly store: "connection"; readonly hit: FootprintConnectionHit }
  | { readonly store: "object"; readonly hit: FootprintObjectHit }
  | { readonly store: "mail"; readonly hit: FootprintMailHit }
  | {
      readonly store: "corpus";
      readonly threadsRead: number;
      readonly unreadMail: number;
      readonly nominated: number;
      readonly mailsChecked: number;
      readonly lookbackDays: number;
    };

/** What one projection query asks about (decision D3). */
export interface FootprintQuery {
  /**
   * The registry slug when the broadcast's provider is one Alfred catalogs, else `null`. A
   * live slug gives the fold a credential leg; any cataloged slug gives the typed object
   * leg and the MCP-connection leg, because a planned provider's reducer can still own
   * objects and its MCP connection can still be ready.
   */
  readonly slug: IntegrationSlug | null;
  /**
   * The provider's identity domains: the broadcast mail's own sender and link domains, plus
   * the registry entry's `domain` when the reader knows the slug. Normalized and
   * deduplicated at the reader boundary; entries that are not valid domains are dropped.
   */
  readonly domains: readonly string[];
  /**
   * The object keys the notice names (its named product or object), when it names one. The
   * fold answers at that granularity: provider-wide evidence cannot decide a notice that
   * names one thing, and named keys that resolve to no owned object stay unknown.
   */
  readonly namedKeys?: readonly string[];
}

/** What the stores answered for one query. The pure fold reads only this. */
export interface FootprintSight {
  readonly connections: FootprintLeg<FootprintConnectionHit>;
  readonly objects: FootprintLeg<FootprintObjectHit>;
  readonly corpus: FootprintCorpusLeg;
}

export interface FootprintAnswer {
  readonly verdict: FootprintVerdict;
  /** Non-empty for `in-footprint` and for a confident `not-in-footprint`. */
  readonly evidence: readonly FootprintEvidence[];
}

/**
 * The broadcast mail itself, when the caller holds it. Its named object keys come from the
 * mail-to-object resolver the triage step already runs (`object-links.ts`): the same
 * propose-and-resolve pair, read-only, so the footprint never re-derives the matching.
 */
export interface FootprintNotice {
  readonly subject: string | null;
  /** The mail's full decoded content. */
  readonly content: string;
  /** The raw From header. */
  readonly sender: string | null;
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

/** Hostname-like tokens of a text, case-insensitive, at least two labels. */
const HOST_TOKEN_RE = /[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+/gi;

/**
 * The first query domain a decoded text mentions, or null. A mention is identity, not prose
 * (decision D3): the token must be the domain or a subdomain of it, whole labels, so the
 * word "render" and the lookalike `render.commerce.io` match nothing. The comparison itself
 * goes through `isDomainOrSubdomain`, the one domain match.
 */
function mentionDomain(text: string, domains: readonly string[]): string | null {
  for (const token of text.matchAll(HOST_TOKEN_RE)) {
    const parsed = domainSchema.safeParse(token[0]);

    if (!parsed.success) continue;

    const domain = matchedDomain(parsed.data, domains);

    if (domain !== null) return domain;
  }

  return null;
}

/** The matched domain of an identity value's link hosts, or null. */
function identityMatch(identity: string, domains: readonly string[]): string | null {
  for (const host of linkHosts(identity)) {
    const domain = matchedDomain(host, domains);

    if (domain !== null) return domain;
  }

  return null;
}

/**
 * The fold (decision D1). Positive sight in any store is `in-footprint`; otherwise a
 * covered lookback window with at least {@link FOOTPRINT_MIN_CORPUS_THREADS} searchable
 * triaged threads and no hit is `not-in-footprint`; anything thinner, partial, gapped, or
 * faulted is `unknown`. The query's domains arrive normalized from the reader. The fold
 * never sees the stores directly, so an eval or a fixture grades it without a database.
 */
export function foldFootprint(query: FootprintQuery, sight: FootprintSight): FootprintAnswer {
  // No usable identity: no domain ask and no slug. A negative here would answer a question
  // the fold never asked (decision D3), so the verdict stays unknown.
  if (query.slug === null && query.domains.length === 0) {
    return { verdict: "unknown", evidence: [] };
  }

  // A notice that names one thing answers at that granularity. A provider connection or a
  // provider-wide corpus presence cannot decide it; an owned object the named keys resolve
  // to is positive, and anything else stays unknown, never a negative (D5 amendment).
  const namedKeys = query.namedKeys ?? [];

  if (namedKeys.length > 0) {
    const named =
      sight.objects.status === "hit"
        ? sight.objects.hits.filter((hit) => hit.matched.via === "named-key")
        : [];

    if (named.length > 0) {
      return {
        verdict: "in-footprint",
        evidence: named.map((hit) => ({ store: "object" as const, hit })),
      };
    }

    return { verdict: "unknown", evidence: [] };
  }

  const evidence: FootprintEvidence[] = [];
  let unreadable = false;

  // A positive stands on its own store's truth, so a faulted sibling leg never hides it.
  if (sight.connections.status === "hit") {
    for (const hit of sight.connections.hits) {
      evidence.push({ store: "connection", hit });
    }
  } else if (sight.connections.status === "unreadable") {
    unreadable = true;
  }

  if (sight.objects.status === "hit") {
    for (const hit of sight.objects.hits) evidence.push({ store: "object", hit });
  } else if (sight.objects.status === "unreadable") {
    unreadable = true;
  }

  if (sight.corpus.status === "read" && sight.corpus.hits.length > 0) {
    for (const hit of sight.corpus.hits) evidence.push({ store: "mail", hit });
  } else if (sight.corpus.status === "unreadable") {
    unreadable = true;
  }

  if (evidence.length > 0) return { verdict: "in-footprint", evidence };

  // The negative needs every leg readable: a faulted leg is a store the fold could not ask.
  if (unreadable) return { verdict: "unknown", evidence: [] };

  if (sight.corpus.status !== "read") return { verdict: "unknown", evidence: [] };

  const corpus = sight.corpus;

  // Each gap below is a way the corpus sight falls short of looked-and-found-nothing.
  if (query.domains.length === 0) return { verdict: "unknown", evidence: [] };

  if (corpus.historyGapped) return { verdict: "unknown", evidence: [] };

  if (corpus.unreadMail > 0) return { verdict: "unknown", evidence: [] };

  if (corpus.threadsRead < FOOTPRINT_MIN_CORPUS_THREADS)
    return { verdict: "unknown", evidence: [] };

  if (corpus.nominated > FOOTPRINT_CORPUS_CONFIRM_CAP) return { verdict: "unknown", evidence: [] };

  if (corpus.mailsChecked !== corpus.nominated) return { verdict: "unknown", evidence: [] };

  return {
    verdict: "not-in-footprint",
    evidence: [
      {
        store: "corpus",
        threadsRead: corpus.threadsRead,
        unreadMail: corpus.unreadMail,
        nominated: corpus.nominated,
        mailsChecked: corpus.mailsChecked,
        lookbackDays: corpus.lookbackDays,
      },
    ],
  };
}

/**
 * Reads the sight from the live stores and folds it. Every leg degrades on its own: a read
 * fault marks the leg unreadable, which holds the negative verdict back instead of ever
 * producing an unbacked absence proof.
 */
export async function readFootprint(args: {
  userId: string;
  query: FootprintQuery;
  /** The read instant; the corpus window ends here. Defaults to now. */
  at?: Date;
  /** The broadcast mail itself, when the caller holds it. Its named keys resolve the scope. */
  notice?: FootprintNotice;
  abortSignal?: AbortSignal;
}): Promise<FootprintAnswer> {
  const { userId } = args;
  const at = args.at ?? new Date();

  // The identity is the broadcast's own domains plus the registry entry's domain when the
  // slug is known (decision D3): the reader never trusts caller input alone.
  const domains = footprintDomains([
    ...args.query.domains,
    ...(args.query.slug !== null && isLiveProviderSlug(args.query.slug)
      ? [INTEGRATIONS[args.query.slug].domain]
      : []),
  ]);

  const notice = args.notice
    ? await resolveNotice(userId, args.notice, args.abortSignal)
    : { namedKeys: [] as readonly string[], hits: [] as readonly FootprintObjectHit[] };

  const namedKeys = [...new Set([...(args.query.namedKeys ?? []), ...notice.namedKeys])];

  const query: FootprintQuery = { slug: args.query.slug, domains, namedKeys };

  const connections = await readConnections(userId, query);
  const objects = await readFootprintObjects(userId, query, domains);
  const corpus = await readCorpus(userId, domains, at, namedKeys);

  const sight: FootprintSight = {
    connections,
    objects:
      notice.hits.length > 0
        ? {
            status: "hit",
            hits: [...(objects.status === "hit" ? objects.hits : []), ...notice.hits],
          }
        : objects,
    // A named-scope query never reads the corpus: the fold answers at the named
    // granularity, so a provider-wide corpus sight decides nothing.
    corpus: namedKeys.length > 0 ? { status: "skipped", reason: "named-scope" } : corpus,
  };

  return foldFootprint({ slug: query.slug, domains, namedKeys }, sight);
}

async function readConnections(
  userId: string,
  query: FootprintQuery,
): Promise<FootprintLeg<FootprintConnectionHit>> {
  if (query.slug === null) return { status: "empty" };

  const slug = query.slug;
  const hits: FootprintConnectionHit[] = [];

  try {
    // A live provider holds a credential row. A connected credential is durable truth.
    if (isLiveProviderSlug(slug)) {
      const entry = INTEGRATIONS[slug];

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

      for (const row of rows) {
        if (credentialSatisfies(entry.credential, row)) {
          hits.push({ slug, account: row.accountLabel, via: "credential" });
        }
      }
    }

    // A connection endpoint is evidence too (decision D3): a ready MCP connection to the
    // provider counts, which is the only connection a planned provider such as Railway has.
    // The readiness test is the verified-pull reader's own: status ready, endpoint owned by
    // the provider's built-in.
    if (isCatalogSlug(slug)) {
      const builtIns = builtInMCPProvidersOf(slug);

      if (builtIns.length > 0) {
        const owned = await listOwnedConnections(userId);

        for (const connection of owned) {
          const provider = builtInProviderForEndpoint(connection.server.endpointUrl);

          if (
            provider !== undefined &&
            builtIns.includes(provider) &&
            connection.status === "ready"
          ) {
            hits.push({ slug, account: connection.label, via: "mcp" });
          }
        }
      }
    }

    return { status: hits.length > 0 ? "hit" : "empty", hits };
  } catch (err) {
    logger.warn({ err, slug }, "footprint: the connection leg could not be read");

    return { status: "unreadable" };
  }
}

/**
 * The object-leg admission rule (decision D3): a typed provider match, or an identity value
 * (the row's own URL, or a typed key's value) whose link host sits on the provider's
 * domains. The title and every other prose field never enter, so a personal project named
 * like the provider matches nothing. The return carries what matched, so the evidence cites
 * the identity and not only the row.
 */
export function admitsFootprintObject(args: {
  slug: IntegrationSlug | null;
  domains: readonly string[];
  row: { readonly provider: string; readonly identity: string | null; readonly url: string | null };
}): FootprintObjectMatch | null {
  if (args.slug !== null && args.row.provider === args.slug) {
    return { via: "provider", provider: args.row.provider };
  }

  for (const identity of [args.row.identity, args.row.url]) {
    if (!identity) continue;

    const domain = identityMatch(identity, args.domains);

    if (domain !== null) return { via: "identity", value: identity, domain };
  }

  return null;
}

async function readFootprintObjects(
  userId: string,
  query: FootprintQuery,
  domains: readonly string[],
): Promise<FootprintLeg<FootprintObjectHit>> {
  if (query.slug === null && domains.length === 0) return { status: "empty" };

  try {
    const direct = await db()
      .select({
        objectId: integrationObjects.id,
        provider: integrationObjects.provider,
        kind: integrationObjects.kind,
        title: integrationObjects.title,
        url: integrationObjects.url,
        // The row's own URL is its identity.
        identity: integrationObjects.url,
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

    // The keys join checks the parent object's bitemporal validity too: a surviving key on
    // an expired object is not footprint (decision D3).
    const keyed = await db()
      .select({
        objectId: integrationObjectKeys.objectId,
        provider: integrationObjectKeys.provider,
        kind: integrationObjects.kind,
        title: integrationObjects.title,
        url: integrationObjects.url,
        identity: integrationObjectKeys.keyValue,
      })
      .from(integrationObjectKeys)
      .innerJoin(integrationObjects, eq(integrationObjects.id, integrationObjectKeys.objectId))
      .where(
        and(
          eq(integrationObjectKeys.userId, userId),
          isNull(integrationObjects.validUntil),
          or(
            query.slug === null ? undefined : eq(integrationObjectKeys.provider, query.slug),
            ...domains.map((domain) => ilike(integrationObjectKeys.keyValue, `%${domain}%`)),
          ),
        ),
      );

    // One admission and citation path for both queries. The `ILIKE` rows are a prefilter;
    // the admission rule decides. The first citation stands.
    const byObject = new Map<string, FootprintObjectHit>();

    for (const row of [...direct, ...keyed]) {
      if (byObject.has(row.objectId)) continue;

      const matched = admitsFootprintObject({
        slug: query.slug,
        domains,
        row: { provider: row.provider, identity: row.identity, url: row.url },
      });

      if (matched === null) continue;

      byObject.set(row.objectId, {
        objectId: row.objectId,
        provider: row.provider,
        kind: row.kind,
        title: row.title,
        url: row.url,
        matched,
      });
    }

    return { status: byObject.size > 0 ? "hit" : "empty", hits: [...byObject.values()] };
  } catch (err) {
    logger.warn({ err }, "footprint: the object leg could not be read");

    return { status: "unreadable" };
  }
}

/**
 * The notice's named keys and the owned objects they resolve to. The matching is the triage
 * step's own mail-to-object resolver (`object-links.ts`): the same propose-and-resolve pair
 * the `about` observation runs, read-only, so the footprint never re-derives it. Keys that
 * resolve to nothing are the honest answer: the notice named a thing and no owned object
 * answered, which the fold reads as unknown, never a negative.
 */
async function resolveNotice(
  userId: string,
  notice: FootprintNotice,
  abortSignal?: AbortSignal,
): Promise<{ namedKeys: readonly string[]; hits: readonly FootprintObjectHit[] }> {
  const candidates = proposeReconcileCandidates(
    {
      id: `footprint:notice:${userId}`,
      text: { subject: notice.subject ?? "", content: notice.content },
    },
    { reading: "about", sender: notice.sender },
  );

  if (candidates === null) return { namedKeys: [], hits: [] };

  const namedKeys = candidates.keys.map((key) => key.keyValue);

  try {
    const resolved =
      (
        await reconcileEvidence({
          userId,
          subjects: [candidates],
          ...(abortSignal === undefined ? {} : { abortSignal }),
        })
      ).get(candidates.id) ?? [];

    return {
      namedKeys,
      hits: resolved.map(({ key, state }) => ({
        objectId: state.objectId,
        provider: state.provider,
        kind: state.kind,
        title: state.title,
        url: state.url,
        matched: { via: "named-key" as const, value: key.keyValue },
      })),
    };
  } catch (err) {
    logger.warn({ err }, "footprint: the notice keys could not be resolved");

    return { namedKeys, hits: [] };
  }
}

/** One nominated triage row: the stored mail the confirm step parses in full. */
interface NominatedMail {
  readonly documentId: string | null;
  readonly threadId: string | null;
  readonly title: string | null;
  readonly content: string;
  readonly raw: unknown;
  readonly metadata: unknown;
}

/**
 * The decoded identities of one stored mail, for {@link footprintMailTouch}. The parse is
 * the mail-facts reader's own, minus its body cap: a link past the cap still confirms.
 */
function storedMailTouch(
  mail: NominatedMail,
  domains: readonly string[],
): FootprintMailTouch | null {
  const message = parseStoredGmailMessage(mail.raw);
  const metadata = parseGmailDocumentMetadata(mail.metadata);
  const headers = gmailHeaderLookup(message?.payload?.headers);

  const senderDomain = parseMailbox(metadata.from ?? headers.get("from"))?.domain ?? null;

  const body = message
    ? extractMessageContent(message).body
    : extractGmailDocumentBody(mail.content, {
        from: metadata.from,
        to: metadata.to,
        cc: metadata.cc,
        subject: mail.title,
      });

  // `extractMessageContent` strips tags, which drops anchor hrefs. The full HTML part keeps
  // them, and `collectLinkParts` reads a link out of an href, so the target survives.
  const html = message ? extractMessageHtml(message) : null;

  const hostText = [body, html].filter((part): part is string => part !== null && part !== "");

  return footprintMailTouch(
    {
      senderDomain,
      linkHosts: linkHosts(hostText.join("\n")),
      text: `${mail.title ?? ""}\n${body}`,
    },
    domains,
  );
}

async function readCorpus(
  userId: string,
  domains: readonly string[],
  at: Date,
  namedKeys: readonly string[],
): Promise<FootprintCorpusLeg> {
  const lookbackDays = FOOTPRINT_LOOKBACK_DAYS;
  const windowStart = new Date(at.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  // A named-scope query never searches the corpus: the fold answers at the named
  // granularity, so the provider-wide corpus sight decides nothing.
  if (namedKeys.length > 0) return { status: "skipped", reason: "named-scope" };

  if (domains.length === 0) return { status: "skipped", reason: "no-domains" };

  // The window closes at the read instant on both ends: a message classified after `at` is
  // outside the sight the verdict answers for.
  const windowWhere = and(
    eq(emailTriage.userId, userId),
    gte(emailTriage.classifiedAt, windowStart),
    lte(emailTriage.classifiedAt, at),
  );

  // A substring scan only nominates candidates; the stored-message parse and the typed
  // domain match decide, so a word lookalike (`render.commerce.io`) matches nothing.
  const nominatedWhere = and(
    windowWhere,
    or(...domains.map((domain) => sql`${documents.content} ilike ${`%${domain}%`}`)),
  );

  try {
    // Gmail records unrepaired history gaps; a window over a gap-ridden corpus does not
    // back a confident negative, and a gap read that faults counts as gapped.
    let historyGapped = false;

    try {
      const delivery = await readGmailDeliveryFacts(userId);

      historyGapped = [...delivery.values()].some((facts) => facts.coverageGap);
    } catch (err) {
      logger.warn({ err }, "footprint: the gmail delivery facts could not be read");
      historyGapped = true;
    }

    // One snapshot: the counts and the nomination scan read the same rows, so the corpus
    // evidence never pairs a count from before a write with a search from after it.
    const { triageRows, mailRows, nominatedCount, rows } = await db().transaction(async (tx) => {
      const [triage] = await tx
        .select({ rows: sql<number>`count(*)::int` })
        .from(emailTriage)
        .where(windowWhere);

      const [mail] = await tx
        .select({ rows: sql<number>`count(*)::int` })
        .from(emailTriage)
        .innerJoin(documents, eq(documents.id, emailTriage.documentId))
        .where(windowWhere);

      const [nominated] = await tx
        .select({ rows: sql<number>`count(*)::int` })
        .from(emailTriage)
        .innerJoin(documents, eq(documents.id, emailTriage.documentId))
        .where(nominatedWhere);

      const scan =
        (nominated?.rows ?? 0) > 0
          ? await tx
              .select({
                documentId: emailTriage.documentId,
                threadId: emailTriage.sourceThreadId,
                title: documents.title,
                content: documents.content,
                raw: documents.raw,
                metadata: documents.metadata,
              })
              .from(emailTriage)
              .innerJoin(documents, eq(documents.id, emailTriage.documentId))
              .where(nominatedWhere)
              .orderBy(desc(emailTriage.classifiedAt))
              .limit(FOOTPRINT_CORPUS_CONFIRM_CAP)
          : [];

      return {
        triageRows: triage?.rows ?? 0,
        mailRows: mail?.rows ?? 0,
        nominatedCount: nominated?.rows ?? 0,
        rows: scan,
      };
    });

    const hits: FootprintMailHit[] = [];
    let mailsChecked = 0;

    for (const row of rows) {
      if (row.documentId === null) continue;

      mailsChecked++;

      const touch = storedMailTouch(row, domains);

      if (touch === null) continue;

      hits.push({
        documentId: row.documentId,
        threadId: row.threadId,
        matchedDomain: touch.domain,
        via: touch.via,
      });
    }

    return {
      status: "read",
      lookbackDays,
      threadsRead: mailRows,
      unreadMail: triageRows - mailRows,
      nominated: nominatedCount,
      mailsChecked,
      historyGapped,
      hits,
    };
  } catch (err) {
    logger.warn({ err }, "footprint: the corpus leg could not be read");

    return { status: "unreadable" };
  }
}
