/**
 * Significance score (ADR-0057): one "who matters" scalar per `person` entity.
 * Blends recency-weighted activity, reply reciprocity, and same-org domain.
 * Directional context ("who am I to this sender") is triage's job (ADR-0059).
 */
import {
  type SignificanceBand,
  bucketSignificance,
  clamp01,
  emailDomain,
  jsonRecordSchema,
  toMessage,
  toStringArray,
  type JsonObject,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { entities, user } from "@alfred/db/schemas";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  type CorrespondenceStats,
  type PersonEntityMetadata,
  type Significance,
  type SignificanceScoreComponents,
  parsePersonEntityMetadata,
} from "./entity-metadata";

export interface SignificanceWeights {
  /** Frequency × recency, so a fresh cold blast does not score like a relationship. */
  activity: number;
  /** The strongest relationship signal. */
  reciprocity: number;
  sameOrg: number;
}

/** Sum to 1.0, so `score` stays in `[0,1]`. */
export const DEFAULT_SIGNIFICANCE_WEIGHTS: SignificanceWeights = {
  activity: 0.5,
  reciprocity: 0.35,
  sameOrg: 0.15,
};

/** Volume at which the log-scaled frequency nears 1. */
const VOLUME_SATURATION = 40;

/** Decay time constant in days: recency falls to 1/e (not 1/2) after this long. */
const RECENCY_HALFLIFE_DAYS = 90;

/** Co-recipient touches count for less than a direct send/receive. */
const CO_RECIPIENT_WEIGHT = 0.25;

const MS_PER_DAY = 86_400_000;

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export interface ComputeSignificanceInput {
  stats: CorrespondenceStats;
  /** The contact's domain is one of the user's own domains. */
  sameOrg: boolean;
  /** Injected for deterministic tests and backfills. */
  now: Date;
}

/** Pure scalar in `[0,1]`: a weighted mean of `[0,1]` components. */
export function computeSignificance(
  input: ComputeSignificanceInput,
  weights: SignificanceWeights = DEFAULT_SIGNIFICANCE_WEIGHTS,
): Significance {
  const { stats, sameOrg, now } = input;

  const volume = stats.inbound + stats.outbound + CO_RECIPIENT_WEIGHT * stats.coRecipient;
  const frequency = volume <= 0 ? 0 : clamp01(Math.log1p(volume) / Math.log1p(VOLUME_SATURATION));

  const lastSeen = stats.lastSeenAt ? new Date(stats.lastSeenAt) : null;

  const recency =
    lastSeen && !Number.isNaN(lastSeen.getTime())
      ? clamp01(
          Math.exp(
            -Math.max(0, now.getTime() - lastSeen.getTime()) / MS_PER_DAY / RECENCY_HALFLIFE_DAYS,
          ),
        )
      : 0;

  // Never-answered inbound is the cold-outreach shape ADR-0059 deprioritizes.
  const reciprocity = stats.inbound > 0 && stats.outbound > 0 ? 1 : stats.outbound > 0 ? 0.6 : 0.2;

  const sameOrgScore = sameOrg ? 1 : 0;

  // Recency scales volume, so a fresh one-way blast stays low.
  const activity = frequency * recency;

  const components: SignificanceScoreComponents = {
    frequency: round3(frequency),
    recency: round3(recency),
    reciprocity: round3(reciprocity),
    sameOrg: sameOrgScore,
  };

  const score = clamp01(
    weights.activity * activity +
      weights.reciprocity * reciprocity +
      weights.sameOrg * sameOrgScore,
  );

  return { score: round3(score), components, computedAt: now.toISOString() };
}

/** The user's own domains, from `user.email` only for now. */
export async function loadUserDomains(userId: string): Promise<Set<string>> {
  const rows = await db()
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  const domains = new Set<string>();
  // `user.email` has no schema gate; an unusable address gives `null` and same-org 0.
  const d = emailDomain(rows[0]?.email ?? null);

  if (d) domains.add(d);

  return domains;
}

export interface RunSignificancePassOpts {
  now?: Date;
  /** Loaded from the `user` row when omitted. */
  userDomains?: Set<string>;
  /** False: compute and return scores, write nothing. */
  commit?: boolean;
  weights?: SignificanceWeights;
}

export interface SignificancePassResult {
  /** Person entities considered. */
  total: number;
  /** Entities scored. */
  scored: number;
  /** Top entities by score, for logging. */
  top: Array<{ canonicalName: string; address: string | null; score: number }>;
}

/** Recompute every `person` entity's score into `metadata.significance` (ADR-0059 P4a). Idempotent. */
export async function runSignificancePass(
  userId: string,
  opts: RunSignificancePassOpts = {},
): Promise<SignificancePassResult> {
  const now = opts.now ?? new Date();
  const commit = opts.commit ?? false;
  const userDomains = opts.userDomains ?? (await loadUserDomains(userId));
  const weights = opts.weights ?? DEFAULT_SIGNIFICANCE_WEIGHTS;

  const rows = await db()
    .select({
      id: entities.id,
      canonicalName: entities.canonicalName,
      metadata: entities.metadata,
    })
    .from(entities)
    .where(and(eq(entities.userId, userId), eq(entities.kind, "person")));

  const scoredRows: Array<{ canonicalName: string; address: string | null; score: number }> = [];
  const pendingWrites: Array<{ id: string; metadata: JsonObject }> = [];

  for (const row of rows) {
    const meta = parsePersonEntityMetadata(row.metadata);
    const stats = meta.correspondence;

    if (!stats) continue; // no correspondence aggregate → nothing to score

    const sameOrg = meta.domain ? userDomains.has(meta.domain) : false;
    const significance = computeSignificance({ stats, sameOrg, now }, weights);

    scoredRows.push({
      canonicalName: row.canonicalName,
      address: meta.primaryAddress ?? null,
      score: significance.score,
    });

    if (commit) {
      pendingWrites.push({
        id: row.id,
        metadata: { ...jsonRecordSchema.parse(row.metadata), significance },
      });
    }
  }

  // Concurrent writes are fine: the pass is idempotent.
  if (pendingWrites.length > 0) {
    await Promise.all(
      pendingWrites.map((write) =>
        db()
          .update(entities)
          .set({ metadata: write.metadata, rowVersion: sql`${entities.rowVersion} + 1` })
          .where(eq(entities.id, write.id)),
      ),
    );
  }

  scoredRows.sort((a, b) => b.score - a.score);

  return { total: rows.length, scored: scoredRows.length, top: scoredRows.slice(0, 15) };
}

// ─── Sender-significance read (ADR-0064 #210) ────────────────────────────────

/** A `person` row's metadata by lowercased email alias, or `null`. Shared with triage's sender resolver. */
export async function findPersonMetadataByAddress(
  userId: string,
  address: string,
): Promise<PersonEntityMetadata | null> {
  const target = address.trim().toLowerCase();

  if (!target) return null;

  const rows = await db()
    .select({ metadata: entities.metadata })
    .from(entities)
    .where(
      and(
        eq(entities.userId, userId),
        eq(entities.kind, "person"),
        sql`EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(${entities.aliases}) AS alias
          WHERE lower(alias) = ${target}
        )`,
      ),
    )
    .limit(1);

  if (rows.length === 0) return null;

  return parsePersonEntityMetadata(rows[0]?.metadata);
}

export interface SenderSignificance {
  /** Precomputed (ADR-0057); never recomputed on read. */
  score: number;
  band: SignificanceBand;
  sameOrg: boolean;
}

/**
 * Precomputed sender significance (ADR-0064). `null` when the sender has no row
 * or no score yet, so an unscored contact is not read as a low score. A DB error also gives `null`.
 */
export async function getSenderSignificance(
  userId: string,
  address: string | null | undefined,
): Promise<SenderSignificance | null> {
  if (!address) return null;

  let meta: PersonEntityMetadata | null;

  try {
    meta = await findPersonMetadataByAddress(userId, address);
  } catch {
    return null;
  }

  const significance = meta?.significance;

  if (!significance) return null;

  return {
    score: significance.score,
    band: bucketSignificance(significance.score),
    sameOrg: significance.components.sameOrg >= 1,
  };
}

/** Batched {@link getSenderSignificance}, keyed by lowercased address. Missing means neutral. A DB error gives an empty map. */
export async function getSenderSignificanceBatch(
  userId: string,
  addresses: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, SenderSignificance>> {
  const out = new Map<string, SenderSignificance>();

  const targets = new Set<string>();

  for (const raw of addresses) {
    const normalized = raw?.trim().toLowerCase();

    if (normalized) targets.add(normalized);
  }

  if (targets.size === 0) return out;
  const targetList = [...targets];

  let rows: { metadata: unknown; aliases: unknown }[];

  try {
    rows = await db()
      .select({ metadata: entities.metadata, aliases: entities.aliases })
      .from(entities)
      .where(
        and(
          eq(entities.userId, userId),
          eq(entities.kind, "person"),
          sql`EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(${entities.aliases}) AS alias
            WHERE ${inArray(sql`lower(alias)`, targetList)}
          )`,
        ),
      );
  } catch (err) {
    console.warn(`[knowledge.significance] batch alias read failed: ${toMessage(err)}`);

    return out;
  }

  for (const row of rows) {
    const meta = parsePersonEntityMetadata(row.metadata);
    const significance = meta?.significance;

    if (!significance) continue;

    const resolved: SenderSignificance = {
      score: significance.score,
      band: bucketSignificance(significance.score),
      sameOrg: significance.components.sameOrg >= 1,
    };

    // One entity can answer several requested addresses.
    const aliases = toStringArray(row.aliases);

    for (const alias of aliases) {
      const normalized = alias.trim().toLowerCase();

      if (targets.has(normalized)) out.set(normalized, resolved);
    }
  }

  return out;
}
