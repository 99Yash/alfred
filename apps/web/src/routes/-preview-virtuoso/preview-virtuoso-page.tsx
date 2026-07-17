import type { SyncedChatMessage } from "@alfred/sync";
import { useCallback, useMemo, useRef, useState } from "react";
import { Conversation } from "~/routes/-chat/conversation";
import type { StreamingMessage } from "~/lib/chat/use-chat-stream";
import { SCROLL_CHAT_TO_BOTTOM_EVENT } from "~/lib/chat/use-run-complete";

/**
 * Dev-only harness for issue #496 (virtualized chat feed). Feeds a synthetic
 * long thread and a simulated stream straight into the production
 * `Conversation`, bypassing Replicache, so the windowing + stick-to-bottom
 * behavior can be exercised on localhost without seeding the database.
 *
 * Gated to `import.meta.env.DEV` by the route. Never imported by production.
 */
const THREAD_ID = "preview-virtuoso-thread";
const EPOCH = Date.UTC(2026, 0, 1, 12, 0, 0);

const ASSISTANT_BODIES = [
  "Here's a quick summary of what I found.\n\n- First point worth calling out\n- A second, slightly longer observation that wraps across a couple of lines to exercise variable row heights\n- Third\n\nLet me know if you'd like me to go deeper on any of these.",
  "Short answer: yes.",
  "I dug through the thread and pulled together the relevant context. The main tradeoff is between latency and completeness — we can optimize for one at the expense of the other, and the right call depends on how the feature is used in practice.\n\n```ts\nfunction example(n: number) {\n  return n * 2;\n}\n```\n\nThat snippet is illustrative, not final.",
  "Done. I updated the draft and left the tone unchanged.",
  "A few things to consider before we commit:\n\n1. The rollout order matters — schema first, then the consumer.\n2. We should keep the old path behind a flag for one release.\n3. Observability needs a decision-trace so we can debug drift later.\n\nHappy to expand any of these into a plan.",
];

function makeMessage(i: number): SyncedChatMessage {
  const role = i % 2 === 0 ? "user" : "assistant";
  const createdAt = new Date(EPOCH + i * 30_000).toISOString();
  const content =
    role === "user"
      ? `User message #${i}: ${i % 5 === 0 ? "can you take a longer look at this one and walk me through the reasoning step by step so I can follow along" : "quick question " + i}`
      : `${ASSISTANT_BODIES[i % ASSISTANT_BODIES.length]}\n\n_(reply #${i})_`;
  return {
    id: `preview-msg-${i}`,
    userId: "preview-user",
    threadId: THREAD_ID,
    role,
    content,
    reasoning: null,
    reasoningMs: null,
    status: "complete",
    errorKind: null,
    toolCalls: null,
    narration: null,
    usage: null,
    runId: role === "assistant" ? `preview-run-${i}` : null,
    rowVersion: 1,
    createdAt,
    updatedAt: null,
  };
}

export function PreviewVirtuosoPage() {
  const params = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
  const count = Math.max(1, Number(params.get("count") ?? "500") || 500);

  const base = useMemo(() => Array.from({ length: count }, (_, i) => makeMessage(i)), [count]);
  const [appended, setAppended] = useState<SyncedChatMessage[]>([]);
  const [stream, setStream] = useState<StreamingMessage | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const messages = useMemo(() => [...base, ...appended], [base, appended]);

  // Simulate a streaming turn: an assistant reply whose text grows over ~5s,
  // then finishes and folds into the durable messages. Exercises footer-growth
  // stick-to-bottom (the risky part of the Virtuoso port).
  const simulateStream = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    const seq = base.length + appended.length;
    const messageId = `preview-stream-${seq}`;
    const runId = `preview-stream-run-${seq}`;
    const full =
      "Streaming this reply in now. I'll keep adding sentences so the footer grows continuously and the feed should ride the bottom the entire time without you touching the scrollbar. " +
      "Here is a second paragraph to push the content taller than the detach threshold in a single burst. " +
      "And a third, with a short list:\n\n- alpha\n- beta\n- gamma\n\nThat should be enough to tell whether stick-to-bottom holds during a fast stream.";
    let shown = 0;
    setStream({
      messageId,
      runId,
      text: "",
      narration: [],
      reasoning: "",
      reasoningActive: true,
      reasoningMs: null,
      tools: [],
      awaitingApproval: false,
      compacting: false,
      done: false,
    });
    timerRef.current = setInterval(() => {
      shown += Math.max(4, Math.floor(full.length / 60));
      const done = shown >= full.length;
      setStream((prev) =>
        prev
          ? {
              ...prev,
              text: full.slice(0, Math.min(shown, full.length)),
              reasoningActive: false,
              done,
            }
          : prev,
      );
      if (done && timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
        // Fold the finished stream into the durable transcript, then drop the
        // live bubble — mirrors the Replicache sync taking over.
        const createdAt = new Date(EPOCH + seq * 30_000).toISOString();
        setAppended((prev) => [
          ...prev,
          {
            id: messageId,
            userId: "preview-user",
            threadId: THREAD_ID,
            role: "assistant",
            content: full,
            reasoning: null,
            reasoningMs: null,
            status: "complete",
            errorKind: null,
            toolCalls: null,
            narration: null,
            usage: null,
            runId,
            rowVersion: 1,
            createdAt,
            updatedAt: null,
          },
        ]);
        setTimeout(() => setStream(null), 400);
      }
    }, 80);
  }, [base.length, appended.length]);

  const appendUserTurn = useCallback(() => {
    const seq = base.length + appended.length;
    setAppended((prev) => [
      ...prev,
      {
        id: `preview-appended-${seq}`,
        userId: "preview-user",
        threadId: THREAD_ID,
        role: "user",
        content: `Freshly appended user message (#${seq}) — this should re-engage stick-to-bottom.`,
        reasoning: null,
        reasoningMs: null,
        status: "complete",
        errorKind: null,
        toolCalls: null,
        narration: null,
        usage: null,
        runId: null,
        rowVersion: 1,
        createdAt: new Date(EPOCH + seq * 30_000).toISOString(),
        updatedAt: null,
      },
    ]);
  }, [base.length, appended.length]);

  return (
    <div className="flex h-screen w-full flex-col bg-app-background text-app-fg-4">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-app-fg-a1 px-4 py-2 text-sm">
        <span className="font-medium" data-testid="preview-count">
          {messages.length} messages
        </span>
        <button
          type="button"
          onClick={simulateStream}
          className="rounded-md bg-app-bg-2 px-3 py-1 hover:bg-app-bg-3"
          data-testid="simulate-stream"
        >
          Simulate stream
        </button>
        <button
          type="button"
          onClick={appendUserTurn}
          className="rounded-md bg-app-bg-2 px-3 py-1 hover:bg-app-bg-3"
          data-testid="append-user"
        >
          Append user turn
        </button>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event(SCROLL_CHAT_TO_BOTTOM_EVENT))}
          className="rounded-md bg-app-bg-2 px-3 py-1 hover:bg-app-bg-3"
          data-testid="scroll-event"
        >
          Fire scroll-to-bottom event
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <Conversation
          messages={messages}
          stream={stream}
          onFollowUp={() => {}}
          onOpenArtifact={() => {}}
        />
      </div>
    </div>
  );
}
