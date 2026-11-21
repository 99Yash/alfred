/**
 * Lazy Tiptap composer. Tiptap and ProseMirror were about a third of the chat
 * route chunk, so the editor loads as its own chunk. The import starts when this
 * module evaluates, in parallel with the chat route render, and one shared
 * promise serves the preload and the `lazy` below. A failed load rejects into
 * the router default error boundary, as the authed shell does.
 *
 * Until the editor mounts, a skeleton with the editor's box geometry holds its
 * place, and the ref gives a stand-in handle. The stand-in queues each command
 * (focus, insert, set, clear) and runs the queue in order on the real handle
 * when it attaches, so a prefill, a quote focus, a typed key, or an edit that
 * comes before the mount still lands. Before the mount, `getJSON` and `isEmpty`
 * read the initial draft, which is the content the editor mounts with.
 */

import type { JSONContent } from "@tiptap/react";
import { Suspense, lazy, useCallback, useImperativeHandle, useRef } from "react";
import { COMPOSER_EDITOR_BOX, ComposerPlaceholder } from "./composer-editor-chrome";
import type { TiptapComposerHandle, TiptapComposerProps } from "./tiptap-composer";

type TiptapComposerModule = typeof import("./tiptap-composer");

let loadPromise: Promise<TiptapComposerModule> | undefined;

function loadTiptapComposer(): Promise<TiptapComposerModule> {
  loadPromise ??= import("./tiptap-composer");

  return loadPromise;
}

void loadTiptapComposer();

const TiptapComposer = lazy(async () => ({ default: (await loadTiptapComposer()).TiptapComposer }));

const EMPTY_DOC: JSONContent = { type: "doc", content: [] };

type Command = (handle: TiptapComposerHandle) => void;

export function LazyTiptapComposer({ ref, ...props }: TiptapComposerProps) {
  const { initialJSON } = props;
  const realRef = useRef<TiptapComposerHandle | null>(null);
  const queueRef = useRef<Command[]>([]);
  const initialJSONRef = useRef(initialJSON);

  // Stable, so React attaches it once per editor and does not detach on each render.
  const attach = useCallback((handle: TiptapComposerHandle | null) => {
    realRef.current = handle;

    if (!handle) return;

    for (const command of queueRef.current.splice(0)) command(handle);
  }, []);

  useImperativeHandle(ref, () => {
    const run = (command: Command) => {
      const handle = realRef.current;

      if (handle) command(handle);
      else queueRef.current.push(command);
    };

    return {
      focusEnd: () => run((h) => h.focusEnd()),
      insertText: (text) => run((h) => h.insertText(text)),
      insertAtTrigger: () => run((h) => h.insertAtTrigger()),
      clear: () => run((h) => h.clear()),
      setJSON: (json) => run((h) => h.setJSON(json)),
      setText: (text) => run((h) => h.setText(text)),
      isEmpty: () => realRef.current?.isEmpty() ?? initialJSONRef.current === undefined,
      getJSON: () => realRef.current?.getJSON() ?? initialJSONRef.current ?? EMPTY_DOC,
    };
  }, []);

  return (
    <Suspense fallback={<ComposerSkeleton {...props} />}>
      <TiptapComposer ref={attach} {...props} />
    </Suspense>
  );
}

/**
 * The editor's empty box with its placeholder. It shows for about one frame,
 * so it carries the geometry but not the draft text.
 */
function ComposerSkeleton({ initialJSON, placeholder, disabled, ghostText }: TiptapComposerProps) {
  const ghostVisible = Boolean(ghostText) && !disabled;

  return (
    <div className="relative">
      <div aria-hidden className={COMPOSER_EDITOR_BOX} />
      {placeholder && !initialJSON && !ghostVisible ? (
        <ComposerPlaceholder>{placeholder}</ComposerPlaceholder>
      ) : null}
    </div>
  );
}
