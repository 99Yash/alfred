// Transitional re-export. `@alfred/api` still owns the root Elysia app; this
// package exists so the later transport slices have a destination to move into
// one at a time.
export { app } from "@alfred/api";
export type { App } from "@alfred/api";
