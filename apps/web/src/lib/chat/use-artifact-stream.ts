import type { EventPayload } from "@alfred/contracts/events";
import { useEffect, useMemo, useRef, useState } from "react";
import { frameThreadId, type EventStreamFrame } from "~/lib/events/frame";
import { openEventStream } from "~/lib/events/stream";

/**
 * A `document` artifact body as the boss writes it, from `artifact.delta` frames.
 * Keyed by `toolCallId`: `create_artifact` has no artifact id until the tool succeeds.
 */
export interface LiveArtifactStream {
  toolCallId: string;
  runId: string;
  /** `replace`: `text` is the whole body. `append`: `text` is a new section after the synced body. */
  mode: "replace" | "append";
  title: string | null;
  /** Known from the first delta for update and append; for create, only after the tool succeeds. */
  artifactId: string | null;
  text: string;
  /** Highest applied seq; drops replay duplicates. */
  seq: number;
  /** The tool succeeded or failed. */
  done: boolean;
}

export interface ArtifactStreamState {
  byToolCallId: (toolCallId: string) => LiveArtifactStream | null;
  byArtifactId: (artifactId: string) => LiveArtifactStream | null;
  /** The newest unresolved create in the run. The panel opens it before the row syncs. */
  latestPendingForRun: (runId: string) => LiveArtifactStream | null;
}

/** Returns whether the map changed. */
function applyArtifactDelta(
  streams: Map<string, LiveArtifactStream>,
  p: EventPayload<"artifact.delta">,
): boolean {
  const existing = streams.get(p.toolCallId);

  if (existing?.done) return false;

  // Drop replayed and out-of-order frames.
  if (existing && p.seq <= existing.seq) return false;

  const next: LiveArtifactStream = existing
    ? {
        ...existing,
        seq: p.seq,
        text: existing.text + p.text,
        title: p.title ?? existing.title,
        artifactId: p.artifactId ?? existing.artifactId,
        mode: p.mode,
      }
    : {
        toolCallId: p.toolCallId,
        runId: p.runId,
        mode: p.mode,
        title: p.title ?? null,
        artifactId: p.artifactId ?? null,
        text: p.text,
        seq: p.seq,
        done: false,
      };

  streams.set(p.toolCallId, next);

  return true;
}

/** When the authoring tool resolves, bind the row id and freeze the stream. */
function applyArtifactToolResolution(
  streams: Map<string, LiveArtifactStream>,
  p: EventPayload<"chat.tool">,
): boolean {
  const existing = streams.get(p.toolCallId);

  if (!existing) return false;

  if (p.status !== "succeeded" && p.status !== "failed") return false;
  streams.set(p.toolCallId, {
    ...existing,
    artifactId: p.artifactId ?? existing.artifactId,
    done: true,
  });

  return true;
}

/**
 * Apply one SSE frame. Returns whether the map changed.
 * The thread check runs first because every subscriber gets every frame.
 * A replayed terminal `chat.tool` still returns `true`: one extra render, same map.
 */
export function applyArtifactFrame(
  streams: Map<string, LiveArtifactStream>,
  frame: EventStreamFrame,
  threadId: string,
): boolean {
  const named = frameThreadId(frame);

  if (named !== null && named !== threadId) return false;

  if (frame.kind === "artifact.delta") return applyArtifactDelta(streams, frame.payload);

  if (frame.kind === "chat.tool") return applyArtifactToolResolution(streams, frame.payload);

  return false;
}

export function selectByToolCallId(
  streams: Map<string, LiveArtifactStream>,
  toolCallId: string,
): LiveArtifactStream | null {
  return streams.get(toolCallId) ?? null;
}

/**
 * A document gets one stream per authoring call, all with the same id.
 * Prefer the one still authoring, else the last one.
 */
export function selectByArtifactId(
  streams: Map<string, LiveArtifactStream>,
  artifactId: string,
): LiveArtifactStream | null {
  let active: LiveArtifactStream | null = null;
  let latest: LiveArtifactStream | null = null;

  for (const stream of streams.values()) {
    if (stream.artifactId !== artifactId) continue;
    latest = stream;

    if (!stream.done) active = stream;
  }

  return active ?? latest;
}

/** Map insertion order is authoring order, so the last match is newest. */
export function selectLatestPendingForRun(
  streams: Map<string, LiveArtifactStream>,
  runId: string,
): LiveArtifactStream | null {
  let latest: LiveArtifactStream | null = null;

  for (const stream of streams.values()) {
    if (stream.runId !== runId) continue;

    if (stream.artifactId !== null) continue;

    if (stream.done) continue;
    latest = stream;
  }

  return latest;
}

/**
 * Live artifact bodies for `threadId`, until the synced row replaces them.
 * The server sends about 5 deltas a second, so no easing; a version counter re-renders.
 */
export function useArtifactStream(threadId: string | undefined): ArtifactStreamState {
  const streamsRef = useRef<Map<string, LiveArtifactStream>>(new Map());
  const [version, setVersion] = useState(0);

  useEffect(() => {
    streamsRef.current = new Map();
    setVersion((v) => v + 1);

    if (!threadId) return;

    const onFrame = (frame: EventStreamFrame) => {
      if (applyArtifactFrame(streamsRef.current, frame, threadId)) setVersion((v) => v + 1);
    };

    const onError = () => {
      // Freeze live streams so the sidebar does not spin forever. The synced row follows.
      let changed = false;

      for (const [id, stream] of streamsRef.current) {
        if (!stream.done) {
          streamsRef.current.set(id, { ...stream, done: true });
          changed = true;
        }
      }

      if (changed) setVersion((v) => v + 1);
    };

    const close = openEventStream({ onFrame, onError });

    return close;
  }, [threadId]);

  return useMemo<ArtifactStreamState>(() => {
    // New accessors per `version`, so consumers recompute when a delta lands.
    void version;

    return {
      byToolCallId: (toolCallId) => selectByToolCallId(streamsRef.current, toolCallId),
      byArtifactId: (artifactId) => selectByArtifactId(streamsRef.current, artifactId),
      latestPendingForRun: (runId) => selectLatestPendingForRun(streamsRef.current, runId),
    };
  }, [version]);
}
