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
import {
  discoverRailwayTargets,
  readRailwayDeploymentStatus,
  readRailwayMcpReadiness,
  type RailwayPullTarget,
} from "@alfred/assistant/briefings/railway-pull";
import {
  builtInProviderForEndpoint,
  getMcpConnectionManager,
  listOwnedConnections,
} from "@alfred/assistant/connections/mcp";

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
        `parsed status: status=${parsed.status} deployment=${parsed.deploymentId} providerEventTime=${parsed.providerEventTime?.toISOString() ?? "null"} url=${parsed.url ?? "null"}`,
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
      const names = new Set(prepared.catalog.tools.map((tool) => tool.name));
      const required = ["list-projects", "list-services", "list-deployments"];
      const missing = required.filter((name) => !names.has(name));
      console.log(
        `required MCP reads: ${missing.length ? `missing ${missing.join(", ")}` : "available"}`,
      );
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
