/**
 * Significance score (ADR-0057, builds ADR-0050 D1) — the one computed "who
 * matters" signal over `entities`, consumed by four call sites (web-search
 * enrichment gate · triage sender priority · meeting-prep · todo D1). It stays
 * a **scalar**: directional richness ("who am I *to this sender*") is composed
 * downstream by triage's Sender-relationship resolver (ADR-0059), not here.
 *
 * v1 blends header-derivable components over the correspondence aggregate
 * passive team-graph capture (P4a) writes onto each `person` entity: a
 * recency-weighted *activity* term (frequency × recency — so a fresh cold blast
 * doesn't score like a relationship), reply-reciprocity, and same-org-domain.
 * Weights and saturation constants are tunable from data (ADR-0057/0059 open
 * item); they live here as named constants, not magic numbers.
 */
import { type SignificanceBand, bucketSignificance } from "@alfred/contracts";
import { db } from "@alfred/db";
import { entities, user } from "@alfred/db/schemas";
import { and, eq, sql } from "drizzle-orm";
import {
  type CorrespondenceStats,
  type PersonEntityMetadata,
  type Significance,
  type SignificanceScoreComponents,
  parsePersonEntityMetadata,
} from "./entity-metadata";
import { jsonRecordSchema } from "./types";

export interface SignificanceWeights {
  /**
   * Recency-weighted correspondence volume (`frequency × recency`). Combined,
   * not additive: a *recent* cold blast must not score like a real
   * relationship just because it arrived yesterday (ADR-0059's exact failure
   * shape). Old-but-frequent contact decays; recent two-way contact dominates.
   */
  activity: number;
  /** Reply-reciprocity — the strongest relationship-quality signal. */
  reciprocity: number;
  /** Same-org-domain colleague bonus. */
  sameOrg: number;
}

/** Sum to 1.0 — `score` is their weighted mean, so it stays in `[0,1]`. */
export const DEFAULT_SIGNIFICANCE_WEIGHTS: SignificanceWeights = {
  activity: 0.5,
  reciprocity: 0.35,
  sameOrg: 0.15,
};

/** Correspondence volume at which the (log-scaled) frequency component ~saturates. */
const VOLUME_SATURATION = 40;
/** Half-life (days) of the recency component — ~one quarter. */
const RECENCY_HALFLIFE_DAYS = 90;
/** Co-recipient touches count for less than a direct send/receive. */
const CO_RECIPIENT_WEIGHT = 0.25;

const MS_PER_DAY = 86_400_000;

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export interface ComputeSignificanceInput {
  stats: CorrespondenceStats;
  /** Contact's domain ∈ one of the user's own account domains (work colleague signal). */
  sameOrg: boolean;
  /** Reference "now" for the recency decay (injected for determinism in tests/backfill). */
  now: Date;
}

/**
 * Pure scalar in `[0,1]`. Each component is independently `[0,1]`; the score is
 * their weight-weighted mean, so adjusting weights never pushes it out of range.
 */
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

  // A two-way thread (the user replied / initiated) is a real relationship; a
  // pure one-way inbound stream (never answered) is the cold-outreach shape
  // ADR-0059 exists to deprioritize.
  const reciprocity = stats.inbound > 0 && stats.outbound > 0 ? 1 : stats.outbound > 0 ? 0.6 : 0.2;

  const sameOrgScore = sameOrg ? 1 : 0;

  // Recency weights *volume* rather than standing alone — a fresh one-way
  // blast (high recency, zero reciprocity, low frequency) must stay low.
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

function domainOf(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

/**
 * The user's own account domains — the `same-org-domain` reference set. v1
 * derives them from the `user.email` row; connected-account domains can be
 * folded in once multi-account org detection earns it.
 */
export async function loadUserDomains(userId: string): Promise<Set<string>> {
  const rows = await db()
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  const domains = new Set<string>();
  const d = domainOf(rows[0]?.email ?? null);
  if (d) domains.add(d);
  return domains;
}

export interface RunSignificancePassOpts {
  /** Reference "now"; defaults to wall-clock at call time. */
  now?: Date;
  /** Pre-resolved user domains; loaded from the `user` row when omitted. */
  userDomains?: Set<string>;
  /** When false, compute + return scores but write nothing (dry run). */
  commit?: boolean;
  weights?: SignificanceWeights;
}

export interface SignificancePassResult {
  /** person entities considered. */
  total: number;
  /** entities whose score was (re)computed. */
  scored: number;
  /** Top entities by score, for logging — `{ name, address, score }`. */
  top: Array<{ canonicalName: string; address: string | null; score: number }>;
}

/**
 * First significance pass over the populated graph (ADR-0059 P4a). Recomputes
 * the scalar for every `person` entity from its correspondence aggregate and
 * writes it under `metadata.significance`. Idempotent — safe to re-run after a
 * fresh capture.
 */
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
  const pendingWrites: Array<{ id: string; metadata: Record<string, unknown> }> = [];

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

  // Issue the per-entity writes concurrently rather than awaiting each in the
  // loop — the pass is idempotent (re-runnable after a partial failure), so the
  // round-trips don't need a serial barrier or a single-connection transaction.
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

// ─── Sender-significance read (ADR-0064 #210 — the shared consumer-side read) ──

/**
 * One-shot read of a `person` entity's metadata bag by email *alias* — the
 * shared lookup behind {@link getSenderSignificance} and triage's
 * Sender-relationship resolver. Both must resolve a sender's graph row the same
 * way (alias match, lowercased), so the lookup lives here once rather than
 * duplicated at each consumer. Returns `null` when no `person` row carries this
 * address as an alias.
 */
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

/** The precomputed sender significance the attention scorer + lane split consume. */
export interface SenderSignificance {
  /** Precomputed scalar in `[0,1]` (ADR-0057). Never recomputed on read. */
  score: number;
  /** Bucketed band the attention scorer keys on (shared `@alfred/contracts` bucketing). */
  band: SignificanceBand;
  /** Whether the sender shares the user's org domain — read straight from the stored components. */
  sameOrg: boolean;
}

/**
 * Read the precomputed sender significance for an email address — the shared
 * "who matters" scalar (ADR-0057/0059) the briefing lane and inbox rail consume
 * to demote low-significance senders within their honest category (ADR-0064).
 * Never recomputes; one entity read.
 *
 * Returns `null` when the sender has no graph row, OR has a row but no
 * significance pass yet (a not-yet-scored two-way contact must not be mistaken
 * for a real low score). The attention scorer degrades that `null` to a neutral
 * multiplier — exactly today's intrinsic-only behavior, safe by construction.
 * Best-effort: a DB blip also yields `null` rather than failing the caller.
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

/**
 * Batched form of {@link getSenderSignificance} — resolves many sender addresses
 * to their precomputed significance in a *single* alias query, returning a map
 * keyed by normalized (trimmed/lowercased) address. Addresses with no scored
 * `person` row are simply absent (the caller treats absence as neutral), exactly
 * like the one-shot read. Use this on fan-out read paths (e.g. a briefing email
 * list) where calling the one-shot per address would be an N+1. Best-effort: a
 * DB blip yields an empty map rather than failing the caller.
 */
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
            WHERE lower(alias) = ANY(${targetList})
          )`,
        ),
      );
  } catch {
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
    // Map every requested address this entity carries as an alias back to its
    // significance — one entity can answer several of the distinct senders.
    const aliases = Array.isArray(row.aliases) ? row.aliases : [];
    for (const alias of aliases) {
      if (typeof alias !== "string") continue;
      const normalized = alias.trim().toLowerCase();
      if (targets.has(normalized)) out.set(normalized, resolved);
    }
  }

  return out;
}
