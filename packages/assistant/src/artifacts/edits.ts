import {
  artifactContentSchema,
  type ArtifactContent,
  type ArtifactPage,
  type ArtifactTextEdit,
} from "@alfred/contracts";

/**
 * Exact-match edits for `update_artifact`, after fx0's `edit_design`. Each `oldString`
 * must occur exactly once in the body as it stands after the edits before it. A model
 * that edits from a stale or partial view therefore gets a mismatch, not a lost update,
 * so this path needs no `baseContentHash`.
 */

export type ArtifactEditOutcome =
  | {
      ok: true;
      content: ArtifactContent;
      /** The pages an edit touched, for the format check. Empty for a document. */
      changedPages: readonly ArtifactPage[];
    }
  | { ok: false; status: "edit_mismatch" | "content_limit" | "wrong_kind"; reason: string };

/** Counts overlapping matches too, so `aa` in `aaa` is ambiguous. Stops at two. */
function findMatches(haystack: string, needle: string) {
  const index = haystack.indexOf(needle);

  if (index === -1) return { count: 0, index };

  return { count: haystack.includes(needle, index + 1) ? 2 : 1, index };
}

function replaceAt(text: string, index: number, edit: ArtifactTextEdit): string {
  return text.slice(0, index) + edit.newString + text.slice(index + edit.oldString.length);
}

function mismatch(position: number, count: number): ArtifactEditOutcome {
  const found = count === 0 ? "matched nothing" : "matched more than once";

  return {
    ok: false,
    status: "edit_mismatch",
    reason: `edit ${position + 1} ${found}; each oldString must be raw text that occurs exactly once in the body as it stands after the edits before it. No edit was saved.`,
  };
}

/** Apply every edit or none. A deck counts matches across all pages; one edit cannot span two. */
export function applyArtifactEdits(
  content: ArtifactContent | null,
  edits: readonly ArtifactTextEdit[],
): ArtifactEditOutcome {
  let next: ArtifactContent;
  const changed = new Set<number>();

  if (content?.kind === "document") {
    let markdown = content.markdown;

    for (const [position, edit] of edits.entries()) {
      const match = findMatches(markdown, edit.oldString);

      if (match.count !== 1) return mismatch(position, match.count);
      markdown = replaceAt(markdown, match.index, edit);
    }

    next = { kind: "document", markdown };
  } else if (content?.kind === "pages") {
    const pages: ArtifactPage[] = [...content.pages];

    for (const [position, edit] of edits.entries()) {
      let count = 0;
      let targetPage = -1;
      let targetIndex = -1;

      for (const [page, { html }] of pages.entries()) {
        const match = findMatches(html, edit.oldString);

        if (match.count === 0) continue;
        count += match.count;

        if (count > 1) break;
        targetPage = page;
        targetIndex = match.index;
      }

      const page = pages[targetPage];

      if (count !== 1 || !page) return mismatch(position, count);
      pages[targetPage] = { ...page, html: replaceAt(page.html, targetIndex, edit) };
      changed.add(targetPage);
    }

    next = { kind: "pages", pages };
  } else {
    return {
      ok: false,
      status: "wrong_kind",
      reason: "edits only apply to a 'document' or 'pages' artifact",
    };
  }

  // `content` is typed with `.$type<>()` only, so the size caps are checked here.
  const parsed = artifactContentSchema.safeParse(next);

  if (!parsed.success) {
    return {
      ok: false,
      status: "content_limit",
      reason: "the edited body exceeds the artifact size limit. No edit was saved.",
    };
  }

  const changedPages =
    parsed.data.kind === "pages" ? parsed.data.pages.filter((_, index) => changed.has(index)) : [];

  return { ok: true, content: parsed.data, changedPages };
}
