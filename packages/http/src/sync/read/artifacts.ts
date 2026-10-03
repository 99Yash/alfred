import type { DbTransaction } from "@alfred/db";
import { artifacts, type Artifact } from "@alfred/db/schemas";
import { SYNC_MODEL } from "@alfred/sync";
import { and, desc, eq, getTableColumns, inArray } from "drizzle-orm";
import { syncEntity } from "./sync-entity";

/** Most-recent agent-produced artifacts synced per user (ADR-0075). */
const ARTIFACT_PULL_LIMIT = 200;

const artifactOrder = [desc(artifacts.createdAt), desc(artifacts.id)];

const ownedByUser = (userId: string) => eq(artifacts.userId, userId);

// One definition of the visible artifact window, so the load stage cannot pick a
// different 200 than the version stage counted.
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
  versionQuery: (tx, userId) =>
    tx
      .select({ id: artifacts.id, rowVersion: artifacts.rowVersion })
      .from(artifacts)
      .where(ownedByUser(userId))
      .orderBy(...artifactOrder)
      .limit(ARTIFACT_PULL_LIMIT),
  loadQuery: (tx, userId, changed) => {
    const visible = recentArtifacts(tx, userId);

    return tx
      .select(getTableColumns(artifacts))
      .from(artifacts)
      .innerJoin(visible, eq(artifacts.id, visible.id))
      .where(
        and(
          ownedByUser(userId),
          inArray(
            artifacts.id,
            changed.map((v) => v.id),
          ),
        ),
      )
      .orderBy(...artifactOrder);
  },
  map: (a: Artifact) => a,
});
