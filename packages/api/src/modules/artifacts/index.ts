// Public seam for the `artifacts` module. Read side builds a thread's artifact
// context for the chat recipe; write side finalizes a run's artifacts on turn
// close. Cross-module callers import these here, not the private files.
export { buildThreadArtifactsContext } from "./read";
export { finalizeRunArtifacts } from "./write";
