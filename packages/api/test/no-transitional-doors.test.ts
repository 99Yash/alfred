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
 * The answer depends on WHERE the probe runs, so read this before you move the
 * file. No `node_modules/@alfred/api` link exists in this repo any more,
 * because this package is now the last manifest that names itself. A probe run
 * from inside `packages/api` — which is where `pnpm --filter @alfred/api test`
 * runs it — therefore resolves through Node's SELF-REFERENCE rule: the nearest
 * parent manifest carries both a matching `name` and an `exports` key, so Node
 * consults the map and the empty map refuses the subpath. A probe run from the
 * repo root or from `apps/server` gets `ERR_MODULE_NOT_FOUND` instead, because
 * no link exists to consult. Keep `"exports": {}` anyway: it is the stronger
 * door the moment any package re-declares the dependency. Deleting the key does
 * not reopen legacy path resolution here — it STOPS self-reference, and every
 * assertion below then reports `ERR_MODULE_NOT_FOUND`.
 *
 * Three shapes keep this test honest:
 *
 * 1. Every specifier is held in a `const` and reached through `import()`.
 *    TypeScript resolves a literal specifier at compile time, so a static
 *    `import` of a deleted door would fail the typecheck instead of the test,
 *    and the assertion would never run.
 * 2. A FIRING CONTROL resolves `@alfred/assistant/briefings` in the same file.
 *    Without it, a green result cannot tell a closed door apart from a broken
 *    resolver: every `assert.rejects` would pass if workspace resolution were
 *    dead altogether.
 * 3. The rejection code must be EXACTLY `ERR_PACKAGE_PATH_NOT_EXPORTED`.
 *    `ERR_MODULE_NOT_FOUND` says only that no package answered the specifier.
 *    That is what Node reports when the `exports` key is deleted instead of
 *    emptied, which is the weaker door this item rejects. Accepting both codes
 *    made this test pass with that key removed.
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
          assert.equal(
            code,
            "ERR_PACKAGE_PATH_NOT_EXPORTED",
            `${door} must be refused by the exports map, not merely missing on disk. ` +
              `Got ${String(code)}: ${error.message}`,
          );
          return true;
        },
      );
    });
  }
});
