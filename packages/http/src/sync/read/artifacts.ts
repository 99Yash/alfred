import { artifacts, type Artifact } from "@alfred/db/schemas";
import { syncedArtifactSchema, type SyncedArtifact } from "@alfred/sync";
import { desc, eq } from "drizzle-orm";
import { toEntityRow, type EntityFetcher } from "./entity-row";
import { toIso, toRequiredIso } from "./iso-date";

/** Most-recent agent-produced artifacts synced per user (ADR-0075). */
const ARTIFACT_PULL_LIMIT = 200;

// Agent-produced artifacts (ADR-0075). Flat per-user pull bounded to the most
// recent ARTIFACT_PULL_LIMIT; the sidebar filters by threadId client-side. A
// `generating` row syncs too (content may still be null) so the sidebar can
// render the placeholder while the boss authors.
export const fetchArtifacts: EntityFetcher = async (tx, userId) => {
  const rows = await tx
    .select()
    .from(artifacts)
    .where(eq(artifacts.userId, userId))
    .orderBy(desc(artifacts.createdAt), desc(artifacts.id))
    .limit(ARTIFACT_PULL_LIMIT);
  return rows.flatMap((a: Artifact) =>
    toEntityRow({
      slug: "ARTIFACT",
      id: a.id,
      rowVersion: a.rowVersion,
      serialize: () => serializeArtifact(a),
    }),
  );
};

function serializeArtifact(a: Artifact): SyncedArtifact {
  // `storageKey` is server-only (R2 seam) and deliberately omitted from the
  // synced shape. `content` may be null on a freshly-created `generating` row.
  return syncedArtifactSchema.parse({
    id: a.id,
    userId: a.userId,
    threadId: a.threadId,
    runId: a.runId,
    messageId: a.messageId,
    kind: a.kind,
    format: a.format,
    title: a.title,
    status: a.status,
    content: a.content ?? null,
    rowVersion: a.rowVersion,
    createdAt: toRequiredIso(a.createdAt, "artifacts.createdAt"),
    updatedAt: toIso(a.updatedAt),
  });
}
