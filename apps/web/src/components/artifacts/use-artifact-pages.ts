import {
  useCallback,
  useEffect,
  useEffectEvent,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { isStateUpdater } from "~/lib/set-state";

/** Stored with the artifact id, so a different artifact derives page 0 without a sync effect. */
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
        const next = isStateUpdater(action) ? action(current) : action;

        return { forId: artifactId, index: next };
      }),
    [artifactId],
  );

  return [index, setIndex];
}

/**
 * Arrow-key paging. Disable the viewer underneath the presentation overlay:
 * both listen on `window`, so one key would advance twice.
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
