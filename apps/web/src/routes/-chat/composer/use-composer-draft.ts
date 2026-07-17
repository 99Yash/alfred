import { isRecord } from "@alfred/contracts";
import type { JSONContent } from "@tiptap/react";
import { useCallback, useMemo, useState } from "react";
import { safeGet, safeRemove, safeSet } from "~/lib/storage/storage";

export function useComposerDraft(threadId: string | undefined): {
  initialJSON: JSONContent | undefined;
  text: string;
  isEmpty: boolean;
  onEditorChange: (nextText: string, nextJSON: JSONContent, nextEmpty: boolean) => void;
  resetDraft: () => void;
} {
  // Persist drafts per thread (and a shared "new chat" bucket for the empty
  // /chat hero). Survives refresh; cleared on submit.
  const draftKey = `alfred:chat-draft:${threadId ?? "new"}`;

  // Seed the editor once on mount. Stored drafts are Tiptap JSON; we also
  // accept the legacy plain-string format so drafts written by the previous
  // textarea+mirror composer survive the migration.
  const initialJSON = useMemo(() => readDraftJSON(draftKey), [draftKey]);
  const [editorState, setEditorState] = useState<{
    text: string;
    isEmpty: boolean;
  }>(() => {
    const initialText = initialJSON ? extractTextFromJSON(initialJSON) : "";
    return { text: initialText, isEmpty: initialText.trim().length === 0 };
  });

  const onEditorChange = useCallback(
    (nextText: string, nextJSON: JSONContent, nextEmpty: boolean) => {
      setEditorState({ text: nextText, isEmpty: nextEmpty });
      if (nextEmpty) {
        safeRemove(draftKey);
      } else {
        safeSet(draftKey, JSON.stringify(nextJSON));
      }
    },
    [draftKey],
  );

  const resetDraft = useCallback(() => {
    setEditorState({ text: "", isEmpty: true });
    safeRemove(draftKey);
  }, [draftKey]);

  return {
    initialJSON,
    text: editorState.text,
    isEmpty: editorState.isEmpty,
    onEditorChange,
    resetDraft,
  };
}

function readDraftJSON(draftKey: string): JSONContent | undefined {
  const raw = safeGet(draftKey);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as JSONContent;
    if (isRecord(parsed) && "type" in parsed) return parsed as JSONContent;
  } catch {
    // Legacy plain-text draft — wrap as a single paragraph.
    return {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: raw }] }],
    };
  }
  return undefined;
}

/**
 * Mirrors what Tiptap's `editor.getText()` would produce for the given JSON,
 * used to seed the `canSend` check from a restored draft before the first
 * onUpdate fires. Each mention node contributes `@<label>` to match the
 * editor's configured `renderText`.
 */
function extractTextFromJSON(json: JSONContent): string {
  let out = "";
  const walk = (node: JSONContent) => {
    if (node.type === "text" && typeof node.text === "string") {
      out += node.text;
    } else if (node.type === "mention") {
      const label = node.attrs?.label ?? node.attrs?.id ?? "";
      out += `@${label}`;
    }
    if (Array.isArray(node.content)) {
      // ProseMirror block separators show up as newlines in getText().
      let first = true;
      for (const child of node.content) {
        if (!first && (child.type === "paragraph" || child.type === "hardBreak")) {
          out += "\n";
        }
        walk(child);
        first = false;
      }
    }
  };
  walk(json);
  return out;
}
