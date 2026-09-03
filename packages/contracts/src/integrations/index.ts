/**
 * The integration registry (ADR-0093). One folder, four modules:
 *
 * - `types.ts`: the entry shapes and the credential and passthrough specs.
 * - `registry.ts`: the `INTEGRATIONS` record; its keys are the slug space.
 * - `slugs.ts`: the unions and lists derived from the record.
 * - `projections.ts`: the slug-keyed tables built from the record.
 */

export * from "./types";
export * from "./registry";
export * from "./slugs";
export * from "./projections";
