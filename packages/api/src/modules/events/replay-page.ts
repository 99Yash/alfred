/** Maximum durable events read by one SSE connection before it reconnects. */
export const REPLAY_PAGE_SIZE = 500;

export interface ReplayPage<T> {
  frames: T[];
  hasMore: boolean;
}

/**
 * Keep replay work bounded per connection. EventSource reconnects with the
 * final delivered id when `hasMore` is true, turning the existing cap into
 * pagination instead of silently discarding the remainder.
 */
export function toReplayPage<T>(rows: readonly T[]): ReplayPage<T> {
  return {
    frames: rows.slice(0, REPLAY_PAGE_SIZE),
    hasMore: rows.length > REPLAY_PAGE_SIZE,
  };
}
