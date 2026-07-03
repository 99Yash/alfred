import { useEffect, useRef, useState } from "react";

/**
 * `useDictation` — thin wrapper around the Web Speech API
 * (`SpeechRecognition`) that turns spoken audio into text for the notes
 * composer.
 *
 * Unlike the chat composer's `useMicRecording` (which records audio and
 * transcribes server-side via Whisper), this hook transcribes locally in the
 * browser: finalised transcript segments are handed to `start(onFinal)` as
 * they settle, and the live interim guess is exposed via `interim` for an
 * inline preview.
 *
 * Browser support is Chromium/WebKit only today, so callers must gate UI on
 * `supported`. Everything tears down on `stop()` and on unmount.
 */
export function useDictation() {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  // Latest onFinal handler, kept in a ref so the long-lived recognition
  // instance always calls the current closure without re-binding listeners.
  const onFinalRef = useRef<(chunk: string) => void>(() => {});

  const supported =
    typeof window !== "undefined" &&
    (window.SpeechRecognition != null || window.webkitSpeechRecognition != null);

  const stop = () => {
    const rec = recognitionRef.current;
    if (rec) {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      rec.stop();
      recognitionRef.current = null;
    }
    setListening(false);
    setInterim("");
  };

  const start = (onFinal: (chunk: string) => void) => {
    if (recognitionRef.current) return;
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Ctor) return;
    onFinalRef.current = onFinal;
    setError(null);

    const rec = new Ctor();
    rec.lang = navigator.language || "en-US";
    rec.continuous = true;
    rec.interimResults = true;

    rec.onresult = (event) => {
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result) continue;
        const transcript = result[0]?.transcript ?? "";
        if (result.isFinal) {
          onFinalRef.current(transcript.trim());
        } else {
          interimText += transcript;
        }
      }
      setInterim(interimText);
    };

    rec.onerror = (event) => {
      const code = event.error;
      setError(
        code === "not-allowed" || code === "service-not-allowed"
          ? "Microphone access denied"
          : code === "no-speech"
            ? "Didn't catch that — try again"
            : "Dictation stopped unexpectedly",
      );
      stop();
    };

    // Fires when recognition ends on its own (silence timeout, etc.). Mirror
    // the teardown so the UI doesn't get stuck in a listening state.
    rec.onend = () => {
      recognitionRef.current = null;
      setListening(false);
      setInterim("");
    };

    recognitionRef.current = rec;
    rec.start();
    setListening(true);
  };

  useEffect(() => {
    return () => stop();
    // stop closes over refs/setters only; run teardown once on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { supported, listening, interim, error, start, stop };
}

// ---------------------------------------------------------------------------
// Minimal ambient types for the Web Speech API. This TS DOM lib ships the
// result sub-types but not the recognition interface, its events, or the
// `webkitSpeechRecognition` global — so we declare just what this hook touches.
// ---------------------------------------------------------------------------

interface SpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: ((event: Event) => void) | null;
}

interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
}

type SpeechRecognitionCtor = new () => SpeechRecognition;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  }
}
