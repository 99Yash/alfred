/**
 * Compile-only fixture: the two MCP doors this slice opened in `@alfred/assistant`,
 * and the different enforcement each one actually buys.
 *
 * The MCP product code used to live in `@alfred/api` behind one barrel that also
 * re-exported an Elysia plugin. It is now split in two by module:
 * `@alfred/assistant/connections/mcp` owns the live client, the session cache and
 * the connection rows, and `@alfred/assistant/tool-runtime/mcp` owns durable
 * invocation, the ambiguity barrier and the ADR-0088 approval derivation. The
 * point of the split is that the connection side cannot reach the approval side,
 * and the `exports` map is what a caller outside the package meets.
 *
 * `packages/assistant` is the home, and the tier is weaker here than it was in
 * `packages/api`. The mechanism that still holds is the `exports` map: this
 * package's `check-types` runs a second `tsc -p tsconfig.test.json` pass over
 * this tree, and TypeScript routes a SELF-reference through the package's own
 * `exports` map exactly as it routes an outside caller, so every admission and
 * every refusal below is still a real answer from that map.
 * `packages/assistant/test/action-policies/barrel-load.test.ts` probes the same
 * doors from the same position.
 *
 * What is GONE is the outside-consumer tier. This fixture used to sit in
 * `packages/api`, a package that DEPENDED on `@alfred/assistant`, so it also
 * pinned that a caller reaching in from another package meets the same surface —
 * a self-reference cannot pin that, because it never consults a `node_modules`
 * link or a workspace dependency edge. Restoring it needs a copy of this fixture
 * in a package that depends on assistant; campaign item 208 owns that.
 * `moduleResolution` is `bundler`
 * (`packages/config/tsconfig.base.json`), so `tsc` honours `exports`; Node ESM and
 * rolldown honour it at runtime.
 */

// ---------------------------------------------------------------------------
// Both doors resolve. Without this half the negatives below could pass because a
// specifier never resolved for an unrelated reason (a typo, a missing manifest
// key, a missing dependency).
// ---------------------------------------------------------------------------

type ConnectionsDoor = typeof import("@alfred/assistant/connections/mcp");
type ToolRuntimeDoor = typeof import("@alfred/assistant/tool-runtime/mcp");

type _AssertConnectionsDoorResolves = ConnectionsDoor["getMcpConnectionManager"];
type _AssertToolRuntimeDoorResolves = ToolRuntimeDoor["getMcpExecutionBroker"];

// ---------------------------------------------------------------------------
// Door 1 is TIER 1, and this is what makes it so: `packages/assistant/package.json`
// carries `"./connections/mcp"` and `"./connections/mcp/test-support"` as EXACT
// keys with no `"./connections/*"` wildcard sibling. So the only names reachable by
// a package specifier are the ones those TWO files export, every other leaf under
// the directory is unreachable, and which of the two a name sits in is the
// enforcement (the test-support block below is where that second half is pinned).
// Both wildcard spellings are pinned here, because a wildcard key can be written
// two ways and each republishes a different specifier
// (`.lessons/a-wildcard-exports-target-has-two-forms-that-republish-different-specifier-spellings.md`):
//
//   "./connections/mcp/*": "./src/connections/mcp/*.ts"  -> the extensionless form resolves
//   "./connections/mcp/*": "./src/connections/mcp/*"     -> only the `.ts` form resolves
//
// If either form were added, the matching directive below would go UNUSED and
// `check-types` would go red. Campaign item 39 exists to keep the analogous
// wildcard off `./connections`.
// ---------------------------------------------------------------------------

// @ts-expect-error - `persistence` is not an exported subpath; the exports map is the gate.
type _ConnPersistence = typeof import("@alfred/assistant/connections/mcp/persistence");

// @ts-expect-error - `persistence` is not exported under the `.ts` spelling either.
type _ConnPersistenceTs = typeof import("@alfred/assistant/connections/mcp/persistence.ts");

// @ts-expect-error - `oauth` is not an exported subpath; it reaches the credential vault.
type _ConnOauth = typeof import("@alfred/assistant/connections/mcp/oauth");

// @ts-expect-error - `oauth` is not exported under the `.ts` spelling either.
type _ConnOauthTs = typeof import("@alfred/assistant/connections/mcp/oauth.ts");

// ---------------------------------------------------------------------------
// The boundary the split exists to draw: the approval/invocation half is NOT on
// the connections door. `resolveMcpToolIdentity` is the single fail-closed
// derivation the approval gate and the execution broker share (ADR-0088), and
// after this split the module that owns connection and session state cannot
// consult it at all — not through a leaf (above) and not through the barrel.
// ---------------------------------------------------------------------------

// @ts-expect-error - the ADR-0088 identity derivation belongs to `tool-runtime/mcp`.
type _NoIdentityOnConnections = ConnectionsDoor["resolveMcpToolIdentity"];

// @ts-expect-error - the crash-recovery ledger sweep belongs to `tool-runtime/mcp`.
type _NoReconcileOnConnections = ConnectionsDoor["reconcileInflightInvocations"];

// @ts-expect-error - the reviewed-downgrade risk resolver belongs to `tool-runtime/mcp`.
type _NoRiskOnConnections = ConnectionsDoor["resolveMcpCallRiskTier"];

// ---------------------------------------------------------------------------
// A door is only worth having if the names ON it are the ones a caller should be
// able to make. Four names are therefore behind a `test-support` subpath instead
// (the `./action-policies/test-support` precedent). Two are authority-minting
// writes: `publishCatalogRevision` advances a catalog pointer with no
// compare-and-set, and `upsertToolPolicy` mints the ADR-0088 reviewed downgrade.
// Two are the singleton setters, `_setMcpConnectionManagerForTests` and
// `_setMcpExecutionBrokerForTests` — one per module since the split, so replacing
// either from product code leaves the other holding a stale view. All four have
// zero product callers repo-wide. The negatives below are what keep them off the
// product doors.
// ---------------------------------------------------------------------------

type ConnectionsTestSupport = typeof import("@alfred/assistant/connections/mcp/test-support");
type ToolRuntimeTestSupport = typeof import("@alfred/assistant/tool-runtime/mcp/test-support");

type _AssertConnTestSupportResolves = ConnectionsTestSupport["publishCatalogRevision"];
type _AssertToolRuntimeTestSupportResolves = ToolRuntimeTestSupport["upsertToolPolicy"];
type _AssertBrokerSetterIsTestSupport = ToolRuntimeTestSupport["_setMcpExecutionBrokerForTests"];

// @ts-expect-error - the unguarded catalog-pointer write is test-support, not product surface.
type _NoPublishOnConnections = ConnectionsDoor["publishCatalogRevision"];

// @ts-expect-error - replacing the session cache does not invalidate the broker; test-support only.
type _NoManagerSetterOnConnections = ConnectionsDoor["_setMcpConnectionManagerForTests"];

// @ts-expect-error - the reviewed-downgrade mint is test-support, not product surface.
type _NoPolicyMintOnToolRuntime = ToolRuntimeDoor["upsertToolPolicy"];

// @ts-expect-error - replacing the broker singleton is test-support, exactly like its manager twin.
type _NoBrokerSetterOnToolRuntime = ToolRuntimeDoor["_setMcpExecutionBrokerForTests"];

// ---------------------------------------------------------------------------
// Door 2 is TIER 4, not tier 1, and this is the measurement that says so rather
// than a claim in a comment. `"./tool-runtime/*": "./src/tool-runtime/*.ts"`
// already republishes every leaf under the directory, so the barrel is a
// convention and not a gate: the leaf resolves whether or not `index.ts` names
// it, and `check-module-architecture.mjs` is blind to a bare specifier by design.
// Campaign item 79 owns narrowing that wildcard and is the only thing that
// promotes this door; when it lands, this positive assertion is what will fail
// and point at the line to change.
// ---------------------------------------------------------------------------

type ToolRuntimeLeaf = typeof import("@alfred/assistant/tool-runtime/mcp/invocations");
type _AssertToolRuntimeLeafStillResolves = ToolRuntimeLeaf["resolveMcpToolIdentity"];

// The extensioned target means only the EXTENSIONLESS specifier above resolves.
// Pinning this keeps the pair honest: if the target ever loses its `.ts`, the
// spellings swap and this directive goes unused.
// @ts-expect-error - the `.ts` spelling does not resolve against a `*.ts` target.
type _ToolRuntimeLeafTs = typeof import("@alfred/assistant/tool-runtime/mcp/invocations.ts");
