import type { ExternalFileContent, ExternalFileSource } from "@alfred/contracts";
import { db } from "@alfred/db";
import { artifacts, type Artifact } from "@alfred/db/schemas";
import { emitReplicachePokes } from "../../events/replicache-events";
import { AppError } from "../../lib/app-errors";
import type { ArtifactWriteContext } from "./write";

/**
 * Surface an existing external file (e.g. a Drive PDF) inline (#287, ADR-0075).
 *
 * When the agent cannot read/export a file on the user's behalf — a binary
 * upload that Drive refuses to export to text (the #267 friction case) — it
 * mints an `external_file` artifact instead of punting, so the user can view and
 * download the file themselves in the sidebar. Unlike the authored kinds, this
 * carries only a pointer (preview URL + provenance), never a body.
 *
 * The row is created `generating` with its content already complete: the
 * chat-turn finalizer ({@link finalizeRunArtifacts}) flips still-`generating`
 * rows for the run to `complete` AND backfills `messageId` after the authoring
 * message persists, so the in-message trigger card attaches on reload — exactly
 * the lifecycle the authored kinds use. (`messageId` can't be set at mint: the
 * assistant message isn't in `chat_messages` until the turn finalizes, so
 * referencing it here would fail the FK.)
 */
export interface SurfaceExternalFileInput {
  source: ExternalFileSource;
  fileId: string;
  previewUrl: string;
  webViewLink?: string;
  mimeType?: string;
  fileName?: string;
  /** Sidebar/card title (usually the file name). */
  title: string;
}

export interface SurfaceExternalFileResult {
  artifactId: string;
  title: string;
}

export async function surfaceExternalFileArtifact(
  ctx: ArtifactWriteContext,
  input: SurfaceExternalFileInput,
): Promise<SurfaceExternalFileResult> {
  const content: ExternalFileContent = {
    kind: "external_file",
    source: input.source,
    fileId: input.fileId,
    previewUrl: input.previewUrl,
    ...(input.webViewLink ? { webViewLink: input.webViewLink } : {}),
    ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    ...(input.fileName ? { fileName: input.fileName } : {}),
  };

  let row: Pick<Artifact, "id" | "title"> | undefined;
  try {
    [row] = await db()
      .insert(artifacts)
      .values({
        userId: ctx.userId,
        threadId: ctx.threadId,
        runId: ctx.runId,
        kind: "external_file",
        format: null,
        title: input.title,
        status: "generating",
        content,
      })
      .returning({ id: artifacts.id, title: artifacts.title });
  } catch (err) {
    throw new AppError("artifact_create_failed", { cause: err });
  }

  if (!row) throw new Error("[surfaceExternalFileArtifact] insert returned no row");
  emitReplicachePokes([ctx.userId]);
  return { artifactId: row.id, title: row.title };
}
