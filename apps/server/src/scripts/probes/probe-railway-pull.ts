/**
 * Live probe for the verified pull (#1094). Performs one
 * `readRailwayDeploymentStatus` against a named target (or the first
 * discovered one) and prints the parsed status, Railway MCP readiness,
 * and whether the live catalog has the three required read tools.
 *
 *   $ pnpm --filter server tsx --env-file=<main-checkout>/apps/server/.env \
 *       src/scripts/probes/probe-railway-pull.ts <userId> [projectId serviceId environmentId]
 *
 * Requires a user id. Read-only; prints deployment ids and statuses, never tokens.
 */

import { closeConnections } from "@alfred/db";
import { isRecord } from "@alfred/contracts";
import {
  discoverRailwayTargets,
  readRailwayDeploymentStatus,
  readRailwayMcpReadiness,
  type RailwayPullTarget,
} from "@alfred/assistant/connections/verified-pull";
import {
  builtInProviderForEndpoint,
  getMcpConnectionManager,
  listOwnedConnections,
} from "@alfred/assistant/connections/mcp";

/**
 * Property and required names off a live tool `inputSchema`, read as
 * `unknown` at the protocol boundary. Anything unexpected reads empty, so a
 * shape change reports as a mismatch below instead of throwing here.
 */
function summarizeInputSchema(inputSchema: unknown) {
  if (!isRecord(inputSchema)) return { properties: [], required: [] };

  const properties = isRecord(inputSchema.properties) ? Object.keys(inputSchema.properties) : [];

  const required = Array.isArray(inputSchema.required)
    ? inputSchema.required.filter((entry): entry is string => typeof entry === "string")
    : [];

  return { properties, required };
}

async function main(): Promise<void> {
  const userId = process.argv[2];

  if (!userId)
    throw new Error("Usage: probe-railway-pull.ts <userId> [projectId serviceId environmentId]");
  const [projectId, serviceId, environmentId] = process.argv.slice(3);

  let target: RailwayPullTarget | null =
    projectId && serviceId && environmentId ? { projectId, serviceId, environmentId } : null;

  if (!target) {
    const discovered = await discoverRailwayTargets(userId);
    console.log(
      `discovered targets: ${discovered.length === 0 ? "(none)" : discovered.map((t) => `${t.projectId}/${t.serviceId}/${t.environmentId}`).join(", ")}`,
    );
    const [first] = discovered;
    target = first ?? null;

    if (!target) {
      console.log("no Railway targets discoverable: no credential, or no projects.");
    }
  } else {
    console.log(`target: ${target.projectId}/${target.serviceId}/${target.environmentId}`);
  }

  const readiness = await readRailwayMcpReadiness(userId);
  console.log(
    `mcp readiness: connected=${readiness.connected} issuerPinned=${readiness.issuerPinned}`,
  );

  if (target) {
    const parsed = await readRailwayDeploymentStatus(userId, target);

    if (!parsed) {
      console.log("parsed status: null (read failed, timed out, or unknown state)");
    } else {
      console.log(
        `parsed status: status=${parsed.status} deployment=${parsed.attemptId} providerEventTime=${parsed.providerEventTime?.toISOString() ?? "null"} url=${parsed.url ?? "null"}`,
      );
    }
  }

  const connections = await listOwnedConnections(userId);

  const railway = connections.find(
    (connection) => builtInProviderForEndpoint(connection.server.endpointUrl) === "railway",
  );

  if (!railway || readiness.connected !== true) {
    console.log("required MCP reads: unavailable (no authorized Railway MCP connection)");
  } else {
    try {
      const prepared = await getMcpConnectionManager().prepareToolCall(railway.id);
      const byName = new Map(prepared.catalog.tools.map((tool) => [tool.name, tool]));
      const required = ["list-projects", "list-services", "list-deployments"];
      const missing = required.filter((name) => !byName.has(name));

      console.log(
        `required MCP reads: ${missing.length ? `missing ${missing.join(", ")}` : "available"}`,
      );

      // Argument shapes, not just names: the pull calls `list-services` with
      // `{ projectId }` and `list-deployments` with `{ projectId, serviceId,
      // environmentId, limit }`. A renamed or newly-required property throws
      // `invalid_arguments` on every call, so the probe fails closed here
      // instead of the pull degrading to `unverified` forever.
      const expectedArgs = {
        "list-projects": { optional: [], required: [] },
        "list-services": { optional: [], required: ["projectId"] },
        "list-deployments": {
          optional: ["serviceId", "environmentId", "limit"],
          required: ["projectId"],
        },
      } as const;

      for (const [name, expected] of Object.entries(expectedArgs)) {
        const tool = byName.get(name);

        if (!tool) continue;

        const shape = summarizeInputSchema(tool.inputSchema);

        const absent = [...expected.required, ...expected.optional].filter(
          (arg) => !shape.properties.includes(arg),
        );

        const requiredGap = expected.required.filter((arg) => !shape.required.includes(arg));

        const ok = absent.length === 0 && requiredGap.length === 0;

        console.log(
          `MCP args ${name}: ${ok ? "ok" : `MISMATCH absent=[${absent.join(",")}] required-gap=[${requiredGap.join(",")}]`} (properties=[${shape.properties.join(",")}] required=[${shape.required.join(",")}])`,
        );
      }
    } catch (error) {
      console.log(
        `required MCP reads: unavailable (prepareToolCall failed: ${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  await closeConnections();
}

await main();

process.exit(0);
