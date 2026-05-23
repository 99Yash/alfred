import { createContext, use } from "react";

/**
 * Chat state shared between the `/preview` layout (owner) and the
 * `/preview/chat` route (reader).
 *
 * Lives in its own module to avoid a circular-import edge case: if the
 * context lived in `routes/preview.tsx` and was imported by
 * `routes/preview.chat.tsx`, Vite + TanStack's route-tree could end up
 * loading two distinct module instances of `preview.tsx` (one via the
 * route tree, one via the chat route's import), creating two distinct
 * `ChatContext` objects so the Consumer reads `null` even though the
 * Provider is mounted above.
 */

export interface ChatContextValue {
  activeThread: string;
  setActiveThread: (id: string) => void;
}

export const ChatContext = createContext<ChatContextValue | null>(null);

export function useChatContext(): ChatContextValue {
  const ctx = use(ChatContext);
  if (!ctx) {
    throw new Error("useChatContext must be used inside the /preview layout");
  }
  return ctx;
}
