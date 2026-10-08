import { useEffect, useRef, useState } from "react";

/**
 * Browser speech-to-text (Web Speech API) for the notes composer. Final segments
 * go to `start(onFinal)`; `interim` is the live guess. Chromium/WebKit only, so gate UI on `supported`.
 */
export function useDictation() {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  // A ref, so the long-lived recognizer always calls the current handler.
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

    // Recognition can end on its own (silence); tear down so the UI does not stay "listening".
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
    // stop uses only refs and setters; tear down once on unmount.
  }, []);

  return { supported, listening, interim, error, start, stop };
}

// The TS DOM lib lacks the recognition interface, its events, and
// `webkitSpeechRecognition`, so we declare what this hook uses.

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
    SpeechRecognition?: SpeechRecognitionCtor | undefined;
    webkitSpeechRecognition?: SpeechRecognitionCtor | undefined;
  }
}
