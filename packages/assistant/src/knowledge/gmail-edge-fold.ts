/**
 * Grounded `works_at` edge fold (ADR-0067 `entity_edges`, issue #1108 deferred half).
 *
 * The legacy graph minted `works_at` from the sender domain, which restates the
 * `From:` header and carries no evidence. This fold mints `works_at` only from
 * STATED evidence: an inbound message whose body holds a signature block naming
 * the sender and stating the org domain, sent by an address the kind classifier
 * reads as `person` (a signature-shaped bulk footer states a domain too — the
 * sender-person gate keeps notification mailboxes off the graph). Never from
 * the address.
 *
 * Invariant: after any allowed sequence of Gmail projection runs, refolds, and
 * activation flips, every `works_at` row in `entity_edges` names in its
 * provenance a live-head `gmail/email_message` observation plus the `documentId`
 * whose inbound body holds a signature block stating the edge's org domain —
 * and no `works_at` row exists whose org domain appears only in the message's
 * `From:` header.
 *
 * Deterministic core, no LLM anywhere in v1: the signature read is a pure
 * function over body text, the sender-name match is a stated normalization
 * (case-fold + whitespace/punctuation collapse, no fuzzy match), and the domain
 * comes from the `domain.ts` leaf + a `classifyBareDomain` deny-gate. An
 * "introduction" is free prose that needs judgment and has no edge
 * propose-dispose pipeline, so introductions mint NOTHING in v1 (item 70 owns
 * the LLM follow-up). Name-only signatures (company without a stated domain)
 * mint NOTHING — no org-name→domain resolution exists.
 *
 * Split of the all-must-hold bar: `parseEmploymentSignature` extracts the
 * block's stated name line + org domain from body text alone; the sender-name
 * match lives in `projectGmailWorksAtEdges`, which is the only side that holds
 * the observation's sender display name.
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
  gmailEmailMessagePayloadSchema,
  identityRefSchema,
  isNonEmptyString,
  type EntityEdgeType,
  type GroundingTier,
  type IdentityRef,
  type ProjectionCursorValue,
  type ProjectionProvenance,
} from "@alfred/contracts";
import { db, type DbTransaction } from "@alfred/db";
import {
  documents,
  entityEdges,
  observationFamilyHeads,
  observations,
  type EntityEdgeInsert,
  type Observation,
} from "@alfred/db/schemas";
import { and, asc, eq, inArray } from "drizzle-orm";
import { ensureEntityNode } from "./entities";
import { classifyEntityKind } from "./entity-kind-classifier";
import { gmailHighWatermarkCondition } from "./gmail-kind-fold";
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
}

export interface ProjectGmailWorksAtEdgesResult {
  readonly edgesWritten: number;
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

/** A signature delimiter: RFC-3676 `-- ` or its bare `--` structural equivalent. */
const SIGNATURE_DELIMITER_RE = /^--\s*$/;

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
 * present; the trailing block is footer-sized; its first content line is
 * name-shaped; and the block states EXACTLY ONE distinct org domain that parses
 * via `domainSchema` and reads `corporate_domain` under `classifyBareDomain`
 * (a signature claiming `gmail.com` is not an employer claim; a block naming
 * two orgs is ambiguous and mints nothing).
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

/**
 * Fold live-head inbound `gmail/email_message` observations in the watermark
 * window into grounded `works_at` edges. Envelope (sender identity,
 * `occurredAt`, `documentId`) comes from the observation; prose comes from a
 * `documents` join on `payload.documentId` (the observation log stays
 * prose-free — the payload schema is `.strict()` with no body text).
 *
 * One edge per distinct (sender, org-domain) pair: `valid_from` is the earliest
 * grounding observation (replay purity — no wall-clock default), provenance
 * carries every grounding observation plus the tier + the first grounding
 * `documentId`. Repeat pairs in one run collapse before the write; replays
 * collide on the unique `(user, name, version, relation, from, to)` index and
 * are a no-op. Identity links (`recordEntityIdentity`) are deliberately NOT
 * written here — the kind fold already binds the sender email, and domain
 * binding waits on the merge-signal owner.
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

    const inbound: {
      observation: Observation;
      documentId: string;
      senderIdentity: IdentityRef;
      senderDisplayName: string;
    }[] = [];

    const documentIds = new Set<string>();

    for (const { observation } of rows) {
      const payload = gmailEmailMessagePayloadSchema.safeParse(observation.payload);

      if (!payload.success || payload.data.isSent) continue;

      const subject = identityRefSchema.safeParse(observation.subjectIdentity);

      if (!subject.success || subject.data.kind !== "email") continue;

      const displayName = senderDisplayName(observation, subject.data);

      if (!isNonEmptyString(displayName)) continue;

      inbound.push({
        observation,
        documentId: payload.data.documentId,
        senderIdentity: subject.data,
        senderDisplayName: displayName,
      });
      documentIds.add(payload.data.documentId);
    }

    if (inbound.length === 0) return { edgesWritten: 0 };

    const bodies = await readDocumentBodies(ex, args.userId, documentIds);

    const edges = new Map<string, EdgeAccumulator>();

    for (const item of inbound) {
      // Sender-person gate FIRST: a signature-shaped footer on bulk mail
      // (measured: 53/53 corpus parses are GitHub notification footers) must
      // not mint `works_at` on the service mailbox behind it — and an
      // org-named sender ("GitHub") would otherwise clear the name match
      // against its own footer. Only `person` mints; every other kind
      // (service/group/unknown/…) skips fail-closed. The classifier reads its
      // header signals off the observation itself, so no second extractor.
      const senderKind = classifyEntityKind({
        identity: item.senderIdentity,
        displayNames: [item.senderDisplayName],
        observations: [item.observation],
      });

      if (senderKind.kind !== "person") continue;

      const body = bodies.get(item.documentId);

      if (!isNonEmptyString(body)) continue;

      const signature = parseEmploymentSignature(body);

      if (!signature) continue;

      if (!signatureNamesSender(signature.personName, item.senderDisplayName)) continue;

      const canonicalDomain = canonicalizeIdentityValue("domain", signature.orgDomain);
      const orgIdentity = identityRefSchema.safeParse({ kind: "domain", value: canonicalDomain });

      if (!orgIdentity.success) continue;

      const key = edgeKey(item.senderIdentity, orgIdentity.data);
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
        fromIdentity: item.senderIdentity,
        orgIdentity: orgIdentity.data,
        firstSeenAt: item.observation.occurredAt,
        observationIds: new Set([item.observation.id]),
        familyKeys: new Set([item.observation.familyKey]),
        documentId: item.documentId,
      });
    }

    let edgesWritten = 0;

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

      const provenance: ProjectionProvenance = {
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
        } satisfies EntityEdgeInsert)
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
    }

    return { edgesWritten };
  };

  return tx ? run(tx) : db().transaction(run);
}

/** Trailing footer after the last `--` delimiter, or null when footer-shaped rules fail. */
function signatureBlock(body: string): string | null {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  let delimiter = -1;

  for (let i = lines.length - 1; i >= 0; i--) {
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
 * each must clear `domainSchema` AND read `corporate_domain` under
 * `classifyBareDomain`. The TLD-letter floor rejects version numbers and IPs
 * (`1.2`, `192.168.1.1`) before the grammar runs.
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
    if (!hasLetterTld(candidate)) continue;

    const parsed = domainSchema.safeParse(candidate);

    if (!parsed.success) continue;

    if (classifyBareDomain({ domain: parsed.data }) !== "corporate_domain") continue;

    passing.push(parsed.data);
  }

  return [...new Set(passing)].sort();
}

function hasLetterTld(domain: string): boolean {
  const parts = domain.split(".");
  const tld = parts[parts.length - 1] ?? "";

  return tld.length >= 2 && /[A-Za-z]/.test(tld);
}

/** Stated normalization for the sender-name match: case-fold + whitespace/punctuation collapse. */
function normalizeSignatureName(value: string): string {
  return collapseWhitespace(value.toLowerCase().replace(/[^a-z0-9]+/g, " "));
}

/**
 * True iff the block's stated name contains the sender display name under the
 * stated normalization — no fuzzy match. A one-character display name never
 * matches: it would read as evidence inside any block.
 */
function signatureNamesSender(blockName: string, senderDisplayName: string): boolean {
  const blockNorm = normalizeSignatureName(blockName);
  const senderNorm = normalizeSignatureName(senderDisplayName);

  if (senderNorm.length < 2 || blockNorm.length === 0) return false;

  return blockNorm.includes(senderNorm);
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

function edgeKey(from: IdentityRef, org: IdentityRef): string {
  return `${from.kind}\u0000${from.value}\u0000${org.value}`;
}

function compareEdgeAccumulators(a: EdgeAccumulator, b: EdgeAccumulator): number {
  return edgeKey(a.fromIdentity, a.orgIdentity).localeCompare(
    edgeKey(b.fromIdentity, b.orgIdentity),
  );
}

/** Bodies for the grounding `documentId`s, keyed by `documents.id`. Missing rows read as absent. */
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
      .select({ id: documents.id, content: documents.content })
      .from(documents)
      .where(and(eq(documents.userId, userId), inArray(documents.id, chunk)));

    for (const row of rows) bodies.set(row.id, row.content);
  }

  return bodies;
}
