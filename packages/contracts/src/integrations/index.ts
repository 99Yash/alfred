/**
 * The integration registry (ADR-0093). One folder, four modules:
 *
 * - `registry.ts`: the entry shapes, the credential and passthrough specs, and
 *   the `INTEGRATIONS` record; its keys are the slug space.
 * - `slugs.ts`: the unions and lists derived from the record.
 * - `projections.ts`: the slug-keyed tables built from the record.
 * - `connected.ts`: the connected rule each `CredentialSpec` declares, executable.
 */

export * from "./registry";

export * from "./slugs";

export * from "./projections";

export * from "./connected";
