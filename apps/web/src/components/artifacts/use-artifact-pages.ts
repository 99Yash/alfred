import {
  useCallback,
  useEffect,
  useEffectEvent,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

/**
 * The page a `pages` artifact is showing, scoped to the artifact it belongs to.
 *
 * The index is stored together with the artifact id, so opening a different
 * artifact derives back to page 0 on its own. A prop-sync effect would instead
 * paint the previous artifact's index for one frame.
 */
export function useArtifactPageIndex(
  artifactId: string,
): [number, Dispatch<SetStateAction<number>>] {
  const [state, setState] = useState<{ forId: string; index: number }>({
    forId: artifactId,
    index: 0,
  });

  const index = state.forId === artifactId ? state.index : 0;

  const setIndex = useCallback<Dispatch<SetStateAction<number>>>(
    (action) =>
      setState((previous) => {
        const current = previous.forId === artifactId ? previous.index : 0;
        const next = typeof action === "function" ? action(current) : action;

        return { forId: artifactId, index: next };
      }),
    [artifactId],
  );

  return [index, setIndex];
}

/**
 * Arrow-key page navigation, clamped to `pageCount`.
 *
 * `enabled` exists because two viewers of the same artifact can be mounted at
 * once — the library's page body and the presentation overlay stacked over it.
 * Both listen on `window`, so the one underneath must unsubscribe or a single
 * key press advances the shared index twice.
 */
export function useArtifactPageKeys({
  enabled,
  pageCount,
  onIndexChange,
}: {
  enabled: boolean;
  pageCount: number;
  onIndexChange: Dispatch<SetStateAction<number>>;
}): void {
  const onKey = useEffectEvent((key: string) => {
    const delta = key === "ArrowRight" || key === "ArrowDown" ? 1 : -1;

    onIndexChange((current) => {
      const next = current + delta;

      if (next < 0) return 0;

      if (next > pageCount - 1) return Math.max(0, pageCount - 1);

      return next;
    });
  });

  useEffect(() => {
    if (!enabled) return;

    const handler = (event: KeyboardEvent) => {
      if (
        event.key === "ArrowRight" ||
        event.key === "ArrowDown" ||
        event.key === "ArrowLeft" ||
        event.key === "ArrowUp"
      ) {
        onKey(event.key);
      }
    };

    window.addEventListener("keydown", handler);

    return () => window.removeEventListener("keydown", handler);
  }, [enabled]);
}
