import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { useReplicache } from "~/lib/replicache/context";

/** Rename, pin, and delete for one chat thread. */
export interface ThreadActions {
  rename: (id: string, title: string) => void;
  setPinned: (id: string, pinned: boolean) => void;
  remove: (id: string) => void;
}

/**
 * The ONE write path for a thread's own lifecycle.
 *
 * Two surfaces offer these actions — the sidebar row menu and the chat
 * header's "…" menu — and they used to hold a private copy each. The copies
 * agreed by accident rather than by construction, which is the failure this
 * hook removes: a rule added to one (the bounce below is exactly that kind of
 * rule) silently did not apply to the other, and both menus look correct in
 * isolation because each still renames the thread it was told to.
 *
 * DELETING THE THREAD YOU ARE READING BOUNCES TO `/chat`. Without it the route
 * keeps rendering a thread that no longer exists, and the next Replicache pull
 * empties the transcript under the reader. The rule belongs here and not at a
 * call site, because "am I looking at the row I just deleted?" is the same
 * question from both menus; `activeThreadId` is what each one answers it with.
 *
 * Returns `undefined` until Replicache is open. A caller that gets `undefined`
 * must render inert rows rather than a menu that does nothing when clicked.
 */
export function useThreadActions(activeThreadId: string | undefined): ThreadActions | undefined {
  const rep = useReplicache();
  const navigate = useNavigate();

  return useMemo<ThreadActions | undefined>(() => {
    if (!rep) return undefined;

    return {
      rename: (id, title) => void rep.mutate.chatThreadRename({ id, title }),
      setPinned: (id, pinned) => void rep.mutate.chatThreadSetPinned({ id, pinned }),
      remove: (id) => {
        void rep.mutate.chatThreadDelete({ id });

        if (activeThreadId === id) void navigate({ to: "/chat" });
      },
    };
  }, [rep, activeThreadId, navigate]);
}
