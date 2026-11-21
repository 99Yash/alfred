// Public seam for artifacts (ADR-0075): read context, writes, the turn finalizer, and external files.
export {
  buildArtifactReference,
  buildThreadArtifactsContext,
  type ArtifactReferenceRow,
} from "./read";

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
