import { db } from "@alfred/db";
import { integrationCredentials, skills, user, userFacts } from "@alfred/db/schemas";
import { and, asc, desc, eq } from "drizzle-orm";

/**
 * Read-only context for the distill step: user, active facts, connected integrations,
 * and skill slugs. Gathered apart from the LLM call, so retries do not re-query.
 * No memory search here; `skill-documentation` does that later.
 */
export interface SkillLearnContext {
  userId: string;
  user: {
    name: string;
    email: string;
  };
  /** Confirmed facts with an open validity window. */
  facts: Array<{
    key: string;
    value: unknown;
    confidence: number;
  }>;
  /** E.g. gmail, github. */
  connectedIntegrations: string[];
  /** Drives `@skill:<slug>` validation. */
  existingSkillSlugs: string[];
}

export async function collectSkillLearnContext(userId: string): Promise<SkillLearnContext> {
  const [userRow] = await db()
    .select({ name: user.name, email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  if (!userRow) {
    throw new Error(`[learn-skill] user not found: ${userId}`);
  }

  // Confirmed facts only. Capped at 200; past that the model drops trailing items.
  const facts = await db()
    .select({
      key: userFacts.key,
      value: userFacts.value,
      confidence: userFacts.confidence,
    })
    .from(userFacts)
    .where(and(eq(userFacts.userId, userId), eq(userFacts.status, "confirmed")))
    .orderBy(desc(userFacts.updatedAt))
    .limit(200);

  // Distinct, so two Google accounts list `google` once.
  const integrationRows = await db()
    .selectDistinct({ provider: integrationCredentials.provider })
    .from(integrationCredentials)
    .where(eq(integrationCredentials.userId, userId))
    .orderBy(asc(integrationCredentials.provider));

  const skillRows = await db()
    .select({ slug: skills.slug })
    .from(skills)
    .where(eq(skills.userId, userId))
    .orderBy(asc(skills.slug));

  return {
    userId,
    user: { name: userRow.name, email: userRow.email },
    facts,
    connectedIntegrations: integrationRows.map((r) => r.provider),
    existingSkillSlugs: skillRows.map((r) => r.slug),
  };
}
