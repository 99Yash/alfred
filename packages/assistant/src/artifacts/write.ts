import {
  DOCUMENT_MARKDOWN_MAX,
  emptyArtifactContent,
  type ArtifactFormat,
  type ArtifactKind,
  type ArtifactPage,
} from "@alfred/contracts";
import {
  validatePdfArtifactHtml,
  validateSlideArtifactHtml,
  type ArtifactHtmlValidation,
} from "@alfred/artifacts-design/validation";
import { db } from "@alfred/db";
import { artifacts, chatMessages, type Artifact } from "@alfred/db/schemas";
import { and, eq, exists, inArray, sql } from "drizzle-orm";
import { emitReplicachePokes } from "@alfred/assistant/triggers";
import { AppError } from "@alfred/contracts/app-errors";
import { artifactReplacementMatchesBase } from "./content-hash";

/**
 * Write path for agent-authored artifacts (ADR-0075). The artifact tools call this;
 * the turn finalizer calls {@link finalizeRunArtifacts}.
 * Every write bumps `row_version` and pokes after commit, so the sidebar updates per page.
 * Content reads and writes run under `SELECT … FOR UPDATE` against concurrent runs.
 */

export interface ArtifactWriteContext {
  userId: string;
  /** Required: artifacts are thread-owned. */
  threadId: string;
  runId: string;
}

export type CreateArtifactResult =
  | {
      ok: true;
      artifactId: string;
      title: string;
      kind: ArtifactKind;
      format: ArtifactFormat | null;
    }
  | { ok: false; status: "no_thread"; reason: string };

export type AppendArtifactPageResult =
  | { ok: true; artifactId: string; pageCount: number }
  | {
      ok: false;
      status: "not_found" | "wrong_kind" | "page_limit" | "invalid_content";
      reason: string;
    };

export type AppendArtifactSectionResult =
  | { ok: true; artifactId: string; contentChars: number }
  | {
      ok: false;
      status: "not_found" | "wrong_kind" | "content_limit";
      reason: string;
    };

export type UpdateArtifactResult =
  | { ok: true; artifactId: string; title: string; kind: ArtifactKind }
  | {
      ok: false;
      status: "not_found" | "wrong_kind" | "stale_content" | "invalid_content";
      reason: string;
    };

/** Same cap as `artifactContentSchema`. */
const MAX_PAGES = 100;

/**
 * Check a page against its format's contract: full for `pdf`, motion-only for `slides`.
 * The column is nullable (`document` has none), so a null format skips the check.
 * The tool schema already requires a format for `pages`.
 */
function validatePageForFormat(
  format: ArtifactFormat | null,
  html: string,
): ArtifactHtmlValidation {
  if (format === "pdf") return validatePdfArtifactHtml(html);

  if (format === "slides") return validateSlideArtifactHtml(html);

  return { ok: true };
}

/**
 * Create an artifact in `generating`. `document` seeds its markdown; `pages` starts
 * empty for {@link appendArtifactPage}. The finalizer marks it `complete`.
 */
export async function createArtifact(
  ctx: ArtifactWriteContext,
  input: {
    title: string;
    kind: ArtifactKind;
    format?: ArtifactFormat | undefined;
    markdown?: string | undefined;
  },
): Promise<CreateArtifactResult> {
  const content =
    input.kind === "document"
      ? { kind: "document" as const, markdown: input.markdown ?? "" }
      : emptyArtifactContent("pages");

  // `message_id` starts NULL: the assistant message is not saved until the turn ends,
  // so the FK would fail. `finalizeRunArtifacts` fills it in.
  let row: Pick<Artifact, "id" | "title" | "kind" | "format"> | undefined;

  try {
    [row] = await db()
      .insert(artifacts)
      .values({
        userId: ctx.userId,
        threadId: ctx.threadId,
        runId: ctx.runId,
        kind: input.kind,
        format: input.kind === "pages" ? (input.format ?? null) : null,
        title: input.title,
        status: "generating",
        content,
      })
      .returning({
        id: artifacts.id,
        title: artifacts.title,
        kind: artifacts.kind,
        format: artifacts.format,
      });
  } catch (err) {
    throw new AppError("artifact_create_failed", { cause: err });
  }

  if (!row) throw new Error("[createArtifact] insert returned no row");
  emitReplicachePokes([ctx.userId]);

  return { ok: true, artifactId: row.id, title: row.title, kind: row.kind, format: row.format };
}

/** Append one HTML page under a row lock. Refuses a `document`, an unknown id, or a full list. */
export async function appendArtifactPage(
  ctx: ArtifactWriteContext,
  input: { artifactId: string; title: string; html: string },
): Promise<AppendArtifactPageResult> {
  const page: ArtifactPage = { title: input.title, html: input.html };

  const result = await db().transaction(async (tx) => {
    const [row] = await tx
      .select({ kind: artifacts.kind, format: artifacts.format, content: artifacts.content })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.id, input.artifactId),
          eq(artifacts.userId, ctx.userId),
          eq(artifacts.threadId, ctx.threadId),
        ),
      )
      .for("update");

    if (!row) return { status: "not_found" as const };

    if (row.kind !== "pages" || !row.content || row.content.kind !== "pages") {
      return { status: "wrong_kind" as const };
    }

    const validation = validatePageForFormat(row.format, page.html);

    if (!validation.ok) {
      return { status: "invalid_content" as const, reason: validation.reason };
    }

    if (row.content.pages.length >= MAX_PAGES) return { status: "page_limit" as const };

    const pages = [...row.content.pages, page];
    await tx
      .update(artifacts)
      .set({
        content: { kind: "pages", pages },
        rowVersion: sql`${artifacts.rowVersion} + 1`,
      })
      .where(
        and(
          eq(artifacts.id, input.artifactId),
          eq(artifacts.userId, ctx.userId),
          eq(artifacts.threadId, ctx.threadId),
        ),
      );

    return { status: "ok" as const, pageCount: pages.length };
  });

  if (result.status === "not_found") {
    return { ok: false, status: "not_found", reason: "no artifact with that id for this user" };
  }

  if (result.status === "wrong_kind") {
    return {
      ok: false,
      status: "wrong_kind",
      reason: "append_artifact_page only works on a 'pages' artifact",
    };
  }

  if (result.status === "page_limit") {
    return {
      ok: false,
      status: "page_limit",
      reason: `an artifact holds at most ${MAX_PAGES} pages`,
    };
  }

  if (result.status === "invalid_content") {
    return { ok: false, status: "invalid_content", reason: result.reason };
  }

  emitReplicachePokes([ctx.userId]);

  return { ok: true, artifactId: input.artifactId, pageCount: result.pageCount };
}

/**
 * Append one markdown section to a `document` (ADR-0085), under the same row lock.
 * Refuses a `pages` artifact, an unknown id, or going past {@link DOCUMENT_MARKDOWN_MAX}.
 * Additive and locked, so it needs no `baseContentHash` and is safe across turns.
 */
export async function appendArtifactSection(
  ctx: ArtifactWriteContext,
  input: { artifactId: string; markdown: string },
): Promise<AppendArtifactSectionResult> {
  const result = await db().transaction(async (tx) => {
    const [row] = await tx
      .select({ kind: artifacts.kind, content: artifacts.content })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.id, input.artifactId),
          eq(artifacts.userId, ctx.userId),
          eq(artifacts.threadId, ctx.threadId),
        ),
      )
      .for("update");

    if (!row) return { status: "not_found" as const };

    if (row.kind !== "document" || !row.content || row.content.kind !== "document") {
      return { status: "wrong_kind" as const };
    }

    const current = row.content.markdown;
    const next = current.length > 0 ? `${current}\n\n${input.markdown}` : input.markdown;

    // `content` is typed with `.$type<>()` only, so no Zod runs before this write. Check the cap here.
    if (next.length > DOCUMENT_MARKDOWN_MAX) return { status: "content_limit" as const };

    await tx
      .update(artifacts)
      .set({
        content: { kind: "document", markdown: next },
        rowVersion: sql`${artifacts.rowVersion} + 1`,
      })
      .where(
        and(
          eq(artifacts.id, input.artifactId),
          eq(artifacts.userId, ctx.userId),
          eq(artifacts.threadId, ctx.threadId),
        ),
      );

    return { status: "ok" as const, contentChars: next.length };
  });

  if (result.status === "not_found") {
    return { ok: false, status: "not_found", reason: "no artifact with that id for this user" };
  }

  if (result.status === "wrong_kind") {
    return {
      ok: false,
      status: "wrong_kind",
      reason: "append_artifact_section only works on a 'document' artifact",
    };
  }

  if (result.status === "content_limit") {
    return {
      ok: false,
      status: "content_limit",
      reason: `a document holds at most ${DOCUMENT_MARKDOWN_MAX} characters`,
    };
  }

  emitReplicachePokes([ctx.userId]);

  return { ok: true, artifactId: input.artifactId, contentChars: result.contentChars };
}

/**
 * Rename an artifact, or replace its whole content. Content type must match the kind.
 * Partial edits are not supported.
 */
export async function updateArtifact(
  ctx: ArtifactWriteContext,
  input: {
    artifactId: string;
    title?: string | undefined;
    markdown?: string | undefined;
    pages?: ArtifactPage[] | undefined;
    baseContentHash?: string | undefined;
  },
): Promise<UpdateArtifactResult> {
  const result = await db().transaction(async (tx) => {
    const [row] = await tx
      .select({
        kind: artifacts.kind,
        format: artifacts.format,
        title: artifacts.title,
        runId: artifacts.runId,
        content: artifacts.content,
      })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.id, input.artifactId),
          eq(artifacts.userId, ctx.userId),
          eq(artifacts.threadId, ctx.threadId),
        ),
      )
      .for("update");

    if (!row) return { status: "not_found" as const };

    if (input.markdown !== undefined && row.kind !== "document") {
      return { status: "wrong_kind" as const, want: "document" };
    }

    if (input.pages !== undefined && row.kind !== "pages") {
      return { status: "wrong_kind" as const, want: "pages" };
    }

    if (input.pages !== undefined) {
      for (const page of input.pages) {
        const validation = validatePageForFormat(row.format, page.html);

        if (!validation.ok) {
          return { status: "invalid_content" as const, reason: validation.reason };
        }
      }
    }

    const replacesContent = input.markdown !== undefined || input.pages !== undefined;

    // A cross-turn full replacement must prove the model saw the full current body.
    // This blocks edits from a truncated view and lost updates.
    if (
      replacesContent &&
      row.runId !== ctx.runId &&
      !artifactReplacementMatchesBase({
        currentContent: row.content,
        rowRunId: row.runId,
        editingRunId: ctx.runId,
        baseContentHash: input.baseContentHash,
      })
    ) {
      return { status: "stale_content" as const };
    }

    // `pages` wins over `markdown` when both arrive.
    const set = {
      rowVersion: sql`${artifacts.rowVersion} + 1`,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.markdown !== undefined
        ? { content: { kind: "document" as const, markdown: input.markdown } }
        : {}),
      ...(input.pages !== undefined
        ? { content: { kind: "pages" as const, pages: input.pages } }
        : {}),
    };

    await tx
      .update(artifacts)
      .set(set)
      .where(
        and(
          eq(artifacts.id, input.artifactId),
          eq(artifacts.userId, ctx.userId),
          eq(artifacts.threadId, ctx.threadId),
        ),
      );

    return { status: "ok" as const, kind: row.kind, title: input.title ?? row.title };
  });

  if (result.status === "not_found") {
    return { ok: false, status: "not_found", reason: "no artifact with that id for this user" };
  }

  if (result.status === "wrong_kind") {
    return {
      ok: false,
      status: "wrong_kind",
      reason: `that content only applies to a '${result.want}' artifact`,
    };
  }

  if (result.status === "stale_content") {
    return {
      ok: false,
      status: "stale_content",
      reason:
        "content replacement rejected because the complete current artifact body was not supplied or changed after it was read",
    };
  }

  if (result.status === "invalid_content") {
    return { ok: false, status: "invalid_content", reason: result.reason };
  }

  emitReplicachePokes([ctx.userId]);

  return { ok: true, artifactId: input.artifactId, title: result.title, kind: result.kind };
}

/**
 * Move a run's `generating` artifacts to `complete`, or `error` on a faulted turn,
 * so none is left stuck. Pokes too, because the failure path has no other poke.
 */
export async function finalizeRunArtifacts(
  userId: string,
  runId: string,
  messageId: string,
  status: "complete" | "error",
  fromStatuses: readonly ("generating" | "error")[] = ["generating"],
): Promise<void> {
  const updated = await db()
    .update(artifacts)
    .set({ messageId, status, rowVersion: sql`${artifacts.rowVersion} + 1` })
    .where(
      and(
        eq(artifacts.userId, userId),
        eq(artifacts.runId, runId),
        inArray(artifacts.status, fromStatuses),
        exists(
          db()
            .select({ id: chatMessages.id })
            .from(chatMessages)
            .where(and(eq(chatMessages.id, messageId), eq(chatMessages.userId, userId))),
        ),
      ),
    )
    .returning({ id: artifacts.id });

  if (updated.length > 0) emitReplicachePokes([userId]);
}
