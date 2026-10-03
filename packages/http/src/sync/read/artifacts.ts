import type { DbTransaction } from "@alfred/db";
import { artifacts, type Artifact } from "@alfred/db/schemas";
import { SYNC_MODEL } from "@alfred/sync";
import { desc, eq, getTableColumns, inArray } from "drizzle-orm";
import { syncEntity } from "./sync-entity";

/** Most-recent agent-produced artifacts synced per user (ADR-0075). */
const ARTIFACT_PULL_LIMIT = 200;

const artifactOrder = [desc(artifacts.createdAt), desc(artifacts.id)];

const ownedByUser = (userId: string) => eq(artifacts.userId, userId);

// THE ONE DEFINITION OF THE VISIBLE ARTIFACT SET. It owns the user guard, the
// order and `ARTIFACT_PULL_LIMIT`, and both stages join to it, so the cap bounds
// the visible set rather than the changed rows.
const recentArtifacts = (tx: DbTransaction, userId: string) =>
  tx
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(ownedByUser(userId))
    .orderBy(...artifactOrder)
    .limit(ARTIFACT_PULL_LIMIT)
    .as("recent_artifacts");

// Agent-produced artifacts (ADR-0075). Flat per-user pull bounded to the most
// recent ARTIFACT_PULL_LIMIT; the sidebar filters by threadId client-side. A
// `generating` row syncs too (content may still be null) so the sidebar can
// render the placeholder while the boss authors.
export const fetchArtifacts = syncEntity(SYNC_MODEL.artifact, {
  versionQuery: (tx, userId) => {
    const visible = recentArtifacts(tx, userId);

    return tx
      .select({ id: artifacts.id, rowVersion: artifacts.rowVersion })
      .from(artifacts)
      .innerJoin(visible, eq(artifacts.id, visible.id))
      .orderBy(...artifactOrder);
  },
  loadQuery: (tx, userId, changed) => {
    const visible = recentArtifacts(tx, userId);

    return tx
      .select(getTableColumns(artifacts))
      .from(artifacts)
      .innerJoin(visible, eq(artifacts.id, visible.id))
      .where(
        inArray(
          artifacts.id,
          changed.map((v) => v.id),
        ),
      )
      .orderBy(...artifactOrder);
  },
  map: (a: Artifact) => a,
});
