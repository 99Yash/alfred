import { useCallback, useEffect, useRef, useState } from "react";

import { useThreadArtifacts } from "~/lib/replicache/use-artifacts";

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

interface SelectionState {
  threadId: string | undefined;
  selectedId: string | null;
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

export function useArtifactPanel(
  threadId: string | undefined,
  activeRunId: string | undefined,
): ArtifactPanelState {
  const [selection, setSelection] = useState<SelectionState>(() => ({
    threadId,
    selectedId: null,
  }));
  const [width, setWidthState] = useState<number>(readStoredWidth);
  // Artifact ids we've already auto-opened per thread, so closing one doesn't
  // make the next generation poke re-open it.
  const autoOpenedByThreadRef = useRef<Map<string | undefined, Set<string>>>(new Map());

  if (selection.threadId !== threadId) {
    setSelection({ threadId, selectedId: null });
  }
  const selectedId = selection.threadId === threadId ? selection.selectedId : null;

  // Auto-open the sidebar when the boss authors an artifact in the live run
  // (ADR-0075 Phase 4). We own this here — rather than letting the shell push
  // freshly-synced ids into us via an effect — so the panel's state stays
  // self-contained. We bind to the synced row (which carries the real id and
  // `runId`) rather than the `chat.tool` event, which only has a title. Gating
  // on `activeRunId` means reloading a finished thread never springs the panel
  // open; the ref makes auto-open fire once per id, so a manual close sticks.
  const threadArtifacts = useThreadArtifacts(threadId);
  useEffect(() => {
    if (!activeRunId) return;
    // `threadArtifacts` is newest-first, so this opens the most recent artifact
    // the live run has produced so far.
    const fresh = threadArtifacts.find((a) => a.runId === activeRunId);
    if (!fresh) return;
    const autoOpened = autoOpenedByThreadRef.current.get(threadId) ?? new Set<string>();
    if (autoOpened.has(fresh.id)) return;
    autoOpened.add(fresh.id);
    autoOpenedByThreadRef.current.set(threadId, autoOpened);
    setSelection({ threadId, selectedId: fresh.id });
  }, [activeRunId, threadArtifacts, threadId]);

  const open = useCallback(
    (artifactId: string) => setSelection({ threadId, selectedId: artifactId }),
    [threadId],
  );
  const close = useCallback(() => setSelection({ threadId, selectedId: null }), [threadId]);

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
