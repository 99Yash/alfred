import { useEffect, useState, type RefObject } from "react";

/** The hint arms after this hold, so a quick ⌘C or ⌘K does not flash it. */
const ARM_DELAY_MS = 150;

function isModifierKey(key: string): boolean {
  return key === "Meta" || key === "Control";
}

/**
 * True while ⌘ (or Ctrl) is held by itself with focus inside `scope`. The composer then shows
 * what ⌘↵ does, before the user presses ↵.
 */
export function useSteerModifier(scope: RefObject<HTMLElement | null>, enabled: boolean): boolean {
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let timer: number | undefined;

    const reset = () => {
      window.clearTimeout(timer);
      setHeld(false);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (isModifierKey(e.key)) {
        if (!scope.current?.contains(document.activeElement)) return;
        window.clearTimeout(timer);
        timer = window.setTimeout(() => setHeld(true), ARM_DELAY_MS);

        return;
      }

      // ⌘ with any key but ↵ is a shortcut, not a steer.
      if (e.key !== "Enter") reset();
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (isModifierKey(e.key) || (!e.metaKey && !e.ctrlKey)) reset();
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", reset);
    document.addEventListener("visibilitychange", reset);

    return () => {
      reset();
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", reset);
      document.removeEventListener("visibilitychange", reset);
    };
  }, [scope, enabled]);

  return enabled && held;
}
