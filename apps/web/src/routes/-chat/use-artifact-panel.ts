import type { SyncedArtifact } from "@alfred/sync";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ArtifactStreamState } from "~/lib/chat/use-artifact-stream";
import { useThreadArtifacts } from "~/lib/replicache/use-artifacts";
import { getLocalStorageItem, setLocalStorageItem } from "~/lib/storage/storage";

/** A streaming create has no row id yet, so it opens as `pending:<toolCallId>` until the id binds. */
const PENDING_PREFIX = "pending:";

function pendingSelectionId(toolCallId: string): string {
  return `${PENDING_PREFIX}${toolCallId}`;
}

export function pendingToolCallId(selectedId: string | null): string | null {
  return selectedId?.startsWith(PENDING_PREFIX) ? selectedId.slice(PENDING_PREFIX.length) : null;
}

/**
 * Sidebar view state (ADR-0075 Phase 3): the open artifact and the inline width.
 * The selection is per thread, so switching threads closes the panel. Width is global, in `localStorage`.
 */

const WIDTH_KEY = "alfred:artifact-panel-width";

const ARTIFACT_PANEL_MIN_WIDTH = 360;

const ARTIFACT_PANEL_MAX_WIDTH = 760;

const ARTIFACT_PANEL_DEFAULT_WIDTH = 460;

export interface ArtifactPanelState {
  /** This thread's artifacts, newest first. */
  artifacts: SyncedArtifact[];
  selectedId: string | null;
  /** The open artifact's synced row. Null for a `pending:` selection or before the row syncs.
   * Keeps its identity while id and `rowVersion` match, so the sidebar node stays stable.
   * The held object can carry a stale `runId` or `messageId`: an FK set-null does not bump
   * `rowVersion`. The sidebar renders neither. */
  selectedArtifact: SyncedArtifact | null;
  isOpen: boolean;
  /** Inline width in px, clamped. */
  width: number;
  open: (artifactId: string) => void;
  /** Close the panel; the Today rail returns. */
  close: () => void;
  /** Clamp and save to localStorage. */
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
  return clampWidth(getLocalStorageItem(WIDTH_KEY, ARTIFACT_PANEL_DEFAULT_WIDTH));
}

export function useArtifactPanel(
  threadId: string | undefined,
  activeRunId: string | undefined,
  artifactStream: ArtifactStreamState,
): ArtifactPanelState {
  const [selection, setSelection] = useState<SelectionState>(() => ({
    threadId,
    selectedId: null,
  }));

  const [width, setWidthState] = useState<number>(readStoredWidth);
  // Keys already auto-opened per thread, so a closed artifact stays closed. Real ids and `pending:` keys.
  const autoOpenedByThreadRef = useRef<Map<string | undefined, Set<string>>>(new Map());

  const markAutoOpened = useCallback(
    (key: string) => {
      const set = autoOpenedByThreadRef.current.get(threadId) ?? new Set<string>();
      set.add(key);
      autoOpenedByThreadRef.current.set(threadId, set);
    },
    [threadId],
  );

  if (selection.threadId !== threadId) {
    setSelection({ threadId, selectedId: null });
  }

  const storedSelectedId = selection.threadId === threadId ? selection.selectedId : null;

  // Open a create as soon as it streams, before its row exists. Once per tool call, so a close sticks.
  const pending = activeRunId ? artifactStream.latestPendingForRun(activeRunId) : null;
  const pendingKey = pending ? pendingSelectionId(pending.toolCallId) : null;
  useEffect(() => {
    if (!pending || !pendingKey) return;
    const autoOpened = autoOpenedByThreadRef.current.get(threadId);

    if (autoOpened?.has(pendingKey)) return;
    markAutoOpened(pendingKey);
    setSelection({ threadId, selectedId: pendingKey });
  }, [pending, pendingKey, threadId, markAutoOpened]);

  // A pending selection reads as its real id once the stream binds one, so the panel follows the synced row.
  const selectedPendingTcid = pendingToolCallId(storedSelectedId);

  const resolvedId = selectedPendingTcid
    ? (artifactStream.byToolCallId(selectedPendingTcid)?.artifactId ?? null)
    : null;

  const selectedId = resolvedId ?? storedSelectedId;

  // The real id counts as auto-opened, so the synced-row auto-open below does not reopen it after a close.
  useEffect(() => {
    if (resolvedId) markAutoOpened(resolvedId);
  }, [resolvedId, markAutoOpened]);

  // Auto-open the live run's newest artifact (ADR-0075 Phase 4), from the synced row, which has the id and `runId`.
  // Gated on `activeRunId`, so a reloaded finished thread stays closed. Once per id.
  const threadArtifacts = useThreadArtifacts(threadId);
  useEffect(() => {
    if (!activeRunId) return;
    // Newest first.
    const fresh = threadArtifacts.find((a) => a.runId === activeRunId);

    if (!fresh) return;
    const autoOpened = autoOpenedByThreadRef.current.get(threadId) ?? new Set<string>();

    if (autoOpened.has(fresh.id)) return;
    // Do not reopen a create already shown, and maybe closed, as a pending stream.
    const live = artifactStream.byArtifactId(fresh.id);

    if (live && autoOpened.has(pendingSelectionId(live.toolCallId))) return;
    autoOpened.add(fresh.id);
    autoOpenedByThreadRef.current.set(threadId, autoOpened);
    setSelection({ threadId, selectedId: fresh.id });
  }, [activeRunId, threadArtifacts, threadId, artifactStream]);

  const foundArtifact = useMemo(
    () => (selectedId ? (threadArtifacts.find((a) => a.id === selectedId) ?? null) : null),
    [selectedId, threadArtifacts],
  );

  // `threadArtifacts` holds new row objects on every `artifact.scan` fire, while the old
  // single-row `get` only produced a new object when the open row itself changed. Keep the
  // previous object while id and `rowVersion` match, so the sidebar node stays stable when
  // other rows sync. Adjusted during render, not in an effect.
  const [prevSelected, setPrevSelected] = useState<SyncedArtifact | null>(null);

  const sameRow =
    (prevSelected?.id ?? null) === (foundArtifact?.id ?? null) &&
    (prevSelected?.rowVersion ?? null) === (foundArtifact?.rowVersion ?? null);

  if (!sameRow) setPrevSelected(foundArtifact);

  const selectedArtifact = sameRow ? prevSelected : foundArtifact;

  const open = useCallback(
    (artifactId: string) => setSelection({ threadId, selectedId: artifactId }),
    [threadId],
  );

  const close = useCallback(() => setSelection({ threadId, selectedId: null }), [threadId]);

  const setWidth = useCallback((next: number) => {
    const clamped = clampWidth(next);
    setWidthState(clamped);
    setLocalStorageItem(WIDTH_KEY, clamped);
  }, []);

  return {
    artifacts: threadArtifacts,
    selectedId,
    selectedArtifact,
    isOpen: selectedId !== null,
    width,
    open,
    close,
    setWidth,
  };
}
