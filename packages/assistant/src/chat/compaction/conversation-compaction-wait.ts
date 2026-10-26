import { setTimeout as sleep } from "node:timers/promises";
import { loadChatThreadContext, type LoadedChatThreadContext } from "./chat-context-store";

const FOREGROUND_COMPACTION_WAIT_MS = 500;

const FOREGROUND_COMPACTION_POLL_MS = 50;

export interface ConversationCompactionWaitDependencies {
  loadContext?: (userId: string, threadId: string) => Promise<LoadedChatThreadContext | null>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Briefly reuse a background compaction already in flight. Returns only a
 * strictly newer, valid summary generation; timeout and inactive jobs are
 * normal misses, not failures.
 */
export async function waitForActiveConversationCompaction(
  userId: string,
  threadId: string,
  dependencies: ConversationCompactionWaitDependencies = {},
): Promise<LoadedChatThreadContext | null> {
  const loadContext = dependencies.loadContext ?? loadChatThreadContext;
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.sleep ?? ((ms: number) => sleep(ms));
  const initial = await loadContext(userId, threadId);

  if (!isCompactionActive(initial)) return null;

  const initialGeneration = initial.compactionGeneration;
  const deadline = now() + FOREGROUND_COMPACTION_WAIT_MS;

  while (now() < deadline) {
    await wait(Math.min(FOREGROUND_COMPACTION_POLL_MS, deadline - now()));
    const current = await loadContext(userId, threadId);

    if (
      current &&
      current.compactionGeneration > initialGeneration &&
      current.invalidSummary === false &&
      current.summary !== null
    ) {
      return current;
    }

    if (!isCompactionActive(current)) return null;
  }

  return null;
}

export function isCompactionActive(
  context: LoadedChatThreadContext | null,
): context is LoadedChatThreadContext {
  if (!context?.compactionRequestedAt) return false;
  const requestedAt = context.compactionRequestedAt.getTime();
  const completedAt = context.compactionCompletedAt?.getTime() ?? -Infinity;
  const failedAt = context.compactionFailedAt?.getTime() ?? -Infinity;

  return requestedAt > completedAt && requestedAt > failedAt;
}
