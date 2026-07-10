import { useEffect, type RefObject } from "react";
import type { TiptapComposerHandle } from "../tiptap-composer";

export function useTypeAnywhere(
  editorRef: RefObject<TiptapComposerHandle | null>,
  disabled: boolean,
): void {
  // Type-anywhere autofocus: any printable keystroke on the page lands in
  // the composer. Skipped when the user is already inside an input / when a
  // modifier (⌘ / Ctrl / Alt) is held so app shortcuts still fire.
  useEffect(() => {
    if (disabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!e.key || e.key.length !== 1) return;
      const target = e.target;
      if (
        target instanceof HTMLElement &&
        target.closest("input, textarea, select, [contenteditable='true']")
      ) {
        return;
      }
      const handle = editorRef.current;
      if (!handle) return;
      e.preventDefault();
      handle.insertText(e.key);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [disabled, editorRef]);
}
