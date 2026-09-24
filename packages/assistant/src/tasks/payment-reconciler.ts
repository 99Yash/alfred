import { parseEmailAddress, parseGmailDocumentMetadata } from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents, emailTriage, todos, type Document } from "@alfred/db/schemas";
import { and, desc, eq, gte, lt } from "drizzle-orm";
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

const NEGATED_RECEIPT_RE =
  /\b(?:no|nothing|not|never|haven['’]?t|hasn['’]?t|hadn['’]?t|have\s+not|has\s+not|had\s+not|isn['’]?t|aren['’]?t|wasn['’]?t|weren['’]?t|didn['’]?t|doesn['’]?t|don['’]?t|won['’]?t|can['’]?t|cannot)\s+(?:\w+\s+){0,3}(?:received|paid|successful|succeeded|complete(?:d)?)\b/i;

const CONDITIONAL_RECEIPT_RE =
  /\b(?:(?:once|when|after|until|by)\b[^.!?;\n]{0,40}\b(?:payment\s+(?:received|successful|succeeded|complete(?:d)?)|receipt\s+for\s+your\s+payment|amount\s+paid)\b|\b(?:payment\s+(?:received|successful|succeeded|complete(?:d)?)|receipt\s+for\s+your\s+payment|amount\s+paid)\b[^.!?;\n]{0,40}\b(?:once|when|after|until|by)\b)\b/i;

const RECEIPT_CONTEXT_DENY_RE =
  /\b(?:amount\s+due|past\s+due|overdue|unpaid|outstanding|refund(?:ed|s)?|action[ -](?:required|needed)|unable\s+to\s+process)\b|\bamount\s+paid\s*(?:[:=-]\s*)?(?:[$£€₹]\s*)?0+(?:[.,]0+)?(?:\b|$)/i;

type PaymentPolarity = "confirm" | "failed" | "receipt";

type PaymentFingerprint = {
  account: string;
  amountMinor: number;
  currency: string;
  polarity: PaymentPolarity;
};

type PaymentDocumentRow = Pick<
  Document,
  "id" | "authoredAt" | "sourceThreadId" | "title" | "content" | "metadata"
>;

const paymentDocumentSelection = {
  id: documents.id,
  authoredAt: documents.authoredAt,
  sourceThreadId: documents.sourceThreadId,
  title: documents.title,
  content: documents.content,
  metadata: documents.metadata,
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

type StoredPaymentDocument = Pick<Document, "id" | "sourceThreadId"> & {
  authoredAt: NonNullable<Document["authoredAt"]>;
  fingerprint: PaymentFingerprint;
};

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
    .select(paymentDocumentSelection)
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

  const receipt = fingerprintStoredPayment(receiptRow);

  if (!receipt || receipt.fingerprint.polarity !== "receipt") return { status: "not_payment" };

  const windowStart = new Date(receipt.authoredAt.getTime() - LOOKBACK_MS);
  const windowEnd = receipt.authoredAt;

  const rows = await db()
    .select(paymentDocumentSelection)
    .from(documents)
    .where(
      and(
        eq(documents.userId, args.userId),
        eq(documents.source, "gmail"),
        gte(documents.authoredAt, windowStart),
        lt(documents.authoredAt, windowEnd),
      ),
    )
    .orderBy(desc(documents.authoredAt))
    .limit(MAX_CANDIDATES);

  const candidates = rows.flatMap((row) => {
    if (!row.authoredAt) return [];

    const candidate = fingerprintStoredPayment(row);

    if (!candidate || candidate.fingerprint.polarity === "receipt") return [];

    if (!samePaymentFingerprint(receipt.fingerprint, candidate.fingerprint)) return [];

    return [candidate];
  });

  const base = {
    account: receipt.fingerprint.account,
    amountMinor: receipt.fingerprint.amountMinor,
    currency: receipt.fingerprint.currency,
  };

  // A full page means the database may have omitted an older matching candidate.
  // The cap is a read bound, never evidence of uniqueness.
  if (rows.length === MAX_CANDIDATES) {
    return { status: "ambiguous", ...base, candidateCount: MAX_CANDIDATES };
  }

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

  // The todo table has no payment discriminator. Exact candidate provenance is
  // the narrowest existing durable boundary: the run that classified this very
  // document proposed an agent-created, still-unpromoted todo. A merged todo
  // whose original run differs fails closed instead of being dismissed by an
  // unrelated todo on the same Gmail thread.
  const todoRows = await db()
    .select({ id: todos.id })
    .from(todos)
    .innerJoin(
      emailTriage,
      and(
        eq(emailTriage.userId, todos.userId),
        eq(emailTriage.sourceThreadId, candidate.sourceThreadId),
        eq(emailTriage.documentId, candidate.id),
        eq(emailTriage.runId, todos.agentRunId),
      ),
    )
    .where(
      and(
        eq(todos.userId, args.userId),
        eq(todos.createdBy, "agent"),
        eq(todos.status, "suggested"),
      ),
    );

  const todoIds = todoRows.map((row) => row.id);

  if (todoIds.length === 0) {
    return {
      status: "no_todo",
      ...base,
      sourceThreadId: candidate.sourceThreadId,
    };
  }

  const resolved = await resolveTodosForGmailSource({
    userId: args.userId,
    sourceThreadId: candidate.sourceThreadId,
    todoIds,
    reason: `payment-reconciler: receipt ${receipt.id} matched ${candidate.id}`,
    actor: "system",
    statuses: ["suggested"],
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

function fingerprintStoredPayment(row: PaymentDocumentRow): StoredPaymentDocument | null {
  const { authoredAt } = row;

  if (!authoredAt) return null;

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
    authoredAt,
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

  // Confirmation and action-required mail often mentions the receipt that will
  // follow. Classify that required action before positive receipt wording so a
  // failed payment can never be closed by its own future-looking confirmation.
  if (
    /\b(?:confirm (?:your )?payment|requires?[ -]action|action[ -](?:required|needed))\b/.test(
      normalized,
    )
  ) {
    return "confirm";
  }

  // An allowlist phrase is not proof by itself. Payment mail can be negated,
  // conditional, overdue, refunded, awaiting action, or report a zero payment.
  if (
    NEGATED_RECEIPT_RE.test(normalized) ||
    CONDITIONAL_RECEIPT_RE.test(normalized) ||
    RECEIPT_CONTEXT_DENY_RE.test(normalized)
  ) {
    return null;
  }

  if (
    /\b(?:payment\s+(?:received|successful|succeeded|complete(?:d)?)|receipt\s+for\s+your\s+payment|amount\s+paid)\b/.test(
      normalized,
    )
  ) {
    return "receipt";
  }

  return null;
}

function samePaymentFingerprint(left: PaymentFingerprint, right: PaymentFingerprint): boolean {
  return (
    left.account === right.account &&
    left.amountMinor === right.amountMinor &&
    left.currency === right.currency
  );
}
