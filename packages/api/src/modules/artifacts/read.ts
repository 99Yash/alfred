import type { ArtifactContent } from "@alfred/contracts";
import { db } from "@alfred/db";
import { artifacts } from "@alfred/db/schemas";
import { and, desc, eq } from "drizzle-orm";

/**
 * Read path for agent-authored artifacts (ADR-0075). The chat-turn system
 * prompt calls {@link buildThreadArtifactsContext} so the boss knows which
 * artifacts already exist in this conversation — with their ids and current
 * content — and revises the open one in place instead of rebuilding it.
 *
 * WHY THIS EXISTS. Each chat turn is its own agent run; the run transcript is
 * rebuilt from `chat_messages` (role + content only — see `initialTranscript`),
 * so the `{ artifactId }` that `create_artifact` returned is dropped after the
 * turn that authored it. With no id in context the boss can't call
 * `update_artifact`, so a later "change the styling / remove that section"
 * lands with no target and falls back to `create_artifact` — rebuilding the
 * whole document from a fading memory. Observed failure: a resume's name drifted
 * Gourav Kar → Kar → Kumar and links were hallucinated across "edits", each a
 * fresh create. Injecting the id AND the current body closes both gaps: the boss
 * now has the id to update, and the exact text to preserve.
 */

/**
 * Max chars of the open artifact's body inlined into the system prompt. A bound,
 * not a squeeze: a resume/one-pager/short deck fits whole (so edits round-trip
 * faithfully); only a pathologically large deck is clipped, with a notice so the
 * model doesn't treat a partial body as complete. The system prompt is not
 * subject to the tool-result bound (bound.ts), so this is the one knob.
 */
const MAX_INLINE_CONTENT_CHARS = 20_000;

/** Render an artifact body to plain text for the prompt, bounded by length. */
function renderContent(content: ArtifactContent | null): string {
  if (!content) return "(empty)";
  if (content.kind === "document") {
    const md = content.markdown ?? "";
    if (md.length === 0) return "(empty)";
    return md.length > MAX_INLINE_CONTENT_CHARS
      ? `${md.slice(0, MAX_INLINE_CONTENT_CHARS)}\n…[content truncated for length — preserve the omitted tail on edit]`
      : md;
  }
  if (content.pages.length === 0) return "(no pages yet)";
  const parts: string[] = [];
  let used = 0;
  let shown = 0;
  for (const [i, page] of content.pages.entries()) {
    const header = `[Page ${i + 1}${page.title ? ` — "${page.title}"` : ""}]`;
    const block = `${header}\n${page.html ?? ""}`;
    // Always emit at least the first page whole; only start dropping once
    // something is shown and the budget is spent, so a single oversized page
    // still round-trips rather than vanishing.
    if (shown > 0 && used + block.length > MAX_INLINE_CONTENT_CHARS) {
      parts.push(
        `…[${content.pages.length - shown} more page(s) omitted for length — keep them on edit]`,
      );
      break;
    }
    parts.push(block);
    used += block.length;
    shown += 1;
  }
  return parts.join("\n\n");
}

/**
 * Build the "artifacts in this conversation" block for the chat system prompt,
 * or `""` when the thread has none. Lists every artifact with its id, most
 * recent first, and inlines the current (last-authored) one's body — that's the
 * one open in the sidebar and the default edit target. Earlier rows (including
 * any left over from the pre-fix rebuild-every-turn behavior) are named as
 * superseded so the model edits the current one unless the user points elsewhere.
 */
export async function buildThreadArtifactsContext(
  userId: string,
  threadId: string,
): Promise<string> {
  const rows = await db()
    .select({
      id: artifacts.id,
      title: artifacts.title,
      kind: artifacts.kind,
      format: artifacts.format,
      status: artifacts.status,
      content: artifacts.content,
    })
    .from(artifacts)
    .where(and(eq(artifacts.userId, userId), eq(artifacts.threadId, threadId)))
    .orderBy(desc(artifacts.createdAt));

  if (rows.length === 0) return "";

  const [current, ...earlier] = rows;
  if (!current) return ""; // unreachable (rows.length > 0), but narrows for TS
  const kindLabel = current.format ? `${current.kind} · ${current.format}` : current.kind;

  const lines = [
    "Artifacts already in this conversation (they render in the side panel). When the user asks to change, restyle, fix, or remove part of one, revise it IN PLACE with system.update_artifact using its id — do NOT create a new artifact for an edit, and keep every part the user did not ask you to change. The one currently open is:",
    `• ${current.id} — "${current.title}" (${kindLabel}, ${current.status})`,
    "Its exact current content follows — edit from THIS, do not rebuild it from memory:",
    renderContent(current.content),
  ];

  if (earlier.length > 0) {
    const list = earlier.map((r) => `${r.id} ("${r.title}")`).join(", ");
    lines.push(
      `Earlier artifacts in this thread are superseded — edit the current one above unless the user names a different one: ${list}.`,
    );
  }

  return lines.join("\n");
}
