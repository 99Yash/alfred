import { useEffect, useState } from "react";
import type { ChatSidePanelMode } from "./models";

const RAIL_BREAKPOINT = "(min-width: 1280px)";

export function useRailMode(): ChatSidePanelMode {
  const [mode, setMode] = useState<ChatSidePanelMode>(() => {
    if (typeof window === "undefined") return "inline";
    return window.matchMedia(RAIL_BREAKPOINT).matches ? "inline" : "overlay";
  });
  useEffect(() => {
    const mq = window.matchMedia(RAIL_BREAKPOINT);
    const handler = () => setMode(mq.matches ? "inline" : "overlay");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return mode;
}
