import type { EventPayload } from "@alfred/contracts/events";
import { useEffect, useMemo, useRef, useState } from "react";
import { openEventStream, type EventStreamFrame } from "~/lib/events/stream";

/**
 * The live body of a `document` artifact as the boss authors it, assembled from
 * the `artifact.delta` SSE stream (see `chat-turn.ts`). This lets the sidebar
 * fill token-by-token during authoring instead of the body popping in whole
 * when the tool executes. Keyed by `toolCallId` because `create_artifact` has
 * no durable artifact id until it runs; the id is bound later via the tool's
 * `chat.tool` succeeded event.
 */
export interface LiveArtifactStream {
  toolCallId: string;
  runId: string;
  /**
   * `replace` (create/update): `text` is the whole body.
   * `append` (append_artifact_section): `text` is a new section rendered after
   * the existing synced content.
   */
  mode: "replace" | "append";
  /** Document title once known (create/update carry it in args). */
  title: string | null;
  /**
   * The durable row id. Present from the first delta for update/append (the id
   * rides in the tool args); bound for create only once its `chat.tool`
   * succeeded event lands.
   */
  artifactId: string | null;
  /** The composed body streamed so far. */
  text: string;
  /** Highest applied server seq — guards against SSE replay duplicates. */
  seq: number;
  /** The authoring tool finished (executed or failed). */
  done: boolean;
}

export interface ArtifactStreamState {
  /** The live stream for a specific authoring tool call, or null. */
  byToolCallId: (toolCallId: string) => LiveArtifactStream | null;
  /** The live stream that has adopted a durable row id, or null. */
  byArtifactId: (artifactId: string) => LiveArtifactStream | null;
  /**
   * The newest in-flight `create_artifact` stream for `runId` that has no
   * durable row yet — the panel auto-opens this to fill the "dead wait" before
   * the row syncs. Returns null once every create in the run has resolved.
   */
  latestPendingForRun: (runId: string) => LiveArtifactStream | null;
}

/**
 * Apply an `artifact.delta` frame to the streams map. Returns whether the map
 * changed, so the caller can skip a re-render on an ignored (stale/replayed)
 * frame. Pure so the reducer is unit-testable without rendering the hook.
 */
export function applyArtifactDelta(
  streams: Map<string, LiveArtifactStream>,
  p: EventPayload<"artifact.delta">,
): boolean {
  const existing = streams.get(p.toolCallId);
  // A completed stream ignores late frames (post-execute replay).
  if (existing?.done) return false;
  // Replay/out-of-order guard: only apply strictly newer seqs.
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

/**
 * Apply a `chat.tool` frame to the streams map: when the authoring tool call
 * resolves, bind its durable row id (create) and freeze the stream so the
 * sidebar reconciles to the synced row. Returns whether the map changed.
 */
export function applyArtifactToolResolution(
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

/** The live stream for a specific authoring tool call, or null. */
export function selectByToolCallId(
  streams: Map<string, LiveArtifactStream>,
  toolCallId: string,
): LiveArtifactStream | null {
  return streams.get(toolCallId) ?? null;
}

/**
 * The live stream that has adopted `artifactId`. A multi-section `document`
 * produces one stream per authoring call (create + each append_artifact_section),
 * all sharing this durable id. Prefer the currently-authoring stream so the live
 * section fills; among done streams the last (insertion order = authoring order)
 * wins so the view reconciles to the most recent section, not the stale create.
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

/**
 * The newest in-flight `create_artifact` stream for `runId` with no durable row
 * yet. Insertion order is authoring order, so the last match is newest.
 */
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
 * Subscribes to the shared SSE bus and assembles per-`toolCallId` live artifact
 * bodies for `threadId`. Deltas are throttled server-side (~5/sec), so we keep
 * the streams in a ref and bump a version counter on change rather than easing
 * per-frame like `useChatStream` — the markdown renderer handles the cadence.
 *
 * Ephemeral: each stream is superseded by the durable synced `artifacts` row
 * once authoring completes (the sidebar reconciles to it). Streams are dropped
 * when the thread changes.
 */
export function useArtifactStream(threadId: string | undefined): ArtifactStreamState {
  const streamsRef = useRef<Map<string, LiveArtifactStream>>(new Map());
  const [version, setVersion] = useState(0);

  useEffect(() => {
    streamsRef.current = new Map();
    setVersion((v) => v + 1);
    if (!threadId) return;

    const onFrame = (frame: EventStreamFrame) => {
      if (frame.kind === "artifact.delta") {
        const p = frame.payload as EventPayload<"artifact.delta">;
        if (p.threadId !== threadId) return;
        if (applyArtifactDelta(streamsRef.current, p)) setVersion((v) => v + 1);
      } else if (frame.kind === "chat.tool") {
        const p = frame.payload as EventPayload<"chat.tool">;
        if (p.threadId !== threadId) return;
        if (applyArtifactToolResolution(streamsRef.current, p)) setVersion((v) => v + 1);
      }
    };

    const close = openEventStream({ onFrame });
    return close;
  }, [threadId]);

  return useMemo<ArtifactStreamState>(() => {
    // `version` participates in the deps so accessors read the latest ref state
    // and consumers recompute their derived live stream when a delta lands.
    void version;
    return {
      byToolCallId: (toolCallId) => selectByToolCallId(streamsRef.current, toolCallId),
      byArtifactId: (artifactId) => selectByArtifactId(streamsRef.current, artifactId),
      latestPendingForRun: (runId) => selectLatestPendingForRun(streamsRef.current, runId),
    };
  }, [version]);
}
