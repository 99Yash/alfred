import { useEffect, type RefObject } from "react";
import type { TiptapComposerHandle } from "../tiptap-composer";

export function useTypeAnywhere(
  editorRef: RefObject<TiptapComposerHandle | null>,
  disabled: boolean,
): void {
  // Printable keys anywhere go to the composer. Skipped inside inputs or with ⌘/Ctrl/Alt held.
  useEffect(() => {
    if (disabled) return;

    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // A modal owns the keyboard while it is open. The lightbox is the first
      // input-less dialog here, so without this every key typed over it lands
      // in the composer draft behind the overlay.
      if (e.defaultPrevented) return;

      const target = e.target;

      if (target instanceof HTMLElement && target.closest('[role="dialog"]')) return;

      if (!e.key || e.key.length !== 1) return;

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
