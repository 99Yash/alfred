/**
 * `@alfred/artifacts-design` — the typed source of truth + generated shell and
 * prompt for pristine in-app artifacts (pristine-artifacts Phase 1).
 *
 * Web-safe (pure strings/data, no DOM/Node): `apps/web` imports the shell to
 * wrap pages at render time; `packages/api` imports the prompt to guide the
 * authoring turn. Both share one token module so the rendered surface and the
 * authoring guidance never drift.
 */
export * from "./tokens";
export * from "./shell";
export * from "./archetypes";
export * from "./templates";
export * from "./theme";
export * from "./prompt";
