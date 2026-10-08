import { embed } from "@alfred/ai/embeddings";
import { db } from "@alfred/db";
import { skillRevisions, skills, user, userFacts } from "@alfred/db/schemas";
import { search, toModelFacingHit, type ModelFacingHit } from "@alfred/corpus";
import { and, desc, eq } from "drizzle-orm";
import { recallMemory, type RecallMemoryHit } from "@alfred/assistant/knowledge";

/**
 * Context for the doc-compose step: the skill and its v1 body, the user, confirmed
 * facts, and corpus and memory hits. Both searches use the v1 body as the query:
 * distill already cleaned up the user's intent. Small limits, because the compose is boss-tier.
 */
export interface SkillDocumentationContext {
  userId: string;
  user: { name: string; email: string };
  skill: {
    id: string;
    slug: string;
    name: string;
    /** The v1 (distilled) revision. */
    currentRevisionId: string;
    currentBody: string;
  };
  facts: Array<{ key: string; value: unknown; confidence: number }>;
  /** `toModelFacingHit` strips the corpus `record`, so the run store holds no credential identity. */
  documentHits: ModelFacingHit[];
  memoryHits: RecallMemoryHit[];
  /** Drives the email's provenance line. */
  sourceCounts: Record<string, number>;
}

const CHUNK_HIT_LIMIT = 12;

const MEMORY_HIT_LIMIT = 6;

export async function collectSkillDocumentationContext(args: {
  userId: string;
  skillId: string;
}): Promise<SkillDocumentationContext> {
  const { userId, skillId } = args;

  const [userRow] = await db()
    .select({ name: user.name, email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  if (!userRow) throw new Error(`[skill-doc] user not found: ${userId}`);

  const [skillRow] = await db()
    .select({
      id: skills.id,
      slug: skills.slug,
      name: skills.name,
      currentRevisionId: skills.currentRevisionId,
    })
    .from(skills)
    .where(and(eq(skills.id, skillId), eq(skills.userId, userId)))
    .limit(1);

  if (!skillRow) throw new Error(`[skill-doc] skill not found or not owned: ${skillId}`);

  if (!skillRow.currentRevisionId) {
    throw new Error(
      `[skill-doc] skill ${skillId} has no current revision — learn-skill must complete first`,
    );
  }

  const [revRow] = await db()
    .select({ body: skillRevisions.body })
    .from(skillRevisions)
    .where(eq(skillRevisions.id, skillRow.currentRevisionId))
    .limit(1);

  if (!revRow) {
    throw new Error(`[skill-doc] revision not found: ${skillRow.currentRevisionId}`);
  }

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

  // Embed once: the call is billable, so do not repeat it inside Promise.all.
  const queryEmbedding = await embed(revRow.body, {
    inputType: "query",
    userId,
    idempotencyKey: `skill-doc-context:${userId}:${skillRow.id}:${skillRow.currentRevisionId}`,
  });

  const [searchHits, memoryHits] = await Promise.all([
    search({
      query: revRow.body,
      userId,
      limit: CHUNK_HIT_LIMIT,
      queryEmbedding,
    }),
    recallMemory({
      query: revRow.body,
      userId,
      limit: MEMORY_HIT_LIMIT,
      queryEmbedding,
    }),
  ]);

  // The run store keeps these hits as-is, so strip identity now.
  const documentHits = searchHits.map(toModelFacingHit);

  const sourceCounts: Record<string, number> = {};

  for (const h of documentHits) {
    sourceCounts[h.source] = (sourceCounts[h.source] ?? 0) + 1;
  }

  return {
    userId,
    user: { name: userRow.name, email: userRow.email },
    skill: {
      id: skillRow.id,
      slug: skillRow.slug,
      name: skillRow.name,
      currentRevisionId: skillRow.currentRevisionId,
      currentBody: revRow.body,
    },
    facts,
    documentHits,
    memoryHits,
    sourceCounts,
  };
}
