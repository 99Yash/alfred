import { db } from "@alfred/db";
import { skills } from "@alfred/db/schemas";
import { and, eq, like } from "drizzle-orm";
import { availableSlug, slugBase } from "../../lib/slug";

/**
 * Slugify a free-form skill name into a URL-safe identifier, then dedup
 * against existing `skills.slug` for the same user, suffixing `-2`, `-3`,
 * … on collision. Stable across revisions per the schema comment.
 *
 * The query reads every existing slug that starts with the candidate so
 * one round-trip covers an arbitrary number of collisions.
 */
export async function slugifyForUser(userId: string, name: string): Promise<string> {
  const base = slugBase(name, "skill");

  const rows = await db()
    .select({ slug: skills.slug })
    .from(skills)
    .where(and(eq(skills.userId, userId), like(skills.slug, `${base}%`)));

  return availableSlug(base, new Set(rows.map((r) => r.slug)));
}
