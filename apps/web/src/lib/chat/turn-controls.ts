/**
 * Small fetch helpers for the chat turn's side-channels: voice transcription
 * and stop-generation. Plain `fetch` against the API origin with the session
 * cookie, matching `use-send-message`'s turn kick (these are imperative
 * one-shots, not synced state — Replicache and the SSE bus stay the source of
 * truth for everything durable).
 */

const API_URL =
  (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL ?? "http://localhost:3001";

/**
 * Send recorded composer audio for transcription; resolves with the
 * transcript text. Throws with the server's message (e.g. the
 * OPENAI_API_KEY-missing 503) so the composer can surface it inline.
 */
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
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `Transcription failed (${res.status})`);
  }
  const payload = (await res.json()) as { text?: string };
  return typeof payload.text === "string" ? payload.text : "";
}

/**
 * Ask the server to stop an in-flight chat turn. Best-effort: the worker
 * notices the flag within ~400ms, finalizes the partial reply, and the
 * normal `chat.message completed` flow reconciles the UI — so callers only
 * need to know whether the request landed.
 */
export async function stopChatRun(runId: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/api/chat/runs/${runId}/stop`, {
      method: "POST",
      credentials: "include",
      // Best-effort one-shot: bound it so a wedged connection doesn't hang the
      // stop button on the browser's default network timeout. A miss just
      // reports `false` — the normal completion flow still reconciles the UI.
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
