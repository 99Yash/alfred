import { getLocalStorageItem, LOCAL_STORAGE_KEY, setLocalStorageItem } from "~/lib/storage/storage";
import { createReplayStateController, type ReplayFrame } from "./replay-state";

const replay = createReplayStateController({
  read: () => getLocalStorageItem(LOCAL_STORAGE_KEY.EVENT_REPLAY_STATE),
  write: (state) => setLocalStorageItem(LOCAL_STORAGE_KEY.EVENT_REPLAY_STATE, state),
});

export function getReplaySince(): number {
  return replay.since();
}

export function noteReplayFrame(frame: ReplayFrame): void {
  replay.noteFrame(frame);
}
