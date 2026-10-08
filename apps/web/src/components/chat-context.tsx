import { createContext, use } from "react";

/**
 * Active-thread state, owned by `AppShell` and read by the chat routes.
 * Its own module: importing it from app-shell could load two module instances,
 * and the consumer would read `null`.
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
