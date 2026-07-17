import { embed } from "@alfred/ai/embeddings";
import { db } from "@alfred/db";
import { skillRevisions, skills, user, userFacts } from "@alfred/db/schemas";
import { semanticSearch, type SearchHit } from "@alfred/ingestion";
import { and, desc, eq } from "drizzle-orm";
import { recallMemory, type RecallMemoryHit } from "../memory/chunks";

/**
 * Gather everything the doc-compose step needs to write a richer body:
 *
 *   - the skill row + its current `distilled` revision (the v1 body),
 *   - the user's identity (for the email greeting + grounding),
 *   - all confirmed `user_facts` (the same set the distill saw, but
 *     post-Learn so newly auto-confirmed proposals are now in scope),
 *   - top-K integration-corpus hits (`semanticSearch` over chunks ⨝
 *     documents) keyed on the v1 body as the query,
 *   - top-K memory-layer hits (`recallMemory` over `memory_chunks`)
 *     keyed on the same query.
 *
 * The query for both searches is the v1 body — it's already the
 * normalized/distilled form of the user's intent and gives the searcher
 * a stable retrieval signal. Using the raw user prompt would be noisier;
 * the distill step exists in part to clean that up.
 *
 * Conservative limits: 12 chunk hits + 6 memory hits. Boss-tier compose
 * is per-token; pulling more dilutes signal without changing the body
 * meaningfully at single-user scale.
 */
export interface SkillDocumentationContext {
  userId: string;
  user: { name: string; email: string };
  skill: {
    id: string;
    slug: string;
    name: string;
    /** v1 (distilled) revision — the input to this doc pass. */
    currentRevisionId: string;
    currentBody: string;
  };
  facts: Array<{ key: string; value: unknown; confidence: number }>;
  documentHits: SearchHit[];
  memoryHits: RecallMemoryHit[];
  /** Distinct `documents.source` values surfaced — drives the email's provenance line. */
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

  // Both searches use the v1 body verbatim as the query. Distill produced
  // it specifically as the canonical statement of the skill's intent.
  //
  // Compute the embedding once before fan-out. The document and memory
  // lookups are independent DB reads, but the embedding API call is
  // billable and should not be duplicated inside Promise.all.
  const queryEmbedding = await embed(revRow.body, {
    inputType: "query",
    userId,
    idempotencyKey: `skill-doc-context:${userId}:${skillRow.id}:${skillRow.currentRevisionId}`,
  });
  const [documentHits, memoryHits] = await Promise.all([
    semanticSearch({
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
