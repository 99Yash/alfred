/**
 * Package resolution is the seam this file guards. `@alfred/api` used to
 * publish two compatibility doors — `./backend` and `./runtime` — that
 * re-exported names owned by `@alfred/assistant` modules. Both are deleted, and
 * `packages/api/package.json` now publishes an EMPTY `exports` map, so Node
 * answers `ERR_PACKAGE_PATH_NOT_EXPORTED` for every subpath of the package.
 *
 * A grep cannot make that claim. A grep proves that nobody writes the
 * specifier today; only a resolution attempt proves that nobody CAN.
 *
 * Two shapes keep this test honest:
 *
 * 1. Every specifier is held in a `const` and reached through `import()`.
 *    TypeScript resolves a literal specifier at compile time, so a static
 *    `import` of a deleted door would fail the typecheck instead of the test,
 *    and the assertion would never run.
 * 2. A FIRING CONTROL resolves `@alfred/assistant/briefings` in the same file.
 *    Without it, a green result cannot tell a closed door apart from a broken
 *    resolver: every `assert.rejects` would pass if workspace resolution were
 *    dead altogether.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

/** Subpaths that `@alfred/api` must refuse after the transition doors close. */
const CLOSED_DOORS = ["@alfred/api/backend", "@alfred/api/runtime"] as const;

/**
 * A live workspace subpath. If this one stops resolving, the negative
 * assertions below prove nothing, so it runs first.
 */
const FIRING_CONTROL = "@alfred/assistant/briefings";

describe("transitional @alfred/api doors", () => {
  it("resolves a live workspace subpath (firing control)", async () => {
    const specifier = FIRING_CONTROL;
    const loaded: unknown = await import(specifier);
    assert.ok(
      loaded !== null && typeof loaded === "object",
      `${FIRING_CONTROL} must resolve, otherwise the negative assertions below are vacuous`,
    );
  });

  for (const door of CLOSED_DOORS) {
    it(`refuses to resolve ${door}`, async () => {
      const specifier: string = door;
      await assert.rejects(
        async () => {
          await import(specifier);
        },
        (error: unknown) => {
          assert.ok(error instanceof Error, `${door} must reject with an Error`);
          const code = (error as NodeJS.ErrnoException).code;
          assert.ok(
            code === "ERR_PACKAGE_PATH_NOT_EXPORTED" || code === "ERR_MODULE_NOT_FOUND",
            `${door} must reject with a resolution failure, got ${String(code)}: ${error.message}`,
          );
          return true;
        },
      );
    });
  }
});
