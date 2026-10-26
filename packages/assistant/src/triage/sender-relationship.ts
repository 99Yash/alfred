/**
 * The `Sender relationship` line for a human sender (ADR-0059): significance
 * band, reciprocity, same-org, and the user's role. The model reads the prose;
 * the todo gate reads the typed `isColdContact`, because the model did not
 * reliably apply `cold_sender:` itself.
 */
import { isNonBlankString, type SignificanceBand } from "@alfred/contracts";
import { db } from "@alfred/db";
import { userFacts } from "@alfred/db/schemas";
import { and, eq, inArray } from "drizzle-orm";
import type { SenderPersonRead } from "../knowledge";

/** `unscored` (history, no score yet) is not `weak` (a real low score). */
export type SenderSignificanceBucket = SignificanceBand | "unscored";

/**
 * Cold (rule 16b) = not two-way, and either one-way inbound or scored `weak`.
 * Two-way is never cold, even `unscored`.
 */
export function isColdContactFromSignals(args: {
  inbound: number;
  outbound: number;
  bucket: SenderSignificanceBucket;
}): boolean {
  const twoWay = args.inbound > 0 && args.outbound > 0;

  return !twoWay && (args.outbound === 0 || args.bucket === "weak");
}

function reciprocityPhrase(stats: { inbound: number; outbound: number }): string {
  if (stats.inbound > 0 && stats.outbound > 0) return "two-way thread";

  if (stats.outbound > 0) return "you reached out (no reply yet)";

  return "one-way inbound (you never replied)";
}

function factString(value: unknown): string | null {
  return isNonBlankString(value) ? value.trim() : null;
}

/** `"Founder, Acme"` from the job title and employer facts, or null. */
async function loadUserRole(userId: string): Promise<string | null> {
  try {
    const rows = await db()
      .select({ key: userFacts.key, value: userFacts.value })
      .from(userFacts)
      .where(
        and(
          eq(userFacts.userId, userId),
          eq(userFacts.status, "confirmed"),
          inArray(userFacts.key, ["job_title", "employer", "company"]),
        ),
      );

    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    const title = factString(byKey.get("job_title"));
    const company = factString(byKey.get("employer")) ?? factString(byKey.get("company"));

    if (title && company) return `${title}, ${company}`;

    return title ?? company ?? null;
  } catch {
    return null;
  }
}

/** `descriptor` is null for a non-human sender; the line is then omitted. */
export interface SenderRelationshipSignal {
  descriptor: string | null;
  /** Always false for a non-human sender: nobody is waiting. */
  isColdContact: boolean;
}

export const NON_HUMAN_RELATIONSHIP: SenderRelationshipSignal = {
  descriptor: null,
  isColdContact: false,
};

// The read succeeded and found nothing: cold.
const NO_PRIOR_CONTACT: SenderRelationshipSignal = {
  descriptor: "no prior contact on record",
  isColdContact: true,
};

// The read failed: coldness is unknown, so keep the todo and render no line.
// Same shape as NON_HUMAN_RELATIONSHIP, different meaning.
export const RELATIONSHIP_READ_FAILED: SenderRelationshipSignal = {
  descriptor: null,
  isColdContact: false,
};

/**
 * Best-effort. No history is cold; a failed read is not (#517 D2).
 * Reads no entity: the caller passes the step's one sender read.
 */
export async function resolveSenderRelationship(args: {
  userId: string;
  sender: SenderPersonRead;
  isHumanSender: boolean;
}): Promise<SenderRelationshipSignal> {
  if (!args.isHumanSender) return NON_HUMAN_RELATIONSHIP;

  switch (args.sender.kind) {
    case "no_address":
      return NON_HUMAN_RELATIONSHIP;
    case "read_failed":
      return RELATIONSHIP_READ_FAILED;
    case "none":
      return NO_PRIOR_CONTACT;
    case "found":
      break;
  }

  const meta = args.sender.metadata;
  const stats = meta.correspondence ?? { inbound: 0, outbound: 0, coRecipient: 0 };
  // The step's one read already mapped the score; `null` is unscored, not weak.
  const significance = args.sender.significance;

  const bucket: SenderSignificanceBucket = significance?.band ?? "unscored";

  const isColdContact = isColdContactFromSignals({
    inbound: stats.inbound,
    outbound: stats.outbound,
    bucket,
  });

  const parts: string[] = [bucket, reciprocityPhrase(stats)];

  // Omitted until the row is scored.
  if (significance) {
    parts.push(significance.sameOrg ? "same-org" : "not same-org");
  }

  const role = await loadUserRole(args.userId);

  if (role) parts.push(`you: "${role}"`);

  return { descriptor: parts.join(" · "), isColdContact };
}
