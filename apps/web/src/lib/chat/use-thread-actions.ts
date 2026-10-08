import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { useReplicache } from "~/lib/replicache/context";

export interface ThreadActions {
  rename: (id: string, title: string) => void;
  setPinned: (id: string, pinned: boolean) => void;
  remove: (id: string) => void;
}

/**
 * Rename, pin, and delete for the sidebar and header menus. Deleting the open
 * thread goes to `/chat`. `undefined` until Replicache opens: render inert rows.
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
