/**
 * Grounded `works_at` edge fold (ADR-0067 `entity_edges`, issue #1108 deferred half).
 *
 * The legacy graph minted `works_at` from the sender domain, which restates the
 * `From:` header and carries no evidence. This fold mints `works_at` only from
 * STATED evidence: an inbound message whose body holds the sender's OWN
 * signature block naming the sender and stating the org domain, sent by an
 * address the kind classifier reads as `person` from the SAME per-identity
 * inputs the kind fold classifies from (that identity's display names +
 * header signals — never the display names of other participants on the
 * sender's messages, which would fire the person fast path for every
 * sender). Never from the address.
 *
 * Invariant: after any allowed sequence of Gmail projection runs, refolds, and
 * activation flips, every `works_at` row in `entity_edges` names in its
 * provenance a live-head `gmail/email_message` observation plus the `documentId`
 * whose inbound body holds a signature block stating the edge's org domain —
 * and no `works_at` row exists whose org domain appears only in the message's
 * `From:` header.
 *
 * Deterministic core, no LLM anywhere in v1: the signature read is a pure
 * function over body text, the sender-name match compares whole name TOKENS
 * under a stated normalization (case-fold + whitespace/punctuation collapse,
 * no fuzzy match), and the domain clears the `domain.ts` leaf + a real
 * public-suffix gate + a `classifyBareDomain` deny-gate. An "introduction" is
 * free prose that needs judgment and has no edge propose-dispose pipeline, so
 * introductions mint NOTHING in v1 (item 70 owns the LLM follow-up).
 * Name-only signatures (company without a stated domain) mint NOTHING — no
 * org-name→domain resolution exists.
 *
 * Split of the all-must-hold bar: `parseEmploymentSignature` extracts the
 * block's stated name line + org domain from body text alone; the sender-name
 * match lives in `projectGmailWorksAtEdges`, which is the only side holding
 * the observation's sender display name. Both stay module-private to this
 * file's importers: the barrel fronts ONLY the fold, because the parse result
 * is not employment evidence until the name match and the person gate clear
 * (item 70 imports the pieces from this file directly when it needs them).
 *
 * Shadow-only writer: the committed Gmail shadow backfill invokes this under
 * the same `projectionRunId` as the kind fold and records `entity_edges` in
 * `rowCounts`, WITHOUT activation. Activation + consumer cutover belong to the
 * ADR-0067 P5 item, not here — `readUserContext` still reads the legacy graph
 * until then (item 18 owns that section).
 */
import {
  USER_MODEL_PROJECTION_NAME,
  canonicalizeIdentityValue,
  classifyBareDomain,
  collapseWhitespace,
  domainSchema,
  extractGmailDocumentBody,
  gmailEmailMessagePayloadSchema,
  identityRefSchema,
  isNonEmptyString,
  parseGmailDocumentMetadata,
  type EntityEdgeType,
  type GroundingTier,
  type IdentityRef,
  type ProjectionCursorValue,
  type ProjectionProvenance,
} from "@alfred/contracts";
import { sha256Canonical } from "@alfred/db/hash";
import { db, type DbTransaction } from "@alfred/db";
import {
  documents,
  entityEdges,
  observationFamilyHeads,
  observations,
  type NewEntityEdge,
  type Observation,
} from "@alfred/db/schemas";
import { and, asc, eq, inArray, isNull, lte, notInArray, sql } from "drizzle-orm";
import { parse as parseDomainName } from "tldts";
import { ensureEntityNode } from "./entities";
import { classifyEntityKind, type GmailPayloadSignals } from "./entity-kind-classifier";
import { gmailHighWatermarkCondition, payloadSignalsFromObservation } from "./gmail-kind-fold";
import { liveObservationHeadJoin } from "./observations";

/** The block's stated name + org domain, read out of body prose. */
export interface EmploymentSignature {
  /** First content line of the signature block, as stated (the fold matches it to the sender). */
  readonly personName: string;
  /** Prose-stated org domain, normalized by `domainSchema`; never the header domain. */
  readonly orgDomain: string;
  /** Unset in v1 — no title extraction exists, so no role is claimed. */
  readonly role?: string | undefined;
}

export interface ProjectGmailWorksAtEdgesArgs {
  readonly userId: string;
  readonly projectionRunId: string;
  readonly projectionVersion: number;
  /**
   * Inclusive Gmail replay bound captured before the run starts — the SAME
   * prefix the kind fold consumes under this run (shared helper, not a copy).
   */
  readonly gmailHighWatermark?: ProjectionCursorValue | undefined;
  /**
   * Account-holder email identities to exclude: an inbound message whose
   * sender is one of the user's own addresses never mints `works_at` on the
   * user's own node. The resulting edge would be TRUE, but user affiliation
   * belongs to the identity-facts projection, not this contact fold.
   * Same canonical-lowercase membership rule as the kind fold.
   */
  readonly excludeEmailValues: readonly string[];
}

export interface ProjectGmailWorksAtEdgesResult {
  readonly edgesWritten: number;
  /**
   * Canonical hash of the minted edge set (sender identity, org domain,
   * `valid_from`), so the backfill compares edge SETS across dry runs, not a
   * scalar count two different sets can share.
   */
  readonly checksum: string;
}

/**
 * The tier this fold mints under: the sender's own signature about the sender.
 * Pinned with `satisfies` so a renamed tier fails here, not silently below.
 */
const WORKS_AT_GROUNDING_TIER =
  "self_authored_profile_or_signature" as const satisfies GroundingTier;

/**
 * Edge numerics for v1. Below 1 (this is signature evidence, not
 * directory-verified truth); weight 1 (one stated-employment observation class).
 */
const WORKS_AT_CONFIDENCE = 0.8;

const WORKS_AT_WEIGHT = 1;

/**
 * Provenance this fold writes. `ProjectionProvenance` is a `z.looseObject`
 * that passes undeclared keys through, so a misspelled literal compiles
 * against the column type — this local annotation makes the two keys the
 * headline invariant is about REQUIRED at the writer (the reader half needs
 * the frozen-contracts PR as closer).
 */
interface WorksAtEdgeProvenance extends ProjectionProvenance {
  readonly groundingTier: GroundingTier;
  readonly documentId: string;
}

/**
 * Provenance key the supersede predicate matches on, derived from the typed
 * shape above: renaming the interface key fails the build HERE instead of
 * silently matching zero rows (`->>` on a missing key is NULL, NULL never
 * equals, so a stale literal would stop closing with no error — the repo
 * documents this silent-NULL hazard at `triage/floors/spam.ts:65`).
 */
const GROUNDING_TIER_KEY = "groundingTier" satisfies keyof WorksAtEdgeProvenance;

/** A signature delimiter: RFC-3676 `-- ` or its bare `--` structural equivalent. */
const SIGNATURE_DELIMITER_RE = /^--\s*$/;

/** A plain-text quote line. Quoted regions are the correspondent's, never the sender's. */
const QUOTED_LINE_RE = /^\s*>/;

/** Fail-closed bounds: a "signature" bigger than this is a quoted thread, not a footer. */
const MAX_SIGNATURE_LINES = 30;

const MAX_SIGNATURE_CHARS = 2000;

const MAX_PERSON_NAME_CHARS = 120;

/** `jane@acme.com` inside prose — the domain half is an org-domain candidate. */
const EMAIL_DOMAIN_RE =
  /[A-Za-z0-9._%+-]+@([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,})/g;

/** Bare `acme.com` / `https://acme.com/about` hosts inside prose. */
const BARE_DOMAIN_RE =
  /(?<![A-Za-z0-9@_.-])([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)(?![A-Za-z0-9.-])/g;

/**
 * Pure deterministic signature read. Returns the block's stated name line +
 * org domain only when ALL hold: an RFC-3676 `-- ` (or bare-`--`) delimiter is
 * present in the SENDER-AUTHORED text (quote lines stripped first, FIRST
 * delimiter wins — a backwards scan returns the oldest QUOTED footer on a
 * reply); the trailing block is footer-sized; its first content line is
 * name-shaped; and the block states EXACTLY ONE distinct org domain that
 * parses via `domainSchema`, is a registrable domain under a real public
 * suffix, and reads `corporate_domain` under `classifyBareDomain` (a signature
 * claiming `gmail.com` is not an employer claim; a block naming two orgs is
 * ambiguous and mints nothing).
 *
 * Quote-awareness covers `>`-quoted plain-text replies. HTML mail arrives
 * here already flattened (ingest `stripHtml` drops `<blockquote>` with no `>`
 * substitute), so an HTML reply's quoted footer is indistinguishable from
 * sender prose at projection time — the sender-name token match below is the
 * backstop there, and fixing ingest is out of scope.
 */
export function parseEmploymentSignature(body: string): EmploymentSignature | null {
  const block = signatureBlock(body);

  if (!block) return null;

  const [personName] = block
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (!isNonEmptyString(personName)) return null;

  if (personName.length > MAX_PERSON_NAME_CHARS || !/[A-Za-z]/.test(personName)) return null;

  const domains = signatureOrgDomains(block);

  if (domains.length !== 1) return null;

  const [orgDomain] = domains;

  if (!isNonEmptyString(orgDomain)) return null;

  return { personName, orgDomain };
}

/**
 * Per-edge-type allowability over the `GroundingTier` ordered vocabulary. v1:
 * `works_at` allows ONLY `self_authored_profile_or_signature` (the sender's own
 * signature about the sender) and `user_correction` (explicit user statement;
 * unreachable from the Gmail fold in practice, allowed so the predicate stays
 * source-honest). `corporate_affiliation` and `directory_verified` are REJECTED
 * for contacts — both are user-scoped tiers, and admitting them would
 * reintroduce domain-derived minting through the back door. `weak_mentions`
 * never promotes (ADR-0080 invariant 6). Every other edge type answers false:
 * no grounding path for it exists in v1. The `never` default is a tier-1
 * coverage gate — a sixth `ENTITY_EDGE_TYPES` member fails the build here.
 */
export function canGroundEdgeType(tier: GroundingTier, edge: EntityEdgeType): boolean {
  switch (edge) {
    case "works_at":
      return tier === "self_authored_profile_or_signature" || tier === "user_correction";
    case "member_of":
    case "reports_to":
    case "frequent_collaborator":
    case "in_org":
      return false;
    default: {
      const exhaustive: never = edge;
      void exhaustive;
      throw new Error("[user-model.gmail-edge-fold] unhandled entity edge type");
    }
  }
}

interface EdgeAccumulator {
  readonly fromIdentity: IdentityRef;
  readonly orgIdentity: IdentityRef;
  firstSeenAt: Date;
  readonly observationIds: Set<string>;
  readonly familyKeys: Set<string>;
  documentId: string;
}

interface EdgeChecksumRow {
  readonly from: string;
  readonly to: string;
  readonly validFrom: string;
}

interface SenderMessage {
  readonly observation: Observation;
  readonly documentId: string;
  readonly senderDisplayName: string;
}

interface SenderGroup {
  readonly senderIdentity: IdentityRef;
  readonly displayNames: Set<string>;
  /** Header list/bulk signals from this sender's subject observations (sent included). */
  readonly payloadSignals: GmailPayloadSignals[];
  readonly messages: SenderMessage[];
}

/**
 * Fold live-head inbound `gmail/email_message` observations in the watermark
 * window into grounded `works_at` edges. Envelope (sender identity,
 * `occurredAt`, `documentId`) comes from the observation; prose comes from a
 * `documents` join on `payload.documentId`, decoded through
 * `extractGmailDocumentBody` so the `From:`-header exclusion holds by the
 * extractor's contract rather than by layout accident (the observation log
 * stays prose-free — the payload schema is `.strict()` with no body text).
 *
 * One edge per distinct (sender, org-domain) pair: `valid_from` is the earliest
 * grounding observation (replay purity — no wall-clock default), provenance
 * carries every grounding observation plus the tier + the first grounding
 * `documentId`. Repeat pairs in one run collapse before the write; replays
 * collide on the unique `(user, name, version, relation, from, to)` index and
 * are a no-op. Identity links (`recordEntityIdentity`) are deliberately NOT
 * written here — the kind fold already binds the sender email, and domain
 * binding waits on the merge-signal owner.
 *
 * Supersede: when a sender gains an edge to a new org, the sender's other
 * SAME-TIER open `works_at` rows in this (name, version) scope close with
 * `valid_until` at the newest grounding — a changed employer leaves one open
 * row, not two. Only this fold's own tier is touched, so a future
 * LLM-proposed edge (item 70) is never closed from here. Residual: two
 * genuinely concurrent employers collapse to the latest-grounded one.
 */
export async function projectGmailWorksAtEdges(
  args: ProjectGmailWorksAtEdgesArgs,
  tx?: DbTransaction,
): Promise<ProjectGmailWorksAtEdgesResult> {
  const run = async (ex: DbTransaction): Promise<ProjectGmailWorksAtEdgesResult> => {
    if (!canGroundEdgeType(WORKS_AT_GROUNDING_TIER, "works_at")) {
      throw new Error(
        "[user-model.gmail-edge-fold] works_at grounding tier rejected by canGroundEdgeType",
      );
    }

    const conds = [
      eq(observations.userId, args.userId),
      eq(observations.source, "gmail"),
      eq(observations.kind, "email_message"),
    ];

    const watermarkCond = gmailHighWatermarkCondition(args.gmailHighWatermark);

    if (watermarkCond) conds.push(watermarkCond);

    const rows = await ex
      .select({ observation: observations })
      .from(observations)
      .innerJoin(observationFamilyHeads, liveObservationHeadJoin())
      .where(and(...conds))
      .orderBy(asc(observations.occurredAt), asc(observations.id));

    const excludedEmails = new Set(args.excludeEmailValues.map((value) => value.toLowerCase()));

    const groups = new Map<string, SenderGroup>();

    for (const { observation } of rows) {
      const payload = gmailEmailMessagePayloadSchema.safeParse(observation.payload);

      if (!payload.success) continue;

      const subject = identityRefSchema.safeParse(observation.subjectIdentity);

      if (!subject.success || subject.data.kind !== "email") continue;

      if (excludedEmails.has(subject.data.value)) continue;

      const key = senderKey(subject.data);
      let group = groups.get(key);

      if (!group) {
        group = {
          senderIdentity: subject.data,
          displayNames: new Set(),
          payloadSignals: [],
          messages: [],
        };
        groups.set(key, group);
      }

      // Subject observations feed classification signals whether or not the
      // message is inbound — the kind fold pushes signals for every parsed,
      // non-excluded subject (sent included), so the gate below sees the
      // same signal list. Only inbound messages can mint (messages).
      group.payloadSignals.push(payloadSignalsFromObservation(observation));

      if (payload.data.isSent) continue;

      const displayName = senderDisplayName(observation, subject.data);

      if (!isNonEmptyString(displayName)) continue;

      group.displayNames.add(displayName);
      group.messages.push({
        observation,
        documentId: payload.data.documentId,
        senderDisplayName: displayName,
      });
    }

    // Per-identity display names across the whole window (any role),
    // mirroring `collectIdentities`: a name counts for the identity whose
    // participant entry carries it, never for the sender of a message it
    // appears on. Harvesting every participant name onto the sender fires
    // the classifier's existential person fast path for almost every
    // sender (the account holder's own person-shaped name sits on the
    // `to:` line of nearly every inbound message). Observations without a
    // `from` display name still contribute signals above — dropping them
    // before classification hides list evidence the kind fold sees.
    for (const { observation } of rows) {
      for (const participant of observation.participants.items) {
        const group = groups.get(senderKey(participant.identity));

        if (!group) continue;

        if (isNonEmptyString(participant.displayName)) {
          group.displayNames.add(participant.displayName);
        }
      }
    }

    if (groups.size === 0) return { edgesWritten: 0, checksum: checksumForEdges([]) };

    // Sender-person gate FIRST, over the sender's WHOLE window state: the call
    // below feeds the classifier the SAME inputs the kind fold feeds it for
    // this identity (per-identity display names + header payload signals, no
    // `observations` — passing observations would harvest every OTHER
    // participant's display name into this sender through
    // `normalizedDisplayNames`, and `classifyEntityKind` is evidence-monotone
    // toward `group`/`service`, so a per-message read can answer `person`
    // here while the profile for the same sender reads `group`). One
    // classification per sender, same inputs. Bodies load only for surviving
    // senders, after the gate.
    const personGroups: SenderGroup[] = [];

    for (const group of groups.values()) {
      const senderKind = classifyEntityKind({
        identity: group.senderIdentity,
        displayNames: [...group.displayNames],
        payloadSignals: group.payloadSignals,
      });

      if (senderKind.kind !== "person") continue;

      personGroups.push(group);
    }

    if (personGroups.length === 0) return { edgesWritten: 0, checksum: checksumForEdges([]) };

    const documentIds = new Set<string>();

    for (const group of personGroups) {
      for (const message of group.messages) documentIds.add(message.documentId);
    }

    const bodies = await readDocumentBodies(ex, args.userId, documentIds);

    const edges = new Map<string, EdgeAccumulator>();

    for (const group of personGroups) {
      for (const item of group.messages) {
        const body = bodies.get(item.documentId);

        if (!isNonEmptyString(body)) continue;

        const signature = parseEmploymentSignature(body);

        if (!signature) continue;

        if (!signatureNamesSender(signature.personName, item.senderDisplayName)) continue;

        const canonicalDomain = canonicalizeIdentityValue("domain", signature.orgDomain);
        const orgIdentity = identityRefSchema.safeParse({ kind: "domain", value: canonicalDomain });

        if (!orgIdentity.success) continue;

        const key = edgeKey(group.senderIdentity, orgIdentity.data);
        const existing = edges.get(key);

        if (existing) {
          if (item.observation.occurredAt < existing.firstSeenAt) {
            existing.firstSeenAt = item.observation.occurredAt;
          }

          existing.observationIds.add(item.observation.id);
          existing.familyKeys.add(item.observation.familyKey);
          continue;
        }

        edges.set(key, {
          fromIdentity: group.senderIdentity,
          orgIdentity: orgIdentity.data,
          firstSeenAt: item.observation.occurredAt,
          observationIds: new Set([item.observation.id]),
          familyKeys: new Set([item.observation.familyKey]),
          documentId: item.documentId,
        });
      }
    }

    let edgesWritten = 0;
    const checksumRows: EdgeChecksumRow[] = [];

    const senderOutcomes = new Map<
      string,
      { fromNodeId: string; newEdges: { toNodeId: string; validFrom: Date; orgKey: string }[] }
    >();

    for (const acc of [...edges.values()].sort(compareEdgeAccumulators)) {
      const fromNode = await ensureEntityNode(
        { userId: args.userId, identity: acc.fromIdentity, firstSeenAt: acc.firstSeenAt },
        ex,
      );

      const toNode = await ensureEntityNode(
        { userId: args.userId, identity: acc.orgIdentity, firstSeenAt: acc.firstSeenAt },
        ex,
      );

      if (fromNode.id === toNode.id) continue;

      const provenance: WorksAtEdgeProvenance = {
        observationIds: [...acc.observationIds].sort(),
        familyKeys: [...acc.familyKeys].sort(),
        groundingTier: WORKS_AT_GROUNDING_TIER,
        documentId: acc.documentId,
      };

      const inserted = await ex
        .insert(entityEdges)
        .values({
          userId: args.userId,
          projectionName: USER_MODEL_PROJECTION_NAME,
          projectionVersion: args.projectionVersion,
          projectionRunId: args.projectionRunId,
          fromEntityId: fromNode.id,
          toEntityId: toNode.id,
          relationType: "works_at",
          weight: WORKS_AT_WEIGHT,
          confidence: WORKS_AT_CONFIDENCE,
          provenance,
          validFrom: acc.firstSeenAt,
        } satisfies NewEntityEdge)
        .onConflictDoNothing({
          target: [
            entityEdges.userId,
            entityEdges.projectionName,
            entityEdges.projectionVersion,
            entityEdges.relationType,
            entityEdges.fromEntityId,
            entityEdges.toEntityId,
          ],
        })
        .returning({ id: entityEdges.id });

      edgesWritten += inserted.length;
      checksumRows.push({
        from: senderKey(acc.fromIdentity),
        to: senderKey(acc.orgIdentity),
        validFrom: acc.firstSeenAt.toISOString(),
      });

      const senderMapKey = senderKey(acc.fromIdentity);
      const outcome = senderOutcomes.get(senderMapKey);

      const newEdge = {
        toNodeId: toNode.id,
        validFrom: acc.firstSeenAt,
        orgKey: senderKey(acc.orgIdentity),
      };

      if (outcome) {
        outcome.newEdges.push(newEdge);
      } else {
        senderOutcomes.set(senderMapKey, { fromNodeId: fromNode.id, newEdges: [newEdge] });
      }
    }

    // One open row per sender: the latest-grounded new edge wins, every other
    // same-tier open row for that sender in this scope closes — including a
    // same-run co-mint (a changed employer) and a prior run's row. Winner
    // election is total (latest validFrom, then greatest org key), so replays
    // converge. The `validFrom <= winner` floor keeps the
    // `entity_edges_valid_window` CHECK un-tripped on future-dated rows.
    for (const outcome of senderOutcomes.values()) {
      const winner = outcome.newEdges.reduce((a, b) =>
        b.validFrom > a.validFrom ||
        (b.validFrom.getTime() === a.validFrom.getTime() && b.orgKey > a.orgKey)
          ? b
          : a,
      );

      await ex
        .update(entityEdges)
        .set({ validUntil: winner.validFrom })
        .where(
          and(
            eq(entityEdges.userId, args.userId),
            eq(entityEdges.projectionName, USER_MODEL_PROJECTION_NAME),
            eq(entityEdges.projectionVersion, args.projectionVersion),
            eq(entityEdges.fromEntityId, outcome.fromNodeId),
            eq(entityEdges.relationType, "works_at"),
            isNull(entityEdges.validUntil),
            notInArray(entityEdges.toEntityId, [winner.toNodeId]),
            lte(entityEdges.validFrom, winner.validFrom),
            sql`${entityEdges.provenance} ->> ${GROUNDING_TIER_KEY} = ${WORKS_AT_GROUNDING_TIER}`,
          ),
        );
    }

    return { edgesWritten, checksum: checksumForEdges(checksumRows) };
  };

  return tx ? run(tx) : db().transaction(run);
}

/**
 * The sender's own trailing footer: FIRST `--` delimiter in the
 * sender-authored text (quote lines stripped first). A backwards scan returns
 * the oldest QUOTED footer on a reply or forward, binding the sender to
 * another person's org domain.
 */
function signatureBlock(body: string): string | null {
  const lines = body
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => !QUOTED_LINE_RE.test(line));

  let delimiter = -1;

  for (let i = 0; i < lines.length; i++) {
    if (SIGNATURE_DELIMITER_RE.test(lines[i] ?? "")) {
      delimiter = i;
      break;
    }
  }

  if (delimiter < 0) return null;

  const block = lines
    .slice(delimiter + 1)
    .join("\n")
    .trim();

  if (!block || block.length > MAX_SIGNATURE_CHARS) return null;

  const nonEmpty = block.split("\n").filter((line) => line.trim());

  if (nonEmpty.length === 0 || nonEmpty.length > MAX_SIGNATURE_LINES) return null;

  return block;
}

/**
 * Distinct prose-stated org domains in the block, normalized + sorted. Email
 * halves and bare hosts both count — both are prose, never the header — but
 * each must clear `domainSchema`, name a REGISTRABLE domain under a real
 * public suffix, AND read `corporate_domain` under `classifyBareDomain`.
 */
function signatureOrgDomains(block: string): string[] {
  const candidates = new Set<string>();

  for (const match of block.matchAll(EMAIL_DOMAIN_RE)) {
    if (match[1]) candidates.add(match[1]);
  }

  for (const match of block.matchAll(BARE_DOMAIN_RE)) {
    if (match[1]) candidates.add(match[1]);
  }

  const passing: string[] = [];

  for (const candidate of candidates) {
    const parsed = domainSchema.safeParse(stripWwwHost(candidate));

    if (!parsed.success) continue;

    if (!isRegistrableDomain(parsed.data)) continue;

    if (classifyBareDomain({ domain: parsed.data }) !== "corporate_domain") continue;

    passing.push(parsed.data);
  }

  return [...new Set(passing)].sort();
}

/**
 * One leading `www.` label is the web-host spelling of the org domain, not a
 * different org — footers state `www.acme.com` far more often than the bare
 * domain. Stripped by decision (not by accident): exactly one label, only the
 * literal `www`, before validation runs. `www.com` still fails (single label
 * is not a hostname); `www2.`/`www2acme.` are left alone.
 */
function stripWwwHost(domain: string): string {
  return domain.toLowerCase().startsWith("www.") ? domain.slice("www.".length) : domain;
}

/**
 * Real public-suffix gate (MF3): the candidate must be EXACTLY a registrable
 * domain — one label above a public suffix the list knows (`isIcann`), not an
 * IP, not a bare suffix (`co.uk` has no registrable domain), not a subdomain
 * (`ops.acme.com` states a host, fail-closed). This is what rejects the
 * invented strings the letter floor admitted: `inc.all` and `acme-logo.png`
 * are not ICANN-suffixed, so they mint nothing and no permanent node.
 * The suffix snapshot is pinned with the `tldts` version in package.json.
 */
function isRegistrableDomain(domain: string): boolean {
  const parsed = parseDomainName(domain);

  return (
    !parsed.isIp &&
    parsed.isIcann === true &&
    parsed.domain === domain &&
    isNonEmptyString(parsed.domainWithoutSuffix)
  );
}

/** Stated normalization for the sender-name match: case-fold + whitespace/punctuation collapse. */
function normalizeSignatureName(value: string): string {
  return collapseWhitespace(value.toLowerCase().replace(/[^a-z0-9]+/g, " "));
}

function signatureNameTokens(value: string): string[] {
  return normalizeSignatureName(value)
    .split(" ")
    .filter((token) => token.length >= 2);
}

/**
 * True iff every sender-display-name token (length ≥ 2) appears as a WHOLE
 * token in the block's stated name — no fuzzy match, no substring. The raw
 * `includes` admitted `Ann` inside `Joanna Reed` and `Jo` inside
 * `John Smith`; whole-token comparison rejects both while still accepting a
 * first-name-only footer (`Bob` in `Bob Smith`).
 */
function signatureNamesSender(blockName: string, senderDisplayName: string): boolean {
  const blockTokens = new Set(signatureNameTokens(blockName));
  const senderTokens = signatureNameTokens(senderDisplayName);

  if (senderTokens.length === 0 || blockTokens.size === 0) return false;

  return senderTokens.every((token) => blockTokens.has(token));
}

/** The sender's stated display name: the `from` participant bound to the subject identity. */
function senderDisplayName(observation: Observation, sender: IdentityRef): string | null {
  for (const participant of observation.participants.items) {
    if (participant.role !== "from") continue;

    if (participant.identity.kind !== sender.kind || participant.identity.value !== sender.value) {
      continue;
    }

    if (isNonEmptyString(participant.displayName)) return participant.displayName;
  }

  return null;
}

function senderKey(sender: IdentityRef): string {
  return JSON.stringify([sender.kind, sender.value]);
}

function edgeKey(from: IdentityRef, org: IdentityRef): string {
  return `${from.kind}\u0000${from.value}\u0000${org.value}`;
}

function compareEdgeAccumulators(a: EdgeAccumulator, b: EdgeAccumulator): number {
  return edgeKey(a.fromIdentity, a.orgIdentity).localeCompare(
    edgeKey(b.fromIdentity, b.orgIdentity),
  );
}

function checksumForEdges(rows: readonly EdgeChecksumRow[]): string {
  const stable = [...rows].sort((a, b) =>
    `${a.from}\u0000${a.to}\u0000${a.validFrom}`.localeCompare(
      `${b.from}\u0000${b.to}\u0000${b.validFrom}`,
    ),
  );

  return sha256Canonical(stable);
}

/**
 * Decoded bodies for the grounding `documentId`s, keyed by `documents.id`.
 * Missing rows read as absent. Decoded through `extractGmailDocumentBody`
 * against the stored envelope (metadata + title) so the header half of the
 * stored representation never reaches the signature read.
 */
async function readDocumentBodies(
  ex: DbTransaction,
  userId: string,
  documentIds: ReadonlySet<string>,
): Promise<Map<string, string>> {
  const ids = [...documentIds].sort();
  const bodies = new Map<string, string>();

  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);

    const rows = await ex
      .select({
        id: documents.id,
        content: documents.content,
        metadata: documents.metadata,
        title: documents.title,
      })
      .from(documents)
      .where(and(eq(documents.userId, userId), inArray(documents.id, chunk)));

    for (const row of rows) {
      const meta = parseGmailDocumentMetadata(row.metadata);
      bodies.set(
        row.id,
        extractGmailDocumentBody(row.content, {
          from: meta.from,
          to: meta.to,
          cc: meta.cc,
          subject: row.title,
        }),
      );
    }
  }

  return bodies;
}
