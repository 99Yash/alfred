import { db } from "@alfred/db";
import { skills } from "@alfred/db/schemas";
import { and, eq, like } from "drizzle-orm";

/**
 * Slugify a free-form skill name into a URL-safe identifier, then dedup
 * against existing `skills.slug` for the same user, suffixing `-2`, `-3`,
 * … on collision. Stable across revisions per the schema comment.
 *
 * The query reads every existing slug that starts with the candidate so
 * one round-trip covers an arbitrary number of collisions.
 */
export async function slugifyForUser(userId: string, name: string): Promise<string> {
  const base = baseSlugify(name) || "skill";

  const rows = await db()
    .select({ slug: skills.slug })
    .from(skills)
    .where(and(eq(skills.userId, userId), like(skills.slug, `${base}%`)));

  const taken = new Set(rows.map((r) => r.slug));
  if (!taken.has(base)) return base;

  for (let n = 2; n < 1_000; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

const COMBINING_MARKS = /[̀-ͯ]/g;

function baseSlugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
