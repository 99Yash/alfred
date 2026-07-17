import { db } from "@alfred/db";
import { integrationCredentials, skills, user, userFacts } from "@alfred/db/schemas";
import { and, asc, desc, eq } from "drizzle-orm";

/**
 * Bundle the context the `learn-skill` distill step feeds the LLM.
 *
 * Read-only — pulls user identity + active facts + connected integrations
 * + existing skill slugs. Mirrors `collectColdStartSignals` for shape and
 * intent: do the cheap-and-deterministic gathering separately from the
 * expensive LLM call so retries don't re-query the same rows.
 *
 * Semantic recall over `memory_chunks` is deliberately deferred. At
 * single-user scale the active-facts list is small enough to inline
 * verbatim; embedding the user's prompt and top-K-querying chunks adds
 * a Voyage round-trip + an extra query for marginal value at v1. The
 * deeper context arrives via the async `skill-documentation` workflow,
 * which DOES do hybrid search across `documents` + `chunks` + memory.
 */
export interface SkillLearnContext {
  userId: string;
  user: {
    name: string;
    email: string;
  };
  /** All currently-active facts (`status = 'confirmed'`, valid window open). */
  facts: Array<{
    key: string;
    value: unknown;
    confidence: number;
  }>;
  /** Slugs of providers the user has connected (gmail, github, …). */
  connectedIntegrations: string[];
  /** Slugs of skills already authored — drives `@skill:<slug>` validation. */
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

  // Confirmed facts only — proposals are noise for the distill prompt.
  // Cap at 200; beyond that the prompt grows past Haiku's sweet spot
  // and the LLM starts dropping the trailing items anyway.
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

  // Distinct providers — a user with two Google accounts shouldn't see
  // `google` twice in the registry.
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
