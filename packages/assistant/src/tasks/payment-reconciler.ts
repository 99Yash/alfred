import { parseEmailAddress, parseGmailDocumentMetadata } from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents } from "@alfred/db/schemas";
import { and, eq, gte, lt } from "drizzle-orm";
import { resolveTodosForGmailSource } from "./resolve";

/**
 * The payment lifecycle authority path (#258).
 *
 * Gmail triages a receipt as its own message and, because Stripe uses a fresh
 * thread for each notification, the receipt never reaches the existing
 * same-thread todo retractor. This module owns the small deterministic bridge:
 * a later receipt can dismiss the unhandled payment proposal that preceded it,
 * but only when the merchant, currency, amount, and a bounded time window
 * identify one preceding confirmation/failure. Ambiguity keeps the todo live.
 *
 * This is deliberately not an LLM or a briefing-only pass. A positive receipt
 * may mutate the todo rail; a fuzzy cluster or composer observation may not.
 */

const LOOKBACK_MS = 48 * 60 * 60 * 1000;

const MAX_CANDIDATES = 100;

const ACCOUNT_RE = /\bacct_[a-z0-9]+\b/i;

const AMOUNT_RE = /(?<symbol>[$£€₹])\s*(?<amount>(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)/;

type PaymentPolarity = "confirm" | "failed" | "receipt";

type PaymentFingerprint = {
  account: string;
  amountMinor: number;
  currency: string;
  polarity: PaymentPolarity;
};

export type PaymentReconcilerResult =
  | {
      status: "not_payment";
    }
  | {
      status: "no_match";
      account: string;
      amountMinor: number;
      currency: string;
    }
  | {
      status: "ambiguous";
      account: string;
      amountMinor: number;
      currency: string;
      candidateCount: number;
    }
  | {
      status: "dismissed";
      account: string;
      amountMinor: number;
      currency: string;
      todoIds: string[];
    }
  | {
      status: "no_todo";
      account: string;
      amountMinor: number;
      currency: string;
      sourceThreadId: string;
    };

interface StoredPaymentDocument {
  id: string;
  authoredAt: Date;
  sourceThreadId: string | null;
  fingerprint: PaymentFingerprint;
}

/**
 * Resolve a live payment todo from a positive receipt document.
 *
 * The caller owns the workflow's "the triage row committed" boundary. This
 * function owns only the deterministic payment match and the rail write. It
 * returns a structured result for logging; a non-payment document is a cheap
 * no-op, not an error.
 */
export async function resolvePaymentTodoFromReceipt(args: {
  userId: string;
  receiptDocumentId: string;
}): Promise<PaymentReconcilerResult> {
  const [receiptRow] = await db()
    .select({
      id: documents.id,
      authoredAt: documents.authoredAt,
      sourceThreadId: documents.sourceThreadId,
      title: documents.title,
      content: documents.content,
      metadata: documents.metadata,
    })
    .from(documents)
    .where(
      and(
        eq(documents.userId, args.userId),
        eq(documents.source, "gmail"),
        eq(documents.id, args.receiptDocumentId),
      ),
    )
    .limit(1);

  if (!receiptRow || !receiptRow.authoredAt) return { status: "not_payment" };

  const receipt = fingerprintStoredPayment({
    id: receiptRow.id,
    authoredAt: receiptRow.authoredAt,
    sourceThreadId: receiptRow.sourceThreadId,
    title: receiptRow.title,
    content: receiptRow.content,
    metadata: receiptRow.metadata,
  });

  if (!receipt || receipt.fingerprint.polarity !== "receipt") return { status: "not_payment" };

  const windowStart = new Date(receipt.authoredAt.getTime() - LOOKBACK_MS);
  const windowEnd = receipt.authoredAt;

  const rows = await db()
    .select({
      id: documents.id,
      authoredAt: documents.authoredAt,
      sourceThreadId: documents.sourceThreadId,
      title: documents.title,
      content: documents.content,
      metadata: documents.metadata,
    })
    .from(documents)
    .where(
      and(
        eq(documents.userId, args.userId),
        eq(documents.source, "gmail"),
        gte(documents.authoredAt, windowStart),
        lt(documents.authoredAt, windowEnd),
      ),
    )
    .limit(MAX_CANDIDATES);

  const candidates = rows.flatMap((row) => {
    if (!row.authoredAt) return [];

    const candidate = fingerprintStoredPayment({
      id: row.id,
      authoredAt: row.authoredAt,
      sourceThreadId: row.sourceThreadId,
      title: row.title,
      content: row.content,
      metadata: row.metadata,
    });

    if (!candidate || candidate.fingerprint.polarity === "receipt") return [];

    if (!samePaymentFingerprint(receipt.fingerprint, candidate.fingerprint)) return [];

    return [candidate];
  });

  const base = {
    account: receipt.fingerprint.account,
    amountMinor: receipt.fingerprint.amountMinor,
    currency: receipt.fingerprint.currency,
  };

  // More than one plausible preceding payment is not enough evidence. The
  // failure→receipt emails do not share a hard invoice key, so silently picking
  // one here would be exactly the false-close risk the reducer is meant to
  // prevent.
  if (candidates.length !== 1) {
    if (candidates.length === 0) return { status: "no_match", ...base };

    return { status: "ambiguous", ...base, candidateCount: candidates.length };
  }

  const candidate = candidates[0];

  if (!candidate || !candidate.sourceThreadId) return { status: "no_match", ...base };

  const resolved = await resolveTodosForGmailSource({
    userId: args.userId,
    sourceThreadId: candidate.sourceThreadId,
    reason: `payment-reconciler: receipt ${receipt.id} matched ${candidate.id}`,
    actor: "system",
    statuses: ["suggested", "open"],
  });

  if (resolved.ok && resolved.dismissedCount > 0) {
    return {
      status: "dismissed",
      ...base,
      todoIds: resolved.todoIds,
    };
  }

  return {
    status: "no_todo",
    ...base,
    sourceThreadId: candidate.sourceThreadId,
  };
}

function fingerprintStoredPayment(row: {
  id: string;
  authoredAt: Date;
  sourceThreadId: string | null;
  title: string | null;
  content: string;
  metadata: unknown;
}): StoredPaymentDocument | null {
  const metadata = parseGmailDocumentMetadata(row.metadata);

  const text = [row.title, row.content]
    .filter((value): value is string => Boolean(value))
    .join("\n");

  const sender = parseEmailAddress(metadata.from);

  const source = `${sender ?? ""}\n${text}`;

  const account = source.match(ACCOUNT_RE)?.[0]?.toLowerCase();

  if (!account) return null;

  const amount = parseAmount(text);

  if (!amount) return null;

  const polarity = paymentPolarity(text);

  if (!polarity) return null;

  return {
    id: row.id,
    authoredAt: row.authoredAt,
    sourceThreadId: row.sourceThreadId,
    fingerprint: {
      account,
      amountMinor: amount.minor,
      currency: amount.currency,
      polarity,
    },
  };
}

function parseAmount(text: string): { minor: number; currency: string } | null {
  const match = text.match(AMOUNT_RE);

  if (!match?.groups) return null;

  const symbol = match.groups.symbol;

  const rawAmount = match.groups.amount;

  if (!symbol || !rawAmount) return null;

  const currency = symbol === "$" ? "USD" : symbol === "£" ? "GBP" : symbol === "€" ? "EUR" : "INR";
  const amount = Number(rawAmount.replace(/,/g, ""));

  if (!Number.isFinite(amount)) return null;

  return { minor: Math.round(amount * 100), currency };
}

function paymentPolarity(text: string): PaymentPolarity | null {
  const normalized = text.toLowerCase();

  if (
    /\b(?:unsuccessful|failed|declined|payment (?:was )?not successful|could not be processed|couldn't be processed)\b/.test(
      normalized,
    )
  ) {
    return "failed";
  }

  if (/\b(?:receipt|paid|payment (?:received|successful|succeeded|complete))\b/.test(normalized)) {
    return "receipt";
  }

  if (/\bconfirm (?:your )?payment\b/.test(normalized)) return "confirm";

  return null;
}

function samePaymentFingerprint(left: PaymentFingerprint, right: PaymentFingerprint): boolean {
  return (
    left.account === right.account &&
    left.amountMinor === right.amountMinor &&
    left.currency === right.currency
  );
}
