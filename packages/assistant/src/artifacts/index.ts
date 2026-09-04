// Public seam for the `artifacts` module. Read side builds a thread's artifact
// context for the chat recipe; write side owns the agent-authored create/append/
// update path (ADR-0075) plus the turn-close finalizer; external-file surfaces a
// Drive/other pointer artifact inline. Cross-module callers (the `system.*` and
// `drive` tools) import these here, not the private files.
export { ARTIFACT_SYSTEM_GUIDANCE, buildThreadArtifactsContext } from "./read";
export {
  createArtifact,
  appendArtifactPage,
  appendArtifactSection,
  updateArtifact,
  finalizeRunArtifacts,
  type ArtifactWriteContext,
} from "./write";
export {
  surfaceExternalFileArtifact,
  type SurfaceExternalFileInput,
  type SurfaceExternalFileResult,
} from "./external-file";
