import type { DbTransaction } from "@alfred/db";
import { artifacts, type Artifact } from "@alfred/db/schemas";
import { SYNC_MODEL } from "@alfred/sync";
import { desc, eq, getTableColumns, inArray } from "drizzle-orm";
import { syncEntity } from "./sync-entity";

const ARTIFACT_PULL_LIMIT = 200;

const artifactOrder = [desc(artifacts.createdAt), desc(artifacts.id)];

const ownedByUser = (userId: string) => eq(artifacts.userId, userId);

// The visible set, shared by both stages, so the cap bounds the set and not the changed rows.
const recentArtifacts = (tx: DbTransaction, userId: string) =>
  tx
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(ownedByUser(userId))
    .orderBy(...artifactOrder)
    .limit(ARTIFACT_PULL_LIMIT)
    .as("recent_artifacts");

// ADR-0075. The sidebar filters by thread on the client. A `generating` row
// syncs with null content so the sidebar can show a placeholder.
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
