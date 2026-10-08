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
  // SAFETY: the branch above set current to a Float32Array.
  const initializedLevelsRef = levelsRef as React.RefObject<Float32Array>;

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef<number>(0);

  const teardown = () => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    if (timerRef.current != null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    analyserRef.current?.disconnect();
    analyserRef.current = null;
    void ctxRef.current?.close();
    ctxRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
    levelsRef.current = new Float32Array(SAMPLE_COUNT);
    setRecording(false);
    setElapsed(0);
  };

  /** Stop and discard (X button, unmount). */
  const cancel = () => {
    const recorder = recorderRef.current;

    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = null;
      recorder.stop();
    }

    teardown();
  };

  /** Resolve with the audio, or null if nothing was captured. The last chunk only arrives at `onstop`. */
  const finish = (): Promise<Blob | null> => {
    const recorder = recorderRef.current;

    if (!recorder || recorder.state === "inactive") {
      teardown();

      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      recorder.onstop = () => {
        const type = recorder.mimeType || "audio/webm";
        const chunks = chunksRef.current;
        const blob = chunks.length > 0 ? new Blob(chunks, { type }) : null;
        teardown();
        resolve(blob);
      };

      recorder.stop();
    });
  };

  const start = async () => {
    setError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // No-ops where unsupported.
        audio: { echoCancellation: true, noiseSuppression: true },
      });

      streamRef.current = stream;

      // Prefer opus-in-webm. Safari picks mp4/AAC when given no mimeType.
      chunksRef.current = [];

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : undefined;

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };

      recorderRef.current = recorder;
      recorder.start();
      const AudioCtor: typeof AudioContext = window.AudioContext;
      const ctx = new AudioCtor();
      ctxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.65;
      src.connect(analyser);
      analyserRef.current = analyser;

      const raw = new Float32Array(analyser.fftSize);

      const tick = () => {
        const a = analyserRef.current;

        if (!a) return;
        a.getFloatTimeDomainData(raw);
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

        levelsRef.current = next;
        rafRef.current = requestAnimationFrame(tick);
      };

      rafRef.current = requestAnimationFrame(tick);

      startedAtRef.current = performance.now();
      timerRef.current = setInterval(() => {
        setElapsed(Math.floor((performance.now() - startedAtRef.current) / 1000));
      }, 250);

      setRecording(true);
    } catch (err) {
      cancel();

      const message =
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "Microphone access denied"
          : "Could not start the microphone";

      setError(message);
    }
  };

  useEffect(() => {
    return () => cancel();
    // Cleanup on unmount only; `cancel` reads refs.
  }, []);

  return { recording, error, elapsed, start, cancel, finish, levelsRef: initializedLevelsRef };
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

  if (points.length === 0) return "";
  const first = points[0]!;
  let d = `M ${first.x} ${first.y}`;

  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    const prev = points[i - 1]!;
    const cx = (prev.x + p.x) / 2;
    const cy = (prev.y + p.y) / 2;
    d += ` Q ${prev.x} ${prev.y} ${cx} ${cy}`;
  }

  const last = points[points.length - 1]!;
  d += ` T ${last.x} ${last.y}`;

  return d;
}
