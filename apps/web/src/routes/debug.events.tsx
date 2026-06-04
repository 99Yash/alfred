import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { useState } from "react";
import { authClient } from "~/lib/auth-client";
import { useEventStream } from "~/lib/events/use-event-stream";

const API_URL =
  (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL ?? "http://localhost:3001";

export const Route = createFileRoute("/debug/events")({
  head: () => pageMeta({ title: "Debug events", path: "/debug/events" }),
  component: DebugEventsPage,
});

function DebugEventsPage() {
  const { data: session } = authClient.useSession();
  const frames = useEventStream(100);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

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

  if (!session?.user) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center space-y-4">
          <p className="text-muted-foreground">Not signed in.</p>
          <a href="/login" className="underline text-sm">
            Sign in
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Realtime events</h1>
        <p className="text-sm text-muted-foreground">
          Outbox → Redis → SSE. Open this page in two tabs to verify multi-tab fan-out.
        </p>
      </div>

      <div className="flex gap-2">
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && sendDemo()}
          placeholder="Optional message…"
          aria-label="Demo event message"
          className="flex-1 rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary"
        />
        <button
          type="button"
          onClick={sendDemo}
          disabled={sending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {sending ? "Sending…" : "Send demo event"}
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
                  #{frame.id} · {frame.kind}
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
