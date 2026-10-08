/**
 * Compile-only fixture: `@alfred/assistant` exports no `./knowledge/*` wildcard, so unlisted
 * files fail to resolve. A wildcard once let `knowledge/self-identity` skip the
 * `./knowledge/internal` door and its lint fence (oxlint matches specifiers as text).
 * It lives here because `packages/http` type-checks `test/`; `packages/assistant/test/` is
 * compiled by nothing. It never runs: `.type-test.ts` misses the `test` glob.
 */

// @ts-expect-error - `self-identity` is not an exported subpath; the exports map is the gate.
type _SelfIdentity = typeof import("@alfred/assistant/knowledge/self-identity");

// @ts-expect-error - `projection` is not an exported subpath; the exports map is the gate.
type _Projection = typeof import("@alfred/assistant/knowledge/projection");

// @ts-expect-error - `facts` is not an exported subpath; the exports map is the gate.
type _Facts = typeof import("@alfred/assistant/knowledge/facts");

/**
 * The same files with `.ts`. Each wildcard target form republishes a different spelling:
 *
 *   "./knowledge/*": "./src/knowledge/*.ts"  -> the extensionless specifiers above resolve
 *   "./knowledge/*": "./src/knowledge/*"     -> only the `.ts` specifiers below resolve
 */

// @ts-expect-error - `self-identity` is not exported under any spelling; see above.
type _SelfIdentityTs = typeof import("@alfred/assistant/knowledge/self-identity.ts");

// @ts-expect-error - `projection` is not exported under any spelling; see above.
type _ProjectionTs = typeof import("@alfred/assistant/knowledge/projection.ts");

// @ts-expect-error - `facts` is not exported under any spelling; see above.
type _FactsTs = typeof import("@alfred/assistant/knowledge/facts.ts");

/** `queue` is listed, so the negatives cannot pass on a typo or a missing dependency. */
type _Queue = typeof import("@alfred/assistant/knowledge/queue");

type _AssertQueueResolves = _Queue["enqueueExtractionForUser"];
