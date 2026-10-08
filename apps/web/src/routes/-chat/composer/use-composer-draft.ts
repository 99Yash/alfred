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
  // Per-thread drafts, plus a "new" bucket for /chat. Cleared on submit.
  const draftKey = `alfred:chat-draft:${threadId ?? "new"}`;

  // Tiptap JSON, or a legacy plain-string draft.
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

  // Legacy drafts are plain text: wrap them in a paragraph.
  // `safeJsonParse` maps both bad input and a literal "null" to null, so handle the literal here.
  const parsed = safeJsonParse(raw);

  if (parsed === null && raw !== "null") {
    return {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: raw }] }],
    };
  }

  if (isRecord(parsed) && "type" in parsed) {
    // SAFETY: the guards proved an object with `type`, the shape JSONContent needs here.
    return parsed as JSONContent;
  }

  return undefined;
}

/** Match `editor.getText()` for a restored draft, before the first onUpdate. Mentions give `@<label>`. */
function extractTextFromJSON(json: JSONContent): string {
  let out = "";

  const walk = (node: JSONContent) => {
    if (node.type === "text" && node.text !== undefined) {
      out += node.text;
    } else if (node.type === "mention") {
      const label = node.attrs?.label ?? node.attrs?.id ?? "";
      out += `@${label}`;
    }

    if (Array.isArray(node.content)) {
      // Block separators become newlines in getText().
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
