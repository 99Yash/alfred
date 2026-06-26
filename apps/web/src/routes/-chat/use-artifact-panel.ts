import { useCallback, useEffect, useState } from "react";

/**
 * Local UI state for the chat's artifact sidebar (ADR-0075 Phase 3). The
 * artifact *content* is the synced `artifacts` row (see `useArtifact`); this
 * hook only holds the ephemeral view state the server has no opinion on:
 *   - which artifact is open (`selectedId`),
 *   - how wide the inline panel is (`width`, persisted across reloads).
 *
 * `selectedId` is scoped to the current thread — switching threads closes the
 * panel rather than leaking a stale artifact id from another conversation.
 * Width is global (one user preference, not per-thread) and survives reload
 * via `localStorage`.
 */

const WIDTH_KEY = "alfred:artifact-panel-width";
export const ARTIFACT_PANEL_MIN_WIDTH = 360;
export const ARTIFACT_PANEL_MAX_WIDTH = 760;
const ARTIFACT_PANEL_DEFAULT_WIDTH = 460;

export interface ArtifactPanelState {
  /** The open artifact's id, or null when the panel is closed. */
  selectedId: string | null;
  /** True while an artifact is open (drives the right-rail slot swap). */
  isOpen: boolean;
  /** Inline-mode panel width in px (clamped to the min/max bounds). */
  width: number;
  /** Open the panel to a specific artifact (or refocus it on a new one). */
  open: (artifactId: string) => void;
  /** Close the panel; restores the Today rail in the shared right slot. */
  close: () => void;
  /** Persist a new inline width (clamped + written to localStorage). */
  setWidth: (width: number) => void;
}

function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return ARTIFACT_PANEL_DEFAULT_WIDTH;
  return Math.min(ARTIFACT_PANEL_MAX_WIDTH, Math.max(ARTIFACT_PANEL_MIN_WIDTH, Math.round(width)));
}

function readStoredWidth(): number {
  if (typeof window === "undefined") return ARTIFACT_PANEL_DEFAULT_WIDTH;
  const raw = window.localStorage.getItem(WIDTH_KEY);
  if (raw === null) return ARTIFACT_PANEL_DEFAULT_WIDTH;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? ARTIFACT_PANEL_DEFAULT_WIDTH : clampWidth(parsed);
}

export function useArtifactPanel(threadId: string | undefined): ArtifactPanelState {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [width, setWidthState] = useState<number>(readStoredWidth);

  // Switching threads closes the panel — a selected id from another thread's
  // artifact would render nothing (the row scopes to its own thread) or, worse,
  // leak across conversations. Keyed on threadId so it fires once per switch.
  useEffect(() => {
    setSelectedId(null);
  }, [threadId]);

  const open = useCallback((artifactId: string) => setSelectedId(artifactId), []);
  const close = useCallback(() => setSelectedId(null), []);

  const setWidth = useCallback((next: number) => {
    const clamped = clampWidth(next);
    setWidthState(clamped);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(WIDTH_KEY, String(clamped));
    }
  }, []);

  return {
    selectedId,
    isOpen: selectedId !== null,
    width,
    open,
    close,
    setWidth,
  };
}
