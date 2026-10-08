/**
 * Display-only attention score (ADR-0064). The briefing and the inbox rail use it to
 * re-rank and mute items. It never changes the triage category.
 * The weights and cutoffs are first guesses, to tune from prod data.
 */
import { z } from "zod";
import type { TriageCategory } from "./triage";

// ─── Significance bucketing (ADR-0059) ───

export const SIGNIFICANCE_BANDS = ["strong", "moderate", "weak"] as const;

export type SignificanceBand = (typeof SIGNIFICANCE_BANDS)[number];

export const significanceBandSchema = z.enum(SIGNIFICANCE_BANDS);

export const SIGNIFICANCE_STRONG_AT = 0.66;

export const SIGNIFICANCE_MODERATE_AT = 0.33;

export function bucketSignificance(score: number): SignificanceBand {
  if (score >= SIGNIFICANCE_STRONG_AT) return "strong";

  if (score >= SIGNIFICANCE_MODERATE_AT) return "moderate";

  return "weak";
}

// ─── Attention bands ─────────────────────────────────────────────────────────

export const ATTENTION_BANDS = ["demanding", "normal", "muted"] as const;

export type AttentionBand = (typeof ATTENTION_BANDS)[number];

export const attentionBandSchema = z.enum(ATTENTION_BANDS);

/**
 * Demand per category. This is the ceiling: significance and recurrence only lower it.
 * `awaiting_reply` starts high so a weak cold sender drops out and a strong one stays.
 */
export const CATEGORY_BASE_DEMAND = {
  urgent: 1.0,
  action_needed: 0.85,
  awaiting_reply: 0.7,
  follow_up: 0.55,
  meeting: 0.55,
  payment: 0.55,
  fyi: 0.2,
  done: 0.0,
  newsletter: 0.1,
  marketing: 0.05,
} as const satisfies Record<TriageCategory, number>;

/** Demotion per band. An unscored sender keeps the base. Nothing goes above 1. */
const SIGNIFICANCE_MULTIPLIER = {
  strong: 1.0,
  moderate: 0.7,
  weak: 0.4,
} satisfies Record<SignificanceBand, number>;

/** The Nth repeat of a bulk notification scores `1 / (1 + DECAY * N)` of the base. */
const RECURRENCE_DECAY = 0.35;

export const DEMANDING_AT = 0.6;

export const MUTED_BELOW = 0.3;

export function attentionBand(score: number): AttentionBand {
  if (score >= DEMANDING_AT) return "demanding";

  if (score < MUTED_BELOW) return "muted";

  return "normal";
}

export interface AttentionInput {
  category: TriageCategory;
  /** Missing means unscored, which means no demotion. */
  significanceBand?: SignificanceBand | null | undefined;
  /** Count of earlier copies in the window. Used only when `isBulkSender`. */
  recurrenceIndex?: number;
  /** A human who repeats is more persistent, not less demanding, so only bots decay. */
  isBulkSender?: boolean;
  /** Security pin (ADR-0051): always `demanding`, whatever else applies. */
  pinnedDemanding?: boolean | undefined;
}

export interface AttentionResult {
  score: number;
  band: AttentionBand;
}

/** `base × significance × recurrence`, clamped to `[0,1]`. Recurrence can mute even a bulk `urgent`. */
export function attentionScore(input: AttentionInput): AttentionResult {
  const base = CATEGORY_BASE_DEMAND[input.category];
  const sigMult = input.significanceBand ? SIGNIFICANCE_MULTIPLIER[input.significanceBand] : 1;

  const recurrenceMult =
    input.isBulkSender && input.recurrenceIndex && input.recurrenceIndex > 0
      ? 1 / (1 + RECURRENCE_DECAY * input.recurrenceIndex)
      : 1;

  const score = Math.max(0, Math.min(1, base * sigMult * recurrenceMult));

  if (input.pinnedDemanding) {
    return { score: Math.max(score, DEMANDING_AT), band: "demanding" };
  }

  return { score, band: attentionBand(score) };
}

/** Subject key for repeats: drops `Re:`/`[FIRING]` prefixes and digits, which drift between copies. */
export function normalizeSubjectForRecurrence(subject: string): string {
  let s = subject.toLowerCase().trim();

  for (;;) {
    const next = s.replace(/^\s*(?:re|fwd|fw|aw)\s*:\s*/i, "").replace(/^\s*\[[^\]]*\]\s*/, "");

    if (next === s) break;
    s = next;
  }

  return s
    .replace(/\d+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// ─── Bulk-sender detection (recurrence-decay gate) ───────────────────────────
// The read paths lack the classifier's `SenderContext`, so guess from the address.
// Err toward "human": a false match demotes a person. `team@`, `info@`, and
// `support@` are often staffed, so they do not match.

const BULK_LOCALPART_RE =
  /(?:^|[._+-])(?:no-?reply|do-?not-?reply|donotreply|notifications?|notify|mailer-daemon|mailer|automated|auto-?confirm|bounces?|alerts?|postmaster)(?:[._+-]|$)/;

function senderAddress(from: string | null | undefined): string | null {
  if (!from) return null;
  const trimmed = from.trim();

  if (!trimmed) return null;
  const angle = trimmed.match(/<([^>]+)>/);
  const addr = (angle?.[1] ?? trimmed).trim().toLowerCase();

  return addr || null;
}

export function isLikelyBulkSender(from: string | null | undefined): boolean {
  const addr = senderAddress(from);

  if (!addr) return false;
  const at = addr.indexOf("@");
  const local = at >= 0 ? addr.slice(0, at) : addr;

  return BULK_LOCALPART_RE.test(local);
}

// ─── Windowed item scoring (the cross-row recurrence pass) ───────────────────

/** Unit separator: it cannot occur in an address or a normalized subject, so keys never collide. */
const RECURRENCE_KEY_SEP = "\u001f";

export interface AttentionItemInput {
  /** Raw `From` header. */
  sender: string | null | undefined;
  subject: string | null | undefined;
  category: TriageCategory;
  significanceBand?: SignificanceBand | null | undefined;
  pinnedDemanding?: boolean | undefined;
  /** Epoch ms. Repeats are counted oldest-first by this, not by input order. */
  occurredAtMs?: number | null | undefined;
}

/**
 * Score a window of items, so repeats can be counted across rows.
 * Bulk items group by `(address, normalizedSubject)`. Results keep the input order.
 */
export function scoreAttentionForItems(items: readonly AttentionItemInput[]): AttentionResult[] {
  const entries = items.map((item, index) => ({
    item,
    index,
    bulk: isLikelyBulkSender(item.sender),
    recurrenceIndex: 0,
  }));

  // The sorted copy shares entry objects, so these writes reach `entries`.
  const seen = new Map<string, number>();

  const chronological = [...entries].sort(
    (a, b) => (a.item.occurredAtMs ?? 0) - (b.item.occurredAtMs ?? 0) || a.index - b.index,
  );

  for (const entry of chronological) {
    if (!entry.bulk) continue;
    const key = `${senderAddress(entry.item.sender) ?? ""}${RECURRENCE_KEY_SEP}${normalizeSubjectForRecurrence(entry.item.subject ?? "")}`;
    const idx = seen.get(key) ?? 0;
    entry.recurrenceIndex = idx;
    seen.set(key, idx + 1);
  }

  return entries.map(({ item, bulk, recurrenceIndex }) =>
    attentionScore({
      category: item.category,
      significanceBand: item.significanceBand,
      isBulkSender: bulk,
      recurrenceIndex,
      pinnedDemanding: item.pinnedDemanding,
    }),
  );
}
