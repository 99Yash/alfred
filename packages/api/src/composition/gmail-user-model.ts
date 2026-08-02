import { toMessage, USER_MODEL_PROJECTION_NAME, withDefaults } from "@alfred/contracts";
import { db } from "@alfred/db";
import { activeProjectionVersions, documents } from "@alfred/db/schemas";
import { and, eq, inArray } from "drizzle-orm";
import {
  enqueueGmailKindRefold,
  registerGmailUserModelHandler,
  type GmailKindRefoldResult,
  type GmailUserModelHandler,
} from "../modules/integrations";
import {
  appendObservationFamilyMember,
  reduceGmailDocument,
  refoldActiveGmailKindProjection,
  type GmailDocumentForReduction,
} from "../modules/user-model";

const OBSERVATION_QUERY_CHUNK_SIZE = 1000;

let unregisterGmailUserModelHandler: (() => void) | undefined;

interface GmailUserModelAdapterDeps {
  loadDocumentChunk(
    userId: string,
    documentIds: readonly string[],
  ): Promise<GmailDocumentForReduction[]>;
  reduceDocument: typeof reduceGmailDocument;
  appendObservation: (
    input: Parameters<typeof appendObservationFamilyMember>[0],
  ) => Promise<{ status: "inserted" | "deduped" }>;
  enqueueRefold(userId: string): Promise<void>;
  loadActiveProjectionUserIds(): Promise<string[]>;
  refoldProjection: typeof refoldActiveGmailKindProjection;
}

async function loadGmailDocumentChunk(
  userId: string,
  documentIds: readonly string[],
): Promise<GmailDocumentForReduction[]> {
  return db()
    .select({
      id: documents.id,
      userId: documents.userId,
      sourceId: documents.sourceId,
      sourceThreadId: documents.sourceThreadId,
      accountId: documents.accountId,
      title: documents.title,
      authoredAt: documents.authoredAt,
      raw: documents.raw,
      metadata: documents.metadata,
    })
    .from(documents)
    .where(
      and(
        eq(documents.userId, userId),
        eq(documents.source, "gmail"),
        inArray(documents.id, documentIds),
      ),
    );
}

async function loadActiveProjectionUserIds(): Promise<string[]> {
  const rows = await db()
    .select({ userId: activeProjectionVersions.userId })
    .from(activeProjectionVersions)
    .where(eq(activeProjectionVersions.projectionName, USER_MODEL_PROJECTION_NAME));
  return rows.map((row) => row.userId);
}

const DEFAULT_DEPS: GmailUserModelAdapterDeps = {
  loadDocumentChunk: loadGmailDocumentChunk,
  reduceDocument: reduceGmailDocument,
  appendObservation: async (input) => {
    const result = await appendObservationFamilyMember(input);
    return { status: result.status };
  },
  enqueueRefold: enqueueGmailKindRefold,
  loadActiveProjectionUserIds,
  refoldProjection: refoldActiveGmailKindProjection,
};

function connectionRefoldResult(
  result: Awaited<ReturnType<typeof refoldActiveGmailKindProjection>>,
): GmailKindRefoldResult {
  switch (result.status) {
    case "skipped":
      return { status: "skipped", reason: result.reason };
    case "blocked":
      return {
        status: "blocked",
        reason: result.reason,
        ...(result.activeChecksum ? { activeChecksum: result.activeChecksum } : {}),
        ...(result.recomputedChecksum ? { recomputedChecksum: result.recomputedChecksum } : {}),
      };
    case "activated":
      return {
        status: "activated",
        projectionVersion: result.projectionVersion,
        profileCount: result.profileCount,
        checksum: result.checksum,
      };
  }
}

/** Build the user-model adapter. Overrides are an internal seam for adapter tests. */
export function createGmailUserModelHandler(
  overrides: Partial<GmailUserModelAdapterDeps> = {},
): GmailUserModelHandler {
  const deps = withDefaults(DEFAULT_DEPS, overrides);
  return {
    async capture(request) {
      if (request.documentIds.length === 0) return { status: "captured" };

      try {
        const docs: GmailDocumentForReduction[] = [];
        for (
          let offset = 0;
          offset < request.documentIds.length;
          offset += OBSERVATION_QUERY_CHUNK_SIZE
        ) {
          docs.push(
            ...(await deps.loadDocumentChunk(
              request.userId,
              request.documentIds.slice(offset, offset + OBSERVATION_QUERY_CHUNK_SIZE),
            )),
          );
        }

        let inserted = 0;
        let deduped = 0;
        let skipped = 0;
        let warnings = 0;
        let errors = 0;
        for (const doc of docs) {
          try {
            const reduced = deps.reduceDocument(doc);
            for (const issue of reduced.issues) {
              if (issue.severity === "skip") skipped++;
              else warnings++;
              console.warn(
                `[ingestion:worker] user-model gmail observation ${issue.severity} ` +
                  `doc=${doc.id} ${issue.code}: ${issue.message}`,
              );
            }
            for (const observation of reduced.observations) {
              const result = await deps.appendObservation(observation);
              if (result.status === "deduped") deduped++;
              else inserted++;
            }
          } catch (err) {
            errors++;
            console.warn(
              `[ingestion:worker] user-model gmail observation failed doc=${doc.id}:`,
              toMessage(err),
            );
          }
        }

        console.log(
          `[ingestion:worker] user-model gmail observations user=${request.userId} docs=${docs.length} ` +
            `inserted=${inserted} deduped=${deduped} skipped=${skipped} warnings=${warnings} errors=${errors}`,
        );
        if (inserted > 0) await deps.enqueueRefold(request.userId);

        return { status: "captured" };
      } catch (err) {
        console.warn(
          `[ingestion:worker] user-model gmail observation capture failed user=${request.userId}:`,
          toMessage(err),
        );
        return { status: "failed" };
      }
    },
    async refold(request) {
      return connectionRefoldResult(await deps.refoldProjection(request.userId));
    },
    async sweep() {
      const userIds = await deps.loadActiveProjectionUserIds();
      for (const userId of userIds) await deps.enqueueRefold(userId);
      console.log(
        `[ingestion:worker] user_model.gmail_kind_refold_sweep enqueued=${userIds.length}`,
      );
      return { enqueued: userIds.length };
    },
  };
}

/** Connect Gmail ingestion to user-model behavior without a private module import. */
export function registerGmailUserModel(): void {
  if (unregisterGmailUserModelHandler) return;
  unregisterGmailUserModelHandler = registerGmailUserModelHandler(createGmailUserModelHandler());
}

export function unregisterGmailUserModel(): void {
  unregisterGmailUserModelHandler?.();
  unregisterGmailUserModelHandler = undefined;
}
