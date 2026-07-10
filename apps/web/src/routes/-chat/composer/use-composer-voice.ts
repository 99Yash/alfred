import { useCallback, useReducer, type RefObject } from "react";
import { transcribeRecording } from "~/lib/chat/turn-controls";
import { useMicRecording } from "../mic-recording";
import type { TiptapComposerHandle } from "../tiptap-composer";

type VoiceState = {
  transcribing: boolean;
  error: string | null;
};

type VoiceAction =
  | { type: "clear_error" }
  | { type: "transcribe_start" }
  | { type: "transcribe_success" }
  | { type: "transcribe_error"; error: string };

function voiceReducer(state: VoiceState, action: VoiceAction): VoiceState {
  switch (action.type) {
    case "clear_error":
      return { ...state, error: null };
    case "transcribe_start":
      return { transcribing: true, error: null };
    case "transcribe_success":
      return { transcribing: false, error: null };
    case "transcribe_error":
      return { transcribing: false, error: action.error };
  }
}

export function useComposerVoice(editorRef: RefObject<TiptapComposerHandle | null>): {
  mic: ReturnType<typeof useMicRecording>;
  transcribing: boolean;
  voiceError: string | null;
  onVoiceStart: () => void;
  onVoiceConfirm: () => Promise<void>;
} {
  const mic = useMicRecording();
  const [voice, dispatchVoice] = useReducer(voiceReducer, {
    transcribing: false,
    error: null,
  });

  const onVoiceStart = useCallback(() => {
    dispatchVoice({ type: "clear_error" });
    void mic.start();
  }, [mic]);

  const onVoiceConfirm = useCallback(async () => {
    dispatchVoice({ type: "clear_error" });
    const blob = await mic.finish();
    if (!blob) {
      dispatchVoice({ type: "transcribe_error", error: "We didn't catch that. Try again." });
      return;
    }
    dispatchVoice({ type: "transcribe_start" });
    try {
      const transcript = (await transcribeRecording(blob)).trim();
      if (transcript.length === 0) {
        dispatchVoice({ type: "transcribe_error", error: "We didn't catch that. Try again." });
        return;
      }
      editorRef.current?.insertText(transcript);
      dispatchVoice({ type: "transcribe_success" });
    } catch (err) {
      dispatchVoice({
        type: "transcribe_error",
        error: err instanceof Error ? err.message : "Transcription failed. Try again.",
      });
    }
  }, [editorRef, mic]);

  return {
    mic,
    transcribing: voice.transcribing,
    voiceError: voice.error,
    onVoiceStart,
    onVoiceConfirm,
  };
}
