import {
  emptyArtifactContent,
  type ArtifactFormat,
  type ArtifactKind,
  type ArtifactPage,
} from "@alfred/contracts";
import { validatePdfArtifactHtml } from "@alfred/artifacts-design/validation";
import { db } from "@alfred/db";
import { artifacts, chatMessages, type Artifact } from "@alfred/db/schemas";
import { and, eq, exists, sql } from "drizzle-orm";
import { emitReplicachePokes } from "../../events/replicache-events";
import { AppError } from "../../lib/app-errors";
import { artifactReplacementMatchesBase } from "./content-hash";

/**
 * Server-side write path for agent-authored artifacts (ADR-0075). The
 * `system.create_artifact` / `append_artifact_page` / `update_artifact` tools
 * delegate here; the chat-turn finalizer calls {@link finalizeRunArtifacts} to
 * close out a turn's artifacts.
 *
 * Every mutation bumps `row_version` and pokes the user AFTER commit, so the
 * sidebar sees content arrive at page/step granularity (the v1 "streaming"
 * model — there is no token-level stream; see the artifact-sidebar plan). Reads
 * + writes of a `pages` row's content run inside a `SELECT … FOR UPDATE`
 * transaction as a second line of defense against callers outside the ordered
 * chat dispatcher and concurrent runs editing the same artifact.
 */

/** Common provenance every write carries — who/where the artifact belongs to. */
export interface ArtifactWriteContext {
  userId: string;
  /** The chat thread that produced the artifact (required — artifacts are thread-owned). */
  threadId: string;
  /** The authoring agent run (audit/replay). */
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

export type UpdateArtifactResult =
  | { ok: true; artifactId: string; title: string; kind: ArtifactKind }
  | {
      ok: false;
      status: "not_found" | "wrong_kind" | "stale_content" | "invalid_content";
      reason: string;
    };

/** Hard ceiling on pages per artifact — mirrors the `artifactContentSchema` cap. */
const MAX_PAGES = 100;

/**
 * Create a new artifact row in `generating` status. `document` seeds its
 * markdown body (the boss authors the whole doc in one call); `pages` seeds an
 * empty page list that subsequent {@link appendArtifactPage} calls fill. The
 * turn finalizer flips the row to `complete` when the authoring turn ends.
 */
export async function createArtifact(
  ctx: ArtifactWriteContext,
  input: { title: string; kind: ArtifactKind; format?: ArtifactFormat; markdown?: string },
): Promise<CreateArtifactResult> {
  const content =
    input.kind === "document"
      ? { kind: "document" as const, markdown: input.markdown ?? "" }
      : emptyArtifactContent("pages");

  // `message_id` starts NULL. The authoring assistant message is
  // not persisted to `chat_messages` until the turn finalizes (~minutes after
  // the tool runs), so referencing it here fails the `message_id` FK for every
  // in-turn create_artifact call. `finalizeRunArtifacts` backfills the column
  // after that message is persisted so the web can attach its trigger card.
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

/**
 * Append one HTML page to a `pages` artifact. Runs inside a row-locking
 * transaction so concurrent appends serialize and preserve every page. Refuses
 * a `document` artifact, an unknown id, or a full page list.
 */
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
    if (row.format === "pdf") {
      const validation = validatePdfArtifactHtml(page.html);
      if (!validation.ok) {
        return { status: "invalid_content" as const, reason: validation.reason };
      }
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
 * Revise an existing artifact: rename it, replace a `document`'s markdown, or
 * replace a `pages` artifact's whole page list. Content type must match the
 * artifact's kind (markdown↔document, pages↔pages). Find/replace and per-page
 * surgical edits are deferred (v1 edits flow through the boss as a full
 * replacement — see the plan).
 */
export async function updateArtifact(
  ctx: ArtifactWriteContext,
  input: {
    artifactId: string;
    title?: string;
    markdown?: string;
    pages?: ArtifactPage[];
    baseContentHash?: string;
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
    if (input.pages !== undefined && row.format === "pdf") {
      for (const page of input.pages) {
        const validation = validatePdfArtifactHtml(page.html);
        if (!validation.ok) {
          return { status: "invalid_content" as const, reason: validation.reason };
        }
      }
    }

    const replacesContent = input.markdown !== undefined || input.pages !== undefined;
    // Content authored earlier in this same run is already present in the live
    // transcript. Cross-turn full replacement is different: require proof that
    // the model received the complete, still-current body. This rejects edits
    // based on a truncated reference and lost updates after concurrent changes.
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

    const set: Record<string, unknown> = { rowVersion: sql`${artifacts.rowVersion} + 1` };
    if (input.title !== undefined) set.title = input.title;
    if (input.markdown !== undefined) set.content = { kind: "document", markdown: input.markdown };
    if (input.pages !== undefined) set.content = { kind: "pages", pages: input.pages };

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
 * Close out a turn's artifacts: flip every still-`generating` artifact authored
 * by `runId` to a terminal state (`complete` on a clean turn, `error` on a
 * faulted one). Called by the chat-turn finalizers so an artifact is never left
 * stuck `generating` if the boss forgets to "finish" it — completion is tied to
 * the authoring run's lifecycle, not a separate model tool. The caller already
 * pokes on turn end, but we poke here too so a finalize that runs without a
 * sibling poke (the failure path) still propagates the terminal state.
 */
export async function finalizeRunArtifacts(
  userId: string,
  runId: string,
  messageId: string,
  status: "complete" | "error",
): Promise<void> {
  const updated = await db()
    .update(artifacts)
    .set({ messageId, status, rowVersion: sql`${artifacts.rowVersion} + 1` })
    .where(
      and(
        eq(artifacts.userId, userId),
        eq(artifacts.runId, runId),
        eq(artifacts.status, "generating"),
        exists(
          db()
            .select({ id: chatMessages.id })
            .from(chatMessages)
            .where(
              and(eq(chatMessages.id, messageId), eq(chatMessages.userId, userId)),
            ),
        ),
      ),
    )
    .returning({ id: artifacts.id });

  if (updated.length > 0) emitReplicachePokes([userId]);
}
