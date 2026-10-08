import type { ExternalFileContent, ExternalFileSource } from "@alfred/contracts";
import { db } from "@alfred/db";
import { artifacts, type Artifact } from "@alfred/db/schemas";
import { emitReplicachePokes } from "@alfred/assistant/triggers";
import { AppError } from "@alfred/contracts/app-errors";
import type { ArtifactWriteContext } from "./write";

/**
 * Show an external file, such as a Drive PDF, inline (#287, ADR-0075). Used when the agent
 * cannot export it to text (#267). Holds only a pointer, never a body.
 * Created `generating` with content done; {@link finalizeRunArtifacts} marks it complete
 * and fills `messageId`, as for authored kinds.
 */
export interface SurfaceExternalFileInput {
  source: ExternalFileSource;
  fileId: string;
  previewUrl: string;
  webViewLink?: string | undefined;
  mimeType?: string;
  fileName?: string;
  /** Usually the file name. */
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
