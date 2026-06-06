import { db } from "@alfred/db";
import { entities } from "@alfred/db/schemas";
import { and, eq, sql } from "drizzle-orm";

/**
 * Known-contact lookup (ADR-0051 §4, Phase 3). A pre-model observation: is the
 * human sender's address one of the user's known contacts? Email addresses live
 * in `entities.aliases` (a jsonb string array); we match case-insensitively
 * against any alias of any entity.
 *
 * Call ONLY for human senders (`effectiveAuthor: 'person'`) — bots/services are
 * reasoned via `sender_priors`, never the entity graph. Best-effort: an empty
 * `entities` table or a DB blip yields `false`, never throws into the classify
 * path (the flag is a hint, not a correctness dependency).
 */
export async function isKnownContact(userId: string, senderAddress: string): Promise<boolean> {
  const target = senderAddress.trim().toLowerCase();
  if (!target) return false;
  try {
    const rows = await db()
      .select({ id: entities.id })
      .from(entities)
      .where(
        and(
          eq(entities.userId, userId),
          // Human contacts only (the documented contract): a shared-mailbox
          // alias on an organization/product entity (e.g. support@acme.com)
          // must not report a service sender as a known person. Also narrows
          // the scan via the (user_id, kind, …) index prefix.
          eq(entities.kind, "person"),
          // `aliases` is a jsonb array of strings; iterate it and compare
          // lowercased so "Alice@Work.com" stored verbatim still matches.
          sql`EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(${entities.aliases}) AS alias
            WHERE lower(alias) = ${target}
          )`,
        ),
      )
      .limit(1);
    return rows.length > 0;
  } catch {
    return false;
  }
}
