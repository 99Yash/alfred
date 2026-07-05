/**
 * Presentation-layer attention scoring (ADR-0064, #210 / epic #218 Tier 2).
 *
 * Triage over-tags attention because the classifier decides demand from message
 * *shape*, blind to the user's standing relative to the sender and to
 * recurrence. The fix is NOT a category change — `email_triage.category` is
 * honest and immutable (ADR-0048/0059-(e)/0060-m4). Instead, the *consumer*
 * (briefing lane + inbox rail) computes a deterministic `[0,1]` attention score,
 * projected to three display bands, from signals already on hand, and uses it to
 * re-rank and visually de-emphasize — never to re-tag.
 *
 * This module is the single source of scoring truth: it lives in
 * `@alfred/contracts` (web-safe, zero Node deps — the same home as the briefing
 * contract) so the server-side briefing renderer and the client-side rail share
 * one formula. It is pure and deterministic — the cheap-to-cover surface that
 * the unit tests pin.
 *
 * The numbers below (base-demand weights, band cutoffs, multipliers) are seeded
 * by judgment and meant to be tuned from the prod distribution — the shared
 * tuning surface with the ADR-0057/0059 significance weights.
 */
import { z } from "zod";
import type { TriageCategory } from "./triage.js";

// ─── Significance bucketing (shared with the sender-relationship resolver) ───
// The same two cutoffs the ADR-0059 resolver uses (0.66 / 0.33). Kept here so
// the scorer and the `getSenderSignificance` read share one bucketing truth;
// the resolver may later import these to dedupe its local copy.

export const SIGNIFICANCE_BANDS = ["strong", "moderate", "weak"] as const;
export type SignificanceBand = (typeof SIGNIFICANCE_BANDS)[number];

/** Zod enum over {@link SIGNIFICANCE_BANDS} — the synced-tag field reuses this. */
export const significanceBandSchema = z.enum(SIGNIFICANCE_BANDS);

export const SIGNIFICANCE_STRONG_AT = 0.66;
export const SIGNIFICANCE_MODERATE_AT = 0.33;

/** Significance scalar `[0,1]` → band. */
export function bucketSignificance(score: number): SignificanceBand {
  if (score >= SIGNIFICANCE_STRONG_AT) return "strong";
  if (score >= SIGNIFICANCE_MODERATE_AT) return "moderate";
  return "weak";
}

// ─── Attention bands ─────────────────────────────────────────────────────────

export const ATTENTION_BANDS = ["demanding", "normal", "muted"] as const;
export type AttentionBand = (typeof ATTENTION_BANDS)[number];

/** Zod enum over {@link ATTENTION_BANDS} — reused by persisted contracts (day-shape). */
export const attentionBandSchema = z.enum(ATTENTION_BANDS);

/**
 * Intrinsic per-category demand — the **floor**. Significance and recurrence
 * move an item *within* and *down* from its category's demand, never *up* past
 * it. Ordering follows ADR-0064: `urgent` > `action_needed` > `awaiting_reply` >
 * `follow_up`/`meeting`/`payment`, with the non-demanding categories at the
 * bottom. A high base for `awaiting_reply` is deliberate — it starts demanding,
 * then a low-significance cold sender (a LinkedIn ask) gets pulled down into the
 * ambient tail; a known-important sender keeps it demanding.
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

/**
 * Significance band → demotion multiplier. `null` (unscored / non-human / no
 * graph row) keeps the base — exactly today's intrinsic-only behavior, safe by
 * construction. Only a *real* low score (`weak`) demotes hard; significance
 * never pushes *above* the category floor (`strong` = 1.0, not >1).
 */
const SIGNIFICANCE_MULTIPLIER: Record<SignificanceBand, number> = {
  strong: 1.0,
  moderate: 0.7,
  weak: 0.4,
};

/**
 * Per-repeat recurrence decay. The Nth repeat of a `(sender, normalizedSubject)`
 * pair is `1 / (1 + DECAY * index)` as demanding — a machine notification fired
 * ten times is, to the human, the definition of *not* urgent.
 */
const RECURRENCE_DECAY = 0.35;

/** Band cutoffs — the only display knobs (mirrors ADR-0059 word-bucketing). */
export const DEMANDING_AT = 0.6;
export const MUTED_BELOW = 0.3;

/** Project a continuous score to its display band. */
export function attentionBand(score: number): AttentionBand {
  if (score >= DEMANDING_AT) return "demanding";
  if (score < MUTED_BELOW) return "muted";
  return "normal";
}

export interface AttentionInput {
  /** The honest, immutable triage category — the demand floor. */
  category: TriageCategory;
  /**
   * Sender-significance band from the precomputed scalar (ADR-0057/0059), or
   * `null`/`undefined` when the sender is unscored / non-human / has no graph
   * row — which degrades to neutral (no demotion).
   */
  significanceBand?: SignificanceBand | null;
  /**
   * 0-based count of *prior* occurrences of this `(sender, normalizedSubject)`
   * in the window. `0` = first sighting (no decay). Only meaningful for
   * bulk/bot-shaped senders — gated by {@link AttentionInput.isBulkSender}.
   */
  recurrenceIndex?: number;
  /**
   * Whether the sender is bulk/bot-shaped. Recurrence decay applies ONLY when
   * `true` — a *human* emailing repeatedly is more persistent, not less
   * demanding (principle, not exemplar: "recurring + bot-shaped sender decays",
   * never a CloudWatch string match).
   */
  isBulkSender?: boolean;
  /**
   * Override floor — an exposed-secret / security `urgent` stays demanding
   * regardless of significance or recurrence (ADR-0051 pin). When set, the band
   * is forced to `demanding` and the score floored at {@link DEMANDING_AT}.
   */
  pinnedDemanding?: boolean;
}

export interface AttentionResult {
  /** Continuous demand in `[0,1]`. */
  score: number;
  /** Display band derived from {@link AttentionResult.score}. */
  band: AttentionBand;
}

/**
 * Score one item's demanding-ness for ranking/display. Pure and deterministic.
 *
 * `score = base[category] × significanceMult × recurrenceMult`, clamped to
 * `[0,1]`. An exposed-secret pin overrides to `demanding`. Recurrence can fully
 * demote a bulk-sender `urgent` (the CloudWatch-10× case lands in the ambient
 * tail) — the genuine exception is the explicit `pinnedDemanding` floor.
 */
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

/**
 * Normalize a subject line into a recurrence key so repeats of the same machine
 * notification collapse to one group. Strips reply/forward + bracketed prefixes
 * (`Re:`, `[FIRING]`), drops digit runs (counts, percentages, ids, dates,
 * times) that drift between repeats, and reduces the rest to space-separated
 * lowercase tokens. Grouping on `(sender, this)` over the window is what the
 * recurrence-decay input keys on.
 */
export function normalizeSubjectForRecurrence(subject: string): string {
  let s = subject.toLowerCase().trim();
  // Strip repeated reply/forward markers and bracketed prefixes from the front.
  for (;;) {
    const next = s.replace(/^\s*(?:re|fwd|fw|aw)\s*:\s*/i, "").replace(/^\s*\[[^\]]*\]\s*/, "");
    if (next === s) break;
    s = next;
  }
  // Drop digit runs so numeric drift between repeats collapses to one key, then
  // reduce everything non-alphanumeric to single spaces.
  return s
    .replace(/\d+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// ─── Bulk-sender detection (recurrence-decay gate) ───────────────────────────
// Recurrence decay applies ONLY to bulk/bot-shaped senders (a human emailing
// twice is more persistent, not less demanding). The honest signal lives in the
// classifier's `SenderContext` (effectiveAuthor/botSlug), which isn't on the
// briefing/rail read paths — so this is a conservative envelope-address
// heuristic: local-parts that are unambiguously machine mailboxes. Conservative
// by design — a missed bulk sender just isn't demoted (today's behavior); the
// risk to avoid is flagging a human, who would then be demoted on a repeated
// subject. Ambiguous role mailboxes (`team@`, `info@`, `support@`) are
// deliberately NOT matched — they're often human-staffed (mirrors the
// `senderKeyFor` prior-skip rule).

/** Unambiguously-automated local-part tokens. Word-ish boundaries via separators. */
const BULK_LOCALPART_RE =
  /(?:^|[._+-])(?:no-?reply|do-?not-?reply|donotreply|notifications?|notify|mailer-daemon|mailer|automated|auto-?confirm|bounces?|alerts?|postmaster)(?:[._+-]|$)/;

/** Pull the bare email address out of an RFC-5322 `From`, lowercased. */
function senderAddress(from: string | null | undefined): string | null {
  if (!from) return null;
  const trimmed = from.trim();
  if (!trimmed) return null;
  const angle = trimmed.match(/<([^>]+)>/);
  const addr = (angle?.[1] ?? trimmed).trim().toLowerCase();
  return addr || null;
}

/**
 * Whether a `From` looks like a bulk/bot mailbox — the gate for recurrence
 * decay. Pure and conservative (see the block comment above). Shared by the
 * briefing read path and the inbox rail so both decide recurrence the same way.
 */
export function isLikelyBulkSender(from: string | null | undefined): boolean {
  const addr = senderAddress(from);
  if (!addr) return false;
  const at = addr.indexOf("@");
  const local = at >= 0 ? addr.slice(0, at) : addr;
  return BULK_LOCALPART_RE.test(local);
}

// ─── Windowed item scoring (the cross-row recurrence pass) ───────────────────

/**
 * Recurrence grouping-key separator. A control char (unit separator) that
 * cannot appear in a lowercased email address or a normalized subject (both
 * reduced to `[a-z0-9 ]`), so it can never collide a distinct sender/subject
 * pair into one group. Written as an escape — never a literal control byte in
 * source — so search/diff/editor tooling stays sane.
 */
const RECURRENCE_KEY_SEP = "\u001f";

export interface AttentionItemInput {
  /** Raw `From` header (display-name + address ok); used for bulk + grouping. */
  sender: string | null | undefined;
  /** Raw subject line; normalized for the recurrence grouping key. */
  subject: string | null | undefined;
  /** The honest, immutable triage category — the demand floor. */
  category: TriageCategory;
  /** Sender-significance band (Phase B); omit/null for intrinsic-only scoring. */
  significanceBand?: SignificanceBand | null;
  /** Exposed-secret / security pin — forces `demanding` (ADR-0051). */
  pinnedDemanding?: boolean;
  /**
   * Chronological occurrence time (epoch ms, e.g. the email's `authoredAt`).
   * Recurrence — "how many copies has the human *already* seen?" — is inherently
   * chronological, so the recurrence index is assigned oldest-first off this key,
   * independent of the order `items` is passed in (both live consumers render
   * newest-first). Omit/null on every item to fall back to input order.
   */
  occurredAtMs?: number | null;
}

/**
 * Score a window of items together so recurrence — an inherently cross-row
 * property — can be computed. Groups bulk-sender items by
 * `(address, normalizedSubject)`; the k-th occurrence in *chronological* order
 * gets `recurrenceIndex = k`, so a machine notification fired ten times decays
 * out of the demanding lane while its first sighting stays put. Recurrence is
 * assigned oldest-first off {@link AttentionItemInput.occurredAtMs} and the
 * results mapped back to the caller's order — both live consumers render
 * newest-first, where assigning by input order would (wrongly) keep the latest
 * copy demanding and mute the older ones. Non-bulk senders never accrue an
 * index (a human repeating is not demoted). Returns results aligned 1:1 with
 * `items`.
 *
 * This is the single windowed-scoring entry point shared by the briefing read
 * path (the agent's email list) and the inbox rail — each computes attention
 * off the rows it can see, through one formula.
 */
export function scoreAttentionForItems(items: readonly AttentionItemInput[]): AttentionResult[] {
  const entries = items.map((item, index) => ({
    item,
    index,
    bulk: isLikelyBulkSender(item.sender),
    recurrenceIndex: 0,
  }));

  // Walk oldest-first so `recurrenceIndex` counts *prior* sightings; ties and
  // the no-timestamp case fall back to input order (stable). The sorted view
  // holds the same entry objects, so writing `recurrenceIndex` here lands on the
  // original-order entries returned below.
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
