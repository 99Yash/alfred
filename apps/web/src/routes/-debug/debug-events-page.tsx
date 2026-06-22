import { useState } from "react";
import { authClient } from "~/lib/auth/auth-client";
import { useEventStream } from "~/lib/events/use-event-stream";

const API_URL =
  (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL ?? "http://localhost:3001";

export function DebugEventsPage() {
  const { data: session } = authClient.useSession();
  const frames = useEventStream(100);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  // Signed-out visitors are redirected to /login by AppShell's auth guard
  // before this route renders, so there's no need for a sign-in fallback here.
  const sendDemo = async () => {
    if (!session?.user) return;
    setSending(true);
    try {
      await fetch(`${API_URL}/api/events/_demo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          runId: "debug-run",
          step: "manual",
          message: message.trim() || `tick at ${new Date().toLocaleTimeString()}`,
        }),
      });
      setMessage("");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Realtime events</h1>
        <p className="text-sm text-muted-foreground">
          Outbox {"\u2192"} Redis {"\u2192"} SSE. Open this page in two tabs to verify multi-tab
          fan-out.
        </p>
      </div>

      <div className="flex gap-2">
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && sendDemo()}
          placeholder={"Optional message\u2026"}
          aria-label="Demo event message"
          className="flex-1 rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary"
        />
        <button
          type="button"
          onClick={sendDemo}
          disabled={sending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {sending ? "Sending\u2026" : "Send demo event"}
        </button>
      </div>

      {frames.length === 0 ? (
        <p className="text-sm text-muted-foreground">No events received yet.</p>
      ) : (
        <ul className="space-y-2">
          {frames.map((frame) => (
            <li key={frame.id} className="rounded-md border px-4 py-3 text-sm">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="font-mono">
                  #{frame.id}
                  {" \u00b7 "}
                  {frame.kind}
                </span>
                <span>{new Date(frame.createdAt).toLocaleTimeString()}</span>
              </div>
              <pre className="mt-1 whitespace-pre-wrap font-mono text-xs">
                {JSON.stringify(frame.payload, null, 2)}
              </pre>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
