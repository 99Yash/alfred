/**
 * Artifact render shell, document templates, authoring prompts, and PDF validation. Pure data,
 * safe in the browser. Import the design tokens from the `./tokens` subpath.
 */
export { buildArtifactDocument } from "./shell";

export { documentTemplates, documentTemplateById } from "./templates";

export { ARTIFACT_DESIGN_PROMPT, ARTIFACT_DOCUMENT_DESIGN_PROMPT } from "./prompt";

export { pdfArtifactHtmlViolations } from "./validation";
