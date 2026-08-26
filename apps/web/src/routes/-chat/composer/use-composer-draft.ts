import { isRecord, safeJsonParse } from "@alfred/contracts";
import type { JSONContent } from "@tiptap/react";
import { useCallback, useMemo, useState } from "react";
import { safeGet, safeRemove, safeSet } from "~/lib/storage/storage";

interface ComposerDraft {
  initialJSON: JSONContent | undefined;
  text: string;
  isEmpty: boolean;
  onEditorChange: (nextText: string, nextJSON: JSONContent, nextEmpty: boolean) => void;
  resetDraft: () => void;
}

export function useComposerDraft(threadId: string | undefined): ComposerDraft {
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

  // Drafts written before JSON storage hold plain text: unparseable content
  // wraps as a single-paragraph doc rather than reading as an empty draft.
  // (`safeJsonParse` maps both malformed input and a literal "null" to null,
  // so the literal is answered explicitly.)
  const parsed = safeJsonParse(raw);
  if (parsed === null && raw !== "null") {
    return {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: raw }] }],
    };
  }
  if (isRecord(parsed) && "type" in parsed) {
    // SAFETY: the guards above proved the draft JSON is an object carrying
    // `type`, which is JSONContent's load-bearing shape here.
    return parsed as JSONContent;
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
