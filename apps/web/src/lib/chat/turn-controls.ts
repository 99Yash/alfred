/** One-shot fetches for voice transcription and stop. */

import { apiErrorMessage, getStringPath } from "@alfred/contracts";
import { API_URL } from "~/lib/eden";

/** Throws with the server's message so the composer can show it inline. */
export async function transcribeRecording(blob: Blob): Promise<string> {
  const ext = blob.type.includes("webm") ? "webm" : blob.type.includes("mp4") ? "m4a" : "audio";
  const form = new FormData();
  form.append("audio", new File([blob], `recording.${ext}`, { type: blob.type }));

  const res = await fetch(`${API_URL}/api/chat/transcribe`, {
    method: "POST",
    credentials: "include",
    body: form,
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(apiErrorMessage(body, `Transcription failed (${res.status})`));
  }

  return getStringPath(await res.json(), "text") ?? "";
}

/** Best effort. The worker sees the flag within ~400ms and the normal completion updates the UI. */
export async function stopChatRun(runId: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/api/chat/runs/${runId}/stop`, {
      method: "POST",
      credentials: "include",
      // Bound it so a wedged connection does not hang the stop button.
      signal: AbortSignal.timeout(10_000),
    });

    return res.ok;
  } catch {
    return false;
  }
}
