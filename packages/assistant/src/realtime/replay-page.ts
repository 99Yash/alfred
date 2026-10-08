/** Events per SSE connection before it reconnects. */
export const REPLAY_PAGE_SIZE = 500;

export interface ReplayPage<T> {
  frames: T[];
  hasMore: boolean;
}

/** On `hasMore`, EventSource reconnects from the last id, so the cap pages instead of dropping. */
export function toReplayPage<T>(rows: readonly T[]): ReplayPage<T> {
  return {
    frames: rows.slice(0, REPLAY_PAGE_SIZE),
    hasMore: rows.length > REPLAY_PAGE_SIZE,
  };
}
