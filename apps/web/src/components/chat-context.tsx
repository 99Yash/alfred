import { createContext, use } from "react";

/**
 * Active-thread state shared between `AppShell` (owner) and the chat routes
 * (readers — `/chat`, `/chat/$threadId`, and the `/preview/chat` demo).
 *
 * Lives in its own module to avoid a circular-import edge case: if the
 * context lived in `lib/app-shell.tsx` and was imported by the chat routes,
 * Vite + TanStack's route-tree could end up loading two distinct module
 * instances of `app-shell.tsx`, creating two distinct `ChatContext` objects
 * so the Consumer reads `null` even though the Provider is mounted above.
 */

export interface ChatContextValue {
  activeThread: string;
  setActiveThread: (id: string) => void;
}

export const ChatContext = createContext<ChatContextValue | null>(null);

export function useChatContext(): ChatContextValue {
  const ctx = use(ChatContext);
  if (!ctx) {
    throw new Error("useChatContext must be used inside AppShell");
  }
  return ctx;
}
