/**
 * Grounded `works_at` edge fold (ADR-0067 `entity_edges`, #1108).
 *
 * Invariant: every `works_at` row names a live-head `gmail/email_message`
 * observation and the `documentId` whose body has a signature that states the
 * org domain. A domain seen only in the `From:` header never mints an edge.
 *
 * Deterministic, no LLM. Introductions and name-only signatures mint nothing.
 * The sender must classify as `person` from its own display names and header
 * signals, never from other participants' names. Shadow-only: the backfill runs
 * it without activation, so `readUserContext` still reads the legacy graph.
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

/** The block's stated name and org domain. */
export interface EmploymentSignature {
  /** First content line of the block. */
  readonly personName: string;
  /** Stated in prose, normalized by `domainSchema`; never the header domain. */
  readonly orgDomain: string;
  /** Unset: no title extraction exists. */
  readonly role?: string | undefined;
}

export interface ProjectGmailWorksAtEdgesArgs {
  readonly userId: string;
  readonly projectionRunId: string;
  readonly projectionVersion: number;
  /** Inclusive replay bound, the same one the kind fold uses in this run. */
  readonly gmailHighWatermark?: ProjectionCursorValue | undefined;
  /** The user's own addresses. User affiliation belongs to the identity-facts projection, not here. */
  readonly excludeEmailValues: readonly string[];
}

export interface ProjectGmailWorksAtEdgesResult {
  readonly edgesWritten: number;
  /** Hash of the edge set, so dry runs compare sets, not counts. */
  readonly checksum: string;
}

/** The sender's own signature about the sender. */
const WORKS_AT_GROUNDING_TIER =
  "self_authored_profile_or_signature" as const satisfies GroundingTier;

/** Below 1: a signature is not directory-verified. */
const WORKS_AT_CONFIDENCE = 0.8;

const WORKS_AT_WEIGHT = 1;

/** `ProjectionProvenance` is a loose object, so this makes the invariant's two keys required at the writer. */
interface WorksAtEdgeProvenance extends ProjectionProvenance {
  readonly groundingTier: GroundingTier;
  readonly documentId: string;
}

/** Typed so a key rename fails the build: `->>` on a missing key is NULL and silently matches nothing. */
const GROUNDING_TIER_KEY = "groundingTier" satisfies keyof WorksAtEdgeProvenance;

/** A signature delimiter: RFC-3676 `-- ` or its bare `--` structural equivalent. */
const SIGNATURE_DELIMITER_RE = /^--\s*$/;

/** A plain-text quote line. Quoted regions are the correspondent's, never the sender's. */
const QUOTED_LINE_RE = /^\s*>/;

/** A "signature" longer than this is a quoted thread, not a footer. */
const MAX_SIGNATURE_LINES = 30;

const MAX_SIGNATURE_CHARS = 2000;

const MAX_PERSON_NAME_CHARS = 120;

/** `jane@acme.com` in prose; the domain half is a candidate. */
const EMAIL_DOMAIN_RE =
  /[A-Za-z0-9._%+-]+@([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,})/g;

/** Bare `acme.com` or `https://acme.com/about` in prose. */
const BARE_DOMAIN_RE =
  /(?<![A-Za-z0-9@_.-])([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)(?![A-Za-z0-9.-])/g;

/**
 * Read the sender's signature: the first `--` delimiter after quote lines are
 * stripped, a footer-sized block, a name-shaped first line, and exactly one
 * corporate org domain. Two domains are ambiguous and mint nothing.
 * HTML mail arrives flattened with no `>` quotes, so the name match is the backstop there.
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
 * `works_at` allows only `self_authored_profile_or_signature` and `user_correction`.
 * User-scoped tiers would bring back domain-derived minting. `weak_mentions` never
 * promotes (ADR-0080 invariant 6). Other edge types have no grounding path yet.
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
  /** Header list/bulk signals from this sender's observations, sent included. */
  readonly payloadSignals: GmailPayloadSignals[];
  readonly messages: SenderMessage[];
}

/**
 * Fold live-head inbound `gmail/email_message` observations into grounded
 * `works_at` edges. Bodies come from `documents` through `extractGmailDocumentBody`,
 * so the `From:` header cannot reach the signature read.
 *
 * One edge per (sender, org domain); `valid_from` is the earliest grounding, so
 * replays are a no-op. A new org closes the sender's other same-tier open rows.
 * Two real concurrent employers collapse to the latest one.
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

      // Signals come from every subject observation, sent included, like the kind fold. Only inbound mints.
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

    // A display name counts only for its own participant, like `collectIdentities`.
    // Else the user's name on every `to:` line makes almost every sender a person.
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

    // Person gate first, with the kind fold's exact inputs and no `observations`,
    // so this answer matches the sender's profile. Bodies load only for survivors.
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

    // One open row per sender. Winner: latest validFrom, then greatest org key, so replays converge.
    // The `validFrom <= winner` floor keeps the `entity_edges_valid_window` CHECK passing.
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

/** The first `--` after quote lines are stripped. The last one on a reply is a quoted footer. */
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

/** Distinct corporate, registrable org domains in the block, sorted. */
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

/** Strip one literal `www.` label: footers usually state `www.acme.com`. */
function stripWwwHost(domain: string): string {
  return domain.toLowerCase().startsWith("www.") ? domain.slice("www.".length) : domain;
}

/**
 * True only for a registrable domain under an ICANN suffix: not an IP, a bare
 * suffix, or a subdomain. This rejects strings like `acme-logo.png`.
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

/** Case-fold and collapse whitespace and punctuation. */
function normalizeSignatureName(value: string): string {
  return collapseWhitespace(value.toLowerCase().replace(/[^a-z0-9]+/g, " "));
}

function signatureNameTokens(value: string): string[] {
  return normalizeSignatureName(value)
    .split(" ")
    .filter((token) => token.length >= 2);
}

/** Every sender name token (2+ chars) must be a whole token in the block name. `Ann` must not match `Joanna`. */
function signatureNamesSender(blockName: string, senderDisplayName: string): boolean {
  const blockTokens = new Set(signatureNameTokens(blockName));
  const senderTokens = signatureNameTokens(senderDisplayName);

  if (senderTokens.length === 0 || blockTokens.size === 0) return false;

  return senderTokens.every((token) => blockTokens.has(token));
}

/** The `from` participant's display name for the subject identity. */
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

/** Bodies keyed by `documents.id`, decoded so the stored header never reaches the signature read. */
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
