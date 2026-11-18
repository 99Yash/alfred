/**
 * Code-owned `mcp_tool_policy` entries for built-in read tools (ADR-0096 amendment, 2026-11-13).
 * An entry binds one remote tool to one descriptor hash and grants the `low` tier and the `read`
 * effect class. A changed descriptor misses its entry, so the tool goes back to the `high` floor
 * and the effectful ledger path (fail closed). The gate also needs the published `readOnlyHint`.
 * An owner review of the tool, under any hash, wins over the entry (ADR-0096 sub-decisions 1, 2).
 * The pins live in `built-in-tool-pins.ts`. `pnpm --filter @alfred/assistant mcp:policy-drift`
 * lists the drift, and `--write` refreshes the pins for a review of the diff.
 */

import type {
  McpEffectClass,
  McpRetryContract,
  ToolOutputKind,
  ToolRiskTier,
} from "@alfred/contracts";
import { builtInProviderForEndpoint, builtInReadOnlyResource } from "./built-ins";
import { BUILT_IN_READ_TOOL_PINS, type BuiltInReadToolPins } from "./built-in-tool-pins";
import type { BuiltInProvider } from "./built-ins";

/** The fields of an `mcp_tool_policy` row that a code-owned entry sets. */
export interface BuiltInToolPolicy {
  readonly riskTier: ToolRiskTier;
  readonly effectClass: McpEffectClass;
  readonly retryContract: McpRetryContract;
  /** Alfred's declaration of the output (ADR-0124 amendment 2026-11-18). */
  readonly outputKind: ToolOutputKind;
}

/**
 * Every entry is a read. `low` is approval-free, as for the ADR-0096 structural branch. A read
 * skips the ambiguity barrier, so the retry contract is not read; `never` is the row default.
 */
const BUILT_IN_READ_POLICY: BuiltInToolPolicy = {
  riskTier: "low",
  effectClass: "read",
  retryContract: "never",
  outputKind: "structured",
};

/**
 * The pinned reads whose output is file content, not structured data. Drive's
 * `download_file_content` returns the bytes as base64 text, so no result block shows it.
 */
const BUILT_IN_BINARY_READS: ReadonlyMap<BuiltInProvider, readonly string[]> = new Map<
  BuiltInProvider,
  readonly string[]
>([["drive", ["download_file_content"]]]);

/** The read pins of one built-in, or `undefined` when it has none. */
export function builtInReadToolPinsOf(
  provider: BuiltInProvider,
): Readonly<Record<string, string>> | undefined {
  const pins: BuiltInReadToolPins = BUILT_IN_READ_TOOL_PINS;

  return pins[provider];
}

/** The entry for one exact descriptor of a built-in, or `undefined` for any doubt. */
export function builtInToolPolicy(
  endpointUrl: string,
  remoteName: string,
  descriptorHash: string,
): BuiltInToolPolicy | undefined {
  const provider = builtInProviderForEndpoint(endpointUrl);

  if (provider === undefined) return undefined;
  const pins = builtInReadToolPinsOf(provider);

  // `Object.hasOwn`: a remote name like `__proto__` must not read the prototype.
  if (pins === undefined || !Object.hasOwn(pins, remoteName)) return undefined;

  if (pins[remoteName] !== descriptorHash) return undefined;

  return BUILT_IN_BINARY_READS.get(provider)?.includes(remoteName)
    ? { ...BUILT_IN_READ_POLICY, outputKind: "binary" }
    : BUILT_IN_READ_POLICY;
}

/**
 * Alfred's declaration of a built-in tool's output, or `undefined` when it has none. A pinned
 * descriptor carries it in its entry. A tool of a read-only built-in endpoint (GitHub) is
 * structured: a binary block in its response fails by name at the script's read boundary.
 * Independent of an owner review: the review decides the effect, not the output.
 */
export function builtInOutputKind(
  endpointUrl: string,
  remoteName: string,
  descriptorHash: string,
): ToolOutputKind | undefined {
  const entry = builtInToolPolicy(endpointUrl, remoteName, descriptorHash);

  if (entry !== undefined) return entry.outputKind;

  return builtInReadOnlyResource(endpointUrl) ? "structured" : undefined;
}
