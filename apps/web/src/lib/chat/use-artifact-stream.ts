import type { EventPayload } from "@alfred/contracts/events";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { authClient } from "~/lib/auth/auth-client";
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
  /** The newest body the run still writes, of any mode. The chat labels the live step with it. */
  writingForRun: (runId: string) => LiveArtifactStream | null;
}

const NO_STREAMS: ReadonlyMap<string, LiveArtifactStream> = new Map();

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
  streams: ReadonlyMap<string, LiveArtifactStream>,
  toolCallId: string,
): LiveArtifactStream | null {
  return streams.get(toolCallId) ?? null;
}

/**
 * A document gets one stream per authoring call, all with the same id.
 * Prefer the one still authoring, else the last one.
 */
export function selectByArtifactId(
  streams: ReadonlyMap<string, LiveArtifactStream>,
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
  streams: ReadonlyMap<string, LiveArtifactStream>,
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

/** Like {@link selectLatestPendingForRun}, but an update or append counts too. */
function selectWritingForRun(
  streams: ReadonlyMap<string, LiveArtifactStream>,
  runId: string,
): LiveArtifactStream | null {
  let latest: LiveArtifactStream | null = null;

  for (const stream of streams.values()) {
    if (stream.runId === runId && !stream.done) latest = stream;
  }

  return latest;
}

/**
 * One thread's live artifact bodies. It outlives the thread page: the shared event bus does
 * not send a frame again to a later subscriber, so a page that built its own map on mount
 * showed a blank body when the user came back mid-run.
 */
interface ThreadArtifacts {
  streams: Map<string, LiveArtifactStream>;
  /** From one module clock, so a re-created entry never repeats an old snapshot. */
  version: number;
  listeners: Set<() => void>;
}

const threads = new Map<string, ThreadArtifacts>();

let clock = 0;

function threadArtifacts(threadId: string): ThreadArtifacts {
  const existing = threads.get(threadId);

  if (existing) return existing;

  const created: ThreadArtifacts = { streams: new Map(), version: ++clock, listeners: new Set() };
  threads.set(threadId, created);

  return created;
}

function publish(entry: ThreadArtifacts): void {
  entry.version = ++clock;

  for (const listener of entry.listeners) listener();
}

/** Drop a thread nobody watches once every body is done. The synced rows replace them. */
function releaseIfSettled(threadId: string, entry: ThreadArtifacts): void {
  if (entry.listeners.size > 0 || threads.get(threadId) !== entry) return;

  for (const stream of entry.streams.values()) {
    if (!stream.done) return;
  }

  threads.delete(threadId);
}

function onFrame(frame: EventStreamFrame): void {
  if (frame.kind !== "artifact.delta" && frame.kind !== "chat.tool") return;
  const named = frameThreadId(frame);
  let targets: [string, ThreadArtifacts][];

  if (named === null) {
    targets = [...threads];
  } else {
    // Only a delta starts a body. A tool frame only resolves one that is already there.
    const entry = frame.kind === "artifact.delta" ? threadArtifacts(named) : threads.get(named);
    targets = entry ? [[named, entry]] : [];
  }

  for (const [threadId, entry] of targets) {
    if (applyArtifactFrame(entry.streams, frame, threadId)) publish(entry);
    releaseIfSettled(threadId, entry);
  }
}

/** Freeze live bodies so the sidebar does not spin forever. The synced rows follow. */
function onBusError(): void {
  for (const [threadId, entry] of threads) {
    let changed = false;

    for (const [id, stream] of entry.streams) {
      if (!stream.done) {
        entry.streams.set(id, { ...stream, done: true });
        changed = true;
      }
    }

    if (changed) publish(entry);
    releaseIfSettled(threadId, entry);
  }
}

/**
 * Keep every thread's live artifact bodies current while the app runs. Mount once, in the
 * app shell, so a body keeps its frames while the user is on another page.
 */
export function useArtifactStreamStore(): void {
  const { data: session } = authClient.useSession();
  const userId = session?.user.id;

  useEffect(() => {
    if (!userId) return;
    const close = openEventStream({ onFrame, onError: onBusError });

    return () => {
      close();

      // Another user's bodies must not show after a sign-in change.
      for (const [threadId, entry] of threads) {
        if (entry.listeners.size === 0) {
          threads.delete(threadId);
          continue;
        }

        entry.streams.clear();
        publish(entry);
      }
    };
  }, [userId]);
}

function subscribeThread(threadId: string, listener: () => void): () => void {
  const entry = threadArtifacts(threadId);
  entry.listeners.add(listener);

  return () => {
    entry.listeners.delete(listener);
    // StrictMode subscribes again in the same commit, so wait one microtask before a release.
    queueMicrotask(() => releaseIfSettled(threadId, entry));
  };
}

/**
 * Live artifact bodies for `threadId`, until the synced row replaces them.
 * `useArtifactStreamStore` feeds the frames, about 5 deltas a second. The entry version
 * re-renders; the sidebar eases the body between deltas.
 */
export function useArtifactStream(threadId: string | undefined): ArtifactStreamState {
  const subscribe = useCallback(
    (listener: () => void) => (threadId ? subscribeThread(threadId, listener) : () => {}),
    [threadId],
  );

  const getSnapshot = useCallback(
    () => (threadId ? (threads.get(threadId)?.version ?? 0) : 0),
    [threadId],
  );

  const version = useSyncExternalStore(subscribe, getSnapshot, () => 0);

  return useMemo<ArtifactStreamState>(() => {
    // New accessors per `version` and thread, so consumers recompute when a delta lands.
    void version;

    const current = (): ReadonlyMap<string, LiveArtifactStream> =>
      (threadId ? threads.get(threadId)?.streams : undefined) ?? NO_STREAMS;

    return {
      byToolCallId: (toolCallId) => selectByToolCallId(current(), toolCallId),
      byArtifactId: (artifactId) => selectByArtifactId(current(), artifactId),
      latestPendingForRun: (runId) => selectLatestPendingForRun(current(), runId),
      writingForRun: (runId) => selectWritingForRun(current(), runId),
    };
  }, [version, threadId]);
}
