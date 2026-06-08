import { useEffect, useRef, useState } from "react";
import { cn } from "~/lib/utils";

/**
 * `useMicRecording` — wrapper around `getUserMedia` + `MediaRecorder` +
 * `AnalyserNode` that records mic audio for transcription and drives a
 * waveform UI while doing it.
 *
 * Lifecycle:
 *   - call `start()` to request mic permission, open the audio graph, and
 *     begin capturing (webm/opus where supported, mp4 on Safari)
 *   - while active, `levelsRef.current` is updated each animation frame with
 *     normalised time-domain samples in `[-1, 1]` (Float32Array length 64)
 *   - call `finish()` to stop and get the recorded `Blob` back (for the
 *     transcribe endpoint), or `cancel()` to stop and discard the audio
 *
 * Levels live in a ref (not state) so the consuming canvas/SVG can poll on
 * its own RAF without forcing React renders 60x/sec. `elapsed` is state
 * because we DO want the on-screen timer to re-render once a second.
 */
export function useMicRecording() {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  // Live audio data — shared with the waveform renderer through this ref.
  const levelsRef = useRef<Float32Array>(new Float32Array(SAMPLE_COUNT));

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

  /** Stop and discard the audio (the X button / unmount path). */
  const cancel = () => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = null;
      recorder.stop();
    }
    teardown();
  };

  /**
   * Stop recording and resolve with the captured audio. Resolves null when
   * nothing was captured (recorder never started / no data). The recorder's
   * final chunk only arrives at `onstop`, hence the promise dance.
   */
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
        // Speech-tuned capture — same constraints dimension uses; both are
        // no-ops where unsupported.
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;

      // Capture for transcription. Prefer opus-in-webm (Chrome/Firefox);
      // Safari falls back to its default (mp4/AAC) when given no mimeType.
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
        // Downsample to SAMPLE_COUNT buckets — each bucket is the RMS of its
        // slice, which reads as a smooth envelope rather than the jittery
        // raw waveform. RMS keeps relative loudness intact.
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
    // cancel closes over refs only; we intentionally run cleanup on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { recording, error, elapsed, start, cancel, finish, levelsRef };
}

export const SAMPLE_COUNT = 56;

/**
 * Smooth waveform line driven by `levelsRef`. Reads via RAF — never via
 * React state — so the parent doesn't have to re-render to repaint.
 */
export function MicWaveform({
  levelsRef,
  active,
}: {
  levelsRef: React.RefObject<Float32Array>;
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
      className={cn("w-full h-full text-app-purple-3")}
    >
      {/* Echo line — a wider, faded copy of the same path drawn first so it
       * sits behind the sharp line and reads as a soft bloom around it. */}
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

/**
 * Build a smooth SVG `d` attribute that traces the time-domain envelope.
 *
 * Each level in `[-1, 1]` becomes a (x, y) sample; consecutive samples are
 * joined with mid-point quadratic curves so the path has no sharp angles
 * even when the envelope is noisy. The amplitude is amplified and clamped
 * because conversational audio rarely peaks past ~0.3.
 */
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

/** Format an elapsed second-count as `m:ss`. */
export function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
