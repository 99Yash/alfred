/**
 * Code-owned `mcp_tool_policy` entries for built-in read tools (ADR-0096 amendment, 2026-11-13).
 * An entry binds one remote tool to one descriptor hash and grants the `low` tier, the `read`
 * effect class, and the `ordinary` read class (ADR-0130 decision 1). A changed descriptor misses
 * its entry, so the tool goes back to the `high` floor and the effectful ledger path, or for a
 * read-only endpoint to its integration's default class (fail closed). The gate also needs the
 * published `readOnlyHint`.
 * An owner review of the tool, under any hash, wins over the entry (ADR-0096 sub-decisions 1, 2).
 * The pins live in `built-in-tool-pins.ts`. `pnpm --filter @alfred/assistant mcp:policy-drift`
 * lists the drift, and `--write` refreshes the pins for a review of the diff.
 */

import {
  BUILT_IN_MCP_CATALOG,
  INTEGRATIONS,
  type McpEffectClass,
  type McpRetryContract,
  type ToolOutputKind,
  type ToolReadClass,
  type ToolRiskTier,
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
 * Every entry is a read. `low` is the tier of the ADR-0096 structural branch. `low` alone is not
 * approval-free: under `gated` the read class decides (ADR-0130 decision 1). A read skips the
 * ambiguity barrier, so the retry contract is not read; `never` is the row default.
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

/**
 * The reads of a built-in that can return a secret (ADR-0130 decision 1), by name under any
 * descriptor. Such a read is `secret` even with a pin, and the drift tool never pins it.
 * GitHub's `run_secret_scanning` returns the secrets that it finds.
 */
export const BUILT_IN_SECRET_READS: ReadonlyMap<BuiltInProvider, readonly string[]> = new Map<
  BuiltInProvider,
  readonly string[]
>([["github", ["run_secret_scanning"]]]);

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

/**
 * The read class of one exact descriptor of a built-in (ADR-0130 decision 1), or `undefined`
 * when no code classifies it. A name in `BUILT_IN_SECRET_READS` is `secret`. A pinned descriptor
 * is `ordinary`, because a pin is code's review of that exact descriptor. Any other descriptor
 * gets its integration's default, so a drifted GitHub pin is `secret` and asks. A user-added
 * server has no class. The class matters only for a confirmed read.
 */
export function builtInReadClass(
  endpointUrl: string,
  remoteName: string,
  descriptorHash: string,
): ToolReadClass | undefined {
  const provider = builtInProviderForEndpoint(endpointUrl);

  if (provider === undefined) return undefined;

  if (BUILT_IN_SECRET_READS.get(provider)?.includes(remoteName)) return "secret";

  if (builtInToolPolicy(endpointUrl, remoteName, descriptorHash) !== undefined) return "ordinary";

  return INTEGRATIONS[BUILT_IN_MCP_CATALOG[provider].slug].readClassDefault ?? undefined;
}
