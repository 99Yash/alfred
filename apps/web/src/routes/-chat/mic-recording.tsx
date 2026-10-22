import { useEffect, useRef, useState } from "react";
import { cn } from "~/lib/utils";

/**
 * Record mic audio for transcription and feed a waveform.
 * `finish()` returns the `Blob`; `cancel()` discards it.
 * Levels live in a ref, so the waveform repaints on its own RAF without React renders.
 */
export function useMicRecording() {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  // Shared with the waveform renderer.
  const levelsRef = useRef<Float32Array | null>(null);

  if (levelsRef.current === null) levelsRef.current = new Float32Array(SAMPLE_COUNT);

  // The current recording attempt. A session that is no longer here writes no state.
  const sessionRef = useRef<MicSession | null>(null);

  const reset = () => {
    levelsRef.current = new Float32Array(SAMPLE_COUNT);
    setRecording(false);
    setElapsed(0);
  };

  /** Stop and discard (X button). */
  const cancel = () => {
    sessionRef.current?.discard();
    sessionRef.current = null;
    reset();
  };

  /** Resolve with the audio, or null if nothing was captured, the take was discarded first, or an earlier call already took it. */
  const finish = async (): Promise<Blob | null> => {
    const session = sessionRef.current;

    if (!session) return null;
    const blob = await session.finish();

    // One take has one consumer: a second click shares the session promise but finds the session already taken.
    if (sessionRef.current !== session) return null;
    sessionRef.current = null;
    reset();

    return blob;
  };

  /** Open a new session. The latest click wins: a session still waiting for permission is discarded. */
  const start = async () => {
    sessionRef.current?.discard();
    const session = openMicSession({ levels: levelsRef, onElapsed: setElapsed });
    sessionRef.current = session;
    setError(null);

    try {
      const live = await session.ready;

      if (live && sessionRef.current === session) setRecording(true);
    } catch (err) {
      if (sessionRef.current !== session) return;
      sessionRef.current = null;
      reset();

      const message =
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "Microphone access denied"
          : "Could not start the microphone";

      setError(message);
    }
  };

  useEffect(() => {
    return () => {
      sessionRef.current?.discard();
      sessionRef.current = null;
    };
  }, []);

  return { recording, error, elapsed, start, cancel, finish, levelsRef };
}

/** One recording attempt. It owns the stream, recorder, audio graph, RAF and timer it opens. */
interface MicSession {
  /** `true` once the recorder runs, `false` if `discard()` ran before the grant. Rejects on a permission or device error, after it releases what it opened. */
  readonly ready: Promise<boolean>;
  /** Stop and resolve the take, or `null` if empty, not started, or discarded first. A second call returns the same promise. */
  finish(): Promise<Blob | null>;
  /** Release everything now and drop the audio. A pending `finish()` resolves `null`; a later grant stops its tracks at once. */
  discard(): void;
}

function openMicSession(sink: {
  levels: React.RefObject<Float32Array | null>;
  onElapsed: (seconds: number) => void;
}): MicSession {
  let disposed = false;
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let ctx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let raf: number | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const chunks: Blob[] = [];
  let finished: Promise<Blob | null> | null = null;
  let settle: ((blob: Blob | null) => void) | null = null;

  // The single release path. Every async continuation below checks `disposed` first.
  const release = () => {
    disposed = true;

    if (raf != null) cancelAnimationFrame(raf);
    raf = null;

    if (timer != null) clearInterval(timer);
    timer = null;

    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;

      if (recorder.state !== "inactive") recorder.stop();
    }

    recorder = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    analyser?.disconnect();
    analyser = null;
    void ctx?.close();
    ctx = null;
  };

  // A named function, not an IIFE: TypeScript inlines an IIFE into this flow and so narrows `disposed` to `false`.
  const acquire = async (): Promise<boolean> => {
    try {
      const granted = await navigator.mediaDevices.getUserMedia({
        // No-ops where unsupported.
        audio: { echoCancellation: true, noiseSuppression: true },
      });

      if (disposed) {
        granted.getTracks().forEach((t) => t.stop());

        return false;
      }

      stream = granted;

      // Prefer opus-in-webm. Safari picks mp4/AAC when given no mimeType.
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : undefined;

      const rec = new MediaRecorder(granted, mimeType ? { mimeType } : undefined);
      rec.ondataavailable = (event) => {
        if (!disposed && event.data.size > 0) chunks.push(event.data);
      };

      recorder = rec;
      rec.start();
      const AudioCtor: typeof AudioContext = window.AudioContext;
      ctx = new AudioCtor();
      const src = ctx.createMediaStreamSource(granted);
      const node = ctx.createAnalyser();
      node.fftSize = 1024;
      node.smoothingTimeConstant = 0.65;
      src.connect(node);
      analyser = node;

      const raw = new Float32Array(node.fftSize);

      const tick = () => {
        if (disposed) return;
        node.getFloatTimeDomainData(raw);
        // RMS per bucket gives a smooth envelope and keeps relative loudness.
        const bucketSize = Math.floor(raw.length / SAMPLE_COUNT);
        const next = new Float32Array(SAMPLE_COUNT);

        for (let i = 0; i < SAMPLE_COUNT; i++) {
          let sum = 0;

          for (let j = 0; j < bucketSize; j++) {
            const v = raw[i * bucketSize + j] ?? 0;
            sum += v * v;
          }

          next[i] = Math.sqrt(sum / bucketSize);
        }

        sink.levels.current = next;
        raf = requestAnimationFrame(tick);
      };

      raf = requestAnimationFrame(tick);

      const startedAt = performance.now();
      timer = setInterval(() => {
        if (!disposed) sink.onElapsed(Math.floor((performance.now() - startedAt) / 1000));
      }, 250);

      return true;
    } catch (err) {
      release();
      throw err;
    }
  };

  const ready = acquire();

  const finish = (): Promise<Blob | null> => {
    finished ??= new Promise((resolve) => {
      const rec = recorder;

      if (disposed || !rec || rec.state === "inactive") {
        release();
        resolve(null);

        return;
      }

      settle = resolve;
      // The last chunk only arrives before `onstop`, as no timeslice was given.
      rec.onstop = () => {
        const blob =
          chunks.length > 0 ? new Blob(chunks, { type: rec.mimeType || "audio/webm" }) : null;

        release();
        settle = null;
        resolve(blob);
      };

      rec.stop();
    });

    return finished;
  };

  const discard = () => {
    if (disposed) return;
    release();
    settle?.(null);
    settle = null;
  };

  return { ready, finish, discard };
}

const SAMPLE_COUNT = 56;

/** Waveform line. Reads `levelsRef` on RAF, so the parent need not re-render. */
export function MicWaveform({
  levelsRef,
  active,
}: {
  levelsRef: React.RefObject<Float32Array | null>;
  active: boolean;
}) {
  const pathRef = useRef<SVGPathElement | null>(null);
  const echoRef = useRef<SVGPathElement | null>(null);

  useEffect(() => {
    if (!active) return;
    let raf = 0;

    const render = () => {
      const path = pathRef.current;
      const echo = echoRef.current;
      const levels = levelsRef.current;

      if (path && echo && levels) {
        const d = buildWavePath(levels);
        path.setAttribute("d", d);
        echo.setAttribute("d", d);
      }

      raf = requestAnimationFrame(render);
    };

    raf = requestAnimationFrame(render);

    return () => cancelAnimationFrame(raf);
  }, [active, levelsRef]);

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="none"
      aria-hidden
      className={cn("size-full text-app-purple-3")}
    >
      {/* Wider faded copy behind the line, as a soft bloom. */}
      <path
        ref={echoRef}
        d=""
        fill="none"
        stroke="currentColor"
        strokeWidth={4}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.22}
      />
      <path
        ref={pathRef}
        d=""
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const VIEW_W = 1000;

const VIEW_H = 80;

/** Smooth SVG path through the levels. Amplified and clamped, as speech rarely passes ~0.3. */
function buildWavePath(levels: Float32Array): string {
  const n = levels.length;
  const mid = VIEW_H / 2;
  const xStep = VIEW_W / (n - 1);
  const points: { x: number; y: number }[] = [];

  for (let i = 0; i < n; i++) {
    const v = (levels[i] ?? 0) * 4; // amplify; quiet rooms sit near 0
    const clamped = Math.max(-1, Math.min(1, v));
    points.push({
      x: i * xStep,
      y: mid + clamped * (VIEW_H / 2 - 4),
    });
  }

  const [first] = points;

  if (!first) return "";
  let d = `M ${first.x} ${first.y}`;
  let prev = first;

  for (const p of points.slice(1)) {
    const cx = (prev.x + p.x) / 2;
    const cy = (prev.y + p.y) / 2;
    d += ` Q ${prev.x} ${prev.y} ${cx} ${cy}`;
    prev = p;
  }

  // `prev` is the last point now.
  d += ` T ${prev.x} ${prev.y}`;

  return d;
}
