/**
 * Compile-only fixture: `@alfred/assistant`'s `exports` map is the gate on which
 * `knowledge` subpaths a caller outside the package may resolve.
 *
 * `packages/assistant/package.json` lists one key per supported `./knowledge/…`
 * subpath and NO `"./knowledge/*"` wildcard, so a file that the manifest does not
 * name fails module resolution. `moduleResolution` is `bundler`
 * (`packages/config/tsconfig.base.json`), so `tsc` honours `exports`; Node ESM and
 * rolldown honour it at runtime. That makes the surface a Tier-1 gate with no
 * script to maintain — an unlisted subpath cannot be imported at all, rather than
 * being reachable and merely discouraged.
 *
 * Each line below names a file that lives under `packages/assistant/src/knowledge/`
 * and is deliberately NOT exported. `self-identity` is the measured one: before the
 * wildcard was removed, `@alfred/assistant/knowledge/self-identity` reached
 * `loadSelfIdentity` from outside the package, around the privileged
 * `./knowledge/internal` door and around the `no-restricted-imports` fence that
 * guards it (oxlint matches a specifier as text, with no module resolution, so it
 * can only fence the exact string it is given).
 *
 * This fixture fails CLOSED. If `tsc` ever stopped honouring `exports`, or if the
 * wildcard came back, these directives would go UNUSED and `check-types` would go
 * red on every line — so a green run is evidence that the gate is real, not an
 * assumption that it is. The `typeof import(…)` form is used because a plain
 * `import type` binding would additionally trip `noUnusedLocals`.
 *
 * `packages/http` is the home because its `check-types` runs a second
 * `tsc -p tsconfig.test.json` pass over this tree and the package has a CI job.
 * A fixture in `packages/assistant/test/` would be compiled by nothing
 * (see `.lessons/type-fixture-outside-the-checked-program-is-compiled-by-nothing.md`).
 */

// @ts-expect-error - `self-identity` is not an exported subpath; the exports map is the gate.
type _SelfIdentity = typeof import("@alfred/assistant/knowledge/self-identity");

// @ts-expect-error - `projection` is not an exported subpath; the exports map is the gate.
type _Projection = typeof import("@alfred/assistant/knowledge/projection");

// @ts-expect-error - `facts` is not an exported subpath; the exports map is the gate.
type _Facts = typeof import("@alfred/assistant/knowledge/facts");

/**
 * The positive half, so the three assertions above cannot pass by naming a
 * specifier that never resolved for an unrelated reason (a typo, a missing
 * dependency). `queue` IS a listed subpath and must keep resolving.
 */
type _Queue = typeof import("@alfred/assistant/knowledge/queue");
type _AssertQueueResolves = _Queue["enqueueExtractionForUser"];
