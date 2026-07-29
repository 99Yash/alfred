import { getLocalStorageItem, LOCAL_STORAGE_KEY, setLocalStorageItem } from "~/lib/storage/storage";
import type { EventStreamFrame } from "./frame";
import { createReplayStateController } from "./replay-state";

const replay = createReplayStateController({
  read: () => getLocalStorageItem(LOCAL_STORAGE_KEY.EVENT_REPLAY_STATE),
  write: (state) => setLocalStorageItem(LOCAL_STORAGE_KEY.EVENT_REPLAY_STATE, state),
});

export function getReplaySince(): number {
  return replay.since();
}

/**
 * The single production entry to the replay cursor.
 *
 * **Hand over a frame that came out of `parseEventFrame`** — payload fields are
 * read unguarded downstream (see `advanceReplayState`). This also runs *before*
 * `openEventStream`'s subscriber fan-out, so a throw in here drops the frame for
 * every subscriber, not only for the replay cursor.
 */
export function noteReplayFrame(frame: EventStreamFrame): void {
  replay.noteFrame(frame);
}
