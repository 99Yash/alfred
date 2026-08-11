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
 * This fixture fails CLOSED against BOTH wildcard spellings. If `tsc` ever stopped
 * honouring `exports`, or if a `./knowledge/*` key came back in either the `*.ts` or
 * the extensionless target form, the matching directives below would go UNUSED and
 * `check-types` would go red — so a green run is evidence that the gate is real, not
 * an assumption that it is. Pinning only one spelling leaves the other free, which is
 * why every negative appears twice. The `typeof import(…)` form is used because a plain
 * `import type` binding would additionally trip `noUnusedLocals`.
 *
 * `packages/http` is the home because its `check-types` runs a second
 * `tsc -p tsconfig.test.json` pass over this tree, which is the whole mechanism.
 * The compiler that reads this file is reached through CI's `static` job —
 * `verify:fast` -> `check-types` -> `turbo run check-types` across every workspace.
 * NOT the `http-tests` job: that runs `tsx --test` over a glob of `.test.ts` files
 * under `test/`, and this file ends in `-test.ts`, so the glob never matches it.
 * (Spelling the glob out here is not possible: it contains the block-comment
 * terminator.) A fixture in
 * `packages/assistant/test/` would be compiled by nothing
 * (see `.lessons/type-fixture-outside-the-checked-program-is-compiled-by-nothing.md`).
 * `packages/api` would serve equally on mechanism and is where almost every
 * `knowledge` subpath importer lives, so it is the more colocated home; moving it
 * there is a follow-up, not a property of this fixture. No count is given on
 * purpose — a tally in a comment rots on the next importer added or removed, and
 * the queued item that rehomes those tests will move most of them.
 */

// @ts-expect-error - `self-identity` is not an exported subpath; the exports map is the gate.
type _SelfIdentity = typeof import("@alfred/assistant/knowledge/self-identity");

// @ts-expect-error - `projection` is not an exported subpath; the exports map is the gate.
type _Projection = typeof import("@alfred/assistant/knowledge/projection");

// @ts-expect-error - `facts` is not an exported subpath; the exports map is the gate.
type _Facts = typeof import("@alfred/assistant/knowledge/facts");

/**
 * The same three files, spelled WITH `.ts`. Both spellings are load-bearing, because a
 * wildcard key can be written two ways and each one republishes a different specifier:
 *
 *   "./knowledge/*": "./src/knowledge/*.ts"  -> the extensionless specifiers above resolve
 *   "./knowledge/*": "./src/knowledge/*"     -> only the `.ts` specifiers below resolve
 *
 * The second form is not hypothetical: `./artifacts/*` and `./tool-runtime/*` are written
 * that way in this very manifest, so it is the idiom a future edit is most likely to copy.
 * With only the extensionless half, re-adding that form republishes every unlisted file in
 * the directory while all three directives above stay used and `check-types`,
 * `check:exports` and CI all stay green — measured, not argued.
 */

// @ts-expect-error - `self-identity` is not exported under any spelling; see above.
type _SelfIdentityTs = typeof import("@alfred/assistant/knowledge/self-identity.ts");

// @ts-expect-error - `projection` is not exported under any spelling; see above.
type _ProjectionTs = typeof import("@alfred/assistant/knowledge/projection.ts");

// @ts-expect-error - `facts` is not exported under any spelling; see above.
type _FactsTs = typeof import("@alfred/assistant/knowledge/facts.ts");

/**
 * The positive half, so the three assertions above cannot pass by naming a
 * specifier that never resolved for an unrelated reason (a typo, a missing
 * dependency). `queue` IS a listed subpath and must keep resolving.
 */
type _Queue = typeof import("@alfred/assistant/knowledge/queue");
type _AssertQueueResolves = _Queue["enqueueExtractionForUser"];
