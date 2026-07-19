import type { SyncedArtifact } from "@alfred/sync";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ArtifactStreamState } from "~/lib/chat/use-artifact-stream";
import { useThreadArtifacts } from "~/lib/replicache/use-artifacts";
import { getLocalStorageItem, setLocalStorageItem } from "~/lib/storage/storage";

/**
 * A `create_artifact` in flight has no durable row id yet, so the sidebar opens
 * to its live stream keyed by `toolCallId` under this prefix. Once the tool
 * executes and the id is bound, the selection migrates to the real id.
 */
const PENDING_PREFIX = "pending:";
export function pendingSelectionId(toolCallId: string): string {
  return `${PENDING_PREFIX}${toolCallId}`;
}
export function pendingToolCallId(selectedId: string | null): string | null {
  return selectedId?.startsWith(PENDING_PREFIX) ? selectedId.slice(PENDING_PREFIX.length) : null;
}

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
  /** This thread's artifacts, newest first (drives the top-bar quick-access menu). */
  artifacts: SyncedArtifact[];
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
  // Keys we've already auto-opened per thread, so closing one doesn't make the
  // next poke re-open it. Holds both real artifact ids and `pending:<tcid>`
  // keys for creates surfaced before their row exists.
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
  const selectedId = selection.threadId === threadId ? selection.selectedId : null;

  // Auto-open a `create_artifact` the instant it begins streaming — before its
  // durable row exists — so the sidebar fills token-by-token instead of the
  // user staring at an empty conversation during the authoring "dead wait".
  // Keyed by `toolCallId` (`pending:<tcid>`); the selection migrates to the
  // real id once the tool executes (below). Fires once per tcid so a manual
  // close sticks.
  const pending = activeRunId ? artifactStream.latestPendingForRun(activeRunId) : null;
  const pendingKey = pending ? pendingSelectionId(pending.toolCallId) : null;
  useEffect(() => {
    if (!pending || !pendingKey) return;
    const autoOpened = autoOpenedByThreadRef.current.get(threadId);
    if (autoOpened?.has(pendingKey)) return;
    markAutoOpened(pendingKey);
    setSelection({ threadId, selectedId: pendingKey });
  }, [pending, pendingKey, threadId, markAutoOpened]);

  // Migrate a pending selection onto its durable row once the authoring tool
  // resolves the artifact id, so the panel reconciles to the synced content
  // (future edits, server-sanitized body) instead of freezing on the stream.
  const selectedPendingTcid = pendingToolCallId(selectedId);
  const resolvedId = selectedPendingTcid
    ? artifactStream.byToolCallId(selectedPendingTcid)?.artifactId
    : null;
  useEffect(() => {
    if (!selectedPendingTcid || !resolvedId) return;
    markAutoOpened(resolvedId);
    setSelection({ threadId, selectedId: resolvedId });
  }, [selectedPendingTcid, resolvedId, threadId, markAutoOpened]);

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
    // A create already surfaced (and maybe manually closed) as a pending stream
    // must not be re-opened here by its freshly-synced row.
    const live = artifactStream.byArtifactId(fresh.id);
    if (live && autoOpened.has(pendingSelectionId(live.toolCallId))) return;
    autoOpened.add(fresh.id);
    autoOpenedByThreadRef.current.set(threadId, autoOpened);
    setSelection({ threadId, selectedId: fresh.id });
  }, [activeRunId, threadArtifacts, threadId, artifactStream]);

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
    isOpen: selectedId !== null,
    width,
    open,
    close,
    setWidth,
  };
}
