/**
 * Compile-only fixture: the two MCP doors in `@alfred/assistant` and what each one enforces.
 * `connections/mcp` owns the client, session cache, and rows. `tool-runtime/mcp` owns invocation
 * and the ADR-0088 approval derivation. The connection side must not reach the approval side.
 * A self-reference resolves through this package's own `exports` map, like an outside caller.
 * It cannot see a workspace dependency edge, so an outside-consumer copy is still missing.
 */

// ---------------------------------------------------------------------------
// Both doors resolve, so a negative below cannot pass on a typo or a missing key.
// ---------------------------------------------------------------------------

type ConnectionsDoor = typeof import("@alfred/assistant/connections/mcp");

type ToolRuntimeDoor = typeof import("@alfred/assistant/tool-runtime/mcp");

type _AssertConnectionsDoorResolves = ConnectionsDoor["getMcpConnectionManager"];

type _AssertToolRuntimeDoorResolves = ToolRuntimeDoor["getMcpExecutionBroker"];

type _AssertClosedBuiltInDoor = ConnectionsDoor["ensureBuiltInConnection"];

type ConnectionPatch = Parameters<ConnectionsDoor["updateConnection"]>[1];

const _validConnectionPatch = { status: "ready" } satisfies ConnectionPatch;

// @ts-expect-error - OAuth owns credential attachment; the generic row patch cannot select one.
const _noCredentialSelection: ConnectionPatch = { credentialId: "mcpo_sibling" };

// Generic creation takes a caller-chosen endpoint and instance key. Only the closed built-in ensure is a door.
// @ts-expect-error - `ensureConnection` is not on the product barrel.
type _NoGenericEnsure = ConnectionsDoor["ensureConnection"];

// ---------------------------------------------------------------------------
// Door 1 is a real gate: `package.json` has exact keys `"./connections/mcp"` and
// `"./connections/mcp/test-support"`, and no `"./connections/*"` wildcard.
// A wildcard has two forms, and each republishes a different specifier:
//
//   "./connections/mcp/*": "./src/connections/mcp/*.ts"  -> the extensionless form resolves
//   "./connections/mcp/*": "./src/connections/mcp/*"     -> only the `.ts` form resolves
//
// Both spellings are pinned, so adding either form leaves a directive unused.
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
// The approval half is not on the connections door. `resolveMcpToolIdentity` is the
// fail-closed derivation the approval gate and the broker share (ADR-0088).
// ---------------------------------------------------------------------------

// @ts-expect-error - the ADR-0088 identity derivation belongs to `tool-runtime/mcp`.
type _NoIdentityOnConnections = ConnectionsDoor["resolveMcpToolIdentity"];

// @ts-expect-error - the crash-recovery ledger sweep belongs to `tool-runtime/mcp`.
type _NoReconcileOnConnections = ConnectionsDoor["reconcileInflightInvocations"];

// @ts-expect-error - the reviewed-downgrade risk resolver belongs to `tool-runtime/mcp`.
type _NoRiskOnConnections = ConnectionsDoor["resolveMcpCallRiskTier"];

// ---------------------------------------------------------------------------
// Four names sit behind `test-support`, not the product doors.
// `publishCatalogRevision` moves a catalog pointer with no compare-and-set.
// `upsertToolPolicy` mints the ADR-0088 reviewed downgrade.
// The two singleton setters are one per module, so replacing one leaves the other stale.
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

// @ts-expect-error - callers receive the canonical provider factory, not its constructor.
type _NoOAuthProviderConstructor = ConnectionsDoor["McpOAuthProvider"];

// @ts-expect-error - the reviewed-downgrade mint is test-support, not product surface.
type _NoPolicyMintOnToolRuntime = ToolRuntimeDoor["upsertToolPolicy"];

// @ts-expect-error - replacing the broker singleton is test-support, exactly like its manager twin.
type _NoBrokerSetterOnToolRuntime = ToolRuntimeDoor["_setMcpExecutionBrokerForTests"];

// ---------------------------------------------------------------------------
// Door 2 is a convention, not a gate: `"./tool-runtime/*": "./src/tool-runtime/*.ts"`
// republishes every leaf, whether `index.ts` names it or not.
// If that wildcard is narrowed, the positive assertion below fails.
// ---------------------------------------------------------------------------

// A successor resume must not share an HTTP request's lifetime, so its input has no `signal`.
type SuccessorResumeInput = import("@alfred/assistant/tool-runtime/mcp").McpReservedSuccessorInput;

type _NoSignalOnSuccessorResume = "signal" extends keyof SuccessorResumeInput ? never : true;

const _successorResumeHasNoSignal: _NoSignalOnSuccessorResume = true;

type ToolRuntimeLeaf = typeof import("@alfred/assistant/tool-runtime/mcp/invocations");

type _AssertToolRuntimeLeafStillResolves = ToolRuntimeLeaf["resolveMcpToolIdentity"];

// @ts-expect-error - callers cannot mint arbitrary lifecycle or successor state.
type _NoRawInvocationInsert = ToolRuntimeLeaf["insertInvocation"];

// @ts-expect-error - callers cannot patch arbitrary lifecycle or outcome state.
type _NoRawInvocationUpdate = ToolRuntimeLeaf["updateInvocation"];

// @ts-expect-error - normal reservation is broker-owned, not wildcard-reachable.
type _NoNormalReservation = ToolRuntimeLeaf["reserveMcpInvocation"];

// @ts-expect-error - the normal delivery claim is broker-owned and aggregate-guarded.
type _NoNormalDeliveryClaim = ToolRuntimeLeaf["markMcpInvocationDeliveryPossible"];

// @ts-expect-error - not-delivered settlement must also settle its staging barrier.
type _NoNormalNotDeliveredSettlement = ToolRuntimeLeaf["settleMcpInvocationNotDelivered"];

// @ts-expect-error - ambiguous settlement must also settle its staging barrier.
type _NoNormalAmbiguousSettlement = ToolRuntimeLeaf["blockMcpInvocationAsAmbiguous"];

// @ts-expect-error - success settlement must also settle its staging barrier.
type _NoNormalSuccessSettlement = ToolRuntimeLeaf["settleMcpInvocationSucceeded"];

// The wildcard republishes this leaf, so successor primitives must be absent from the module.
// Product code calls only the broker's ID-only `resumeReservedSuccessor`.
// @ts-expect-error - raw successor reads are module-private inside the broker owner.
type _NoRawSuccessorRead = ToolRuntimeLeaf["readReservedMcpSuccessor"];

// @ts-expect-error - raw successor delivery claims are module-private inside the broker owner.
type _NoRawSuccessorClaim = ToolRuntimeLeaf["claimReservedMcpSuccessorDelivery"];

// @ts-expect-error - raw successor settlement is module-private and guarded in the broker owner.
type _NoRawSuccessorSettlement = ToolRuntimeLeaf["settleReservedMcpSuccessor"];

// The `.ts` target means only the extensionless specifier resolves. If it loses `.ts`, this directive goes unused.
// @ts-expect-error - the `.ts` spelling does not resolve against a `*.ts` target.
type _ToolRuntimeLeafTs = typeof import("@alfred/assistant/tool-runtime/mcp/invocations.ts");
