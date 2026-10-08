import { db } from "@alfred/db";
import { skills } from "@alfred/db/schemas";
import { and, eq, like } from "drizzle-orm";
import { availableSlug, slugBase } from "@alfred/contracts/slug";

/** URL-safe slug, suffixed `-2`, `-3`, ... on collision. One query reads every colliding slug. */
export async function slugifyForUser(userId: string, name: string): Promise<string> {
  const base = slugBase(name, "skill");

  const rows = await db()
    .select({ slug: skills.slug })
    .from(skills)
    .where(and(eq(skills.userId, userId), like(skills.slug, `${base}%`)));

  return availableSlug(base, new Set(rows.map((r) => r.slug)));
}
