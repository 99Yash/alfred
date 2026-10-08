import { db } from "@alfred/db";
import { entities } from "@alfred/db/schemas";
import { and, eq, sql } from "drizzle-orm";

/**
 * Is this human sender's address an alias of a known person (ADR-0051 §4)?
 * Human senders only. A hint, so any failure returns false.
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
          // Not org entities: `support@acme.com` must not read as a known person.
          eq(entities.kind, "person"),
          // Case-insensitive, so "Alice@Work.com" stored verbatim still matches.
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
