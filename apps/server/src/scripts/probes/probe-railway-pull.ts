/**
 * Live probe for the verified pull (#1094). Performs one
 * `readRailwayDeploymentStatus` against a named target (or the first
 * discovered one) and prints the parsed status, the Railway MCP connection
 * readiness, and the live MCP catalog's status-capable tool name — or
 * `no-status-tool` when no authorized connection exists yet (the GraphQL
 * fallback shipped, so that is the expected line until the human completes
 * OAuth consent).
 *
 *   $ pnpm --filter server tsx --env-file=<main-checkout>/apps/server/.env \
 *       src/scripts/probes/probe-railway-pull.ts <userId> [projectId serviceId environmentId]
 *
 * Defaults to the sole local user when no id is passed. Read-only; prints
 * deployment ids and statuses, never tokens.
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
  const userId = process.argv[2] ?? "f3lTMg2DZzoR7KgGFtjUFNQvqwpUP0y4";
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
    console.log("status-capable MCP tool: no-status-tool (no authorized Railway MCP connection)");
  } else {
    try {
      const prepared = await getMcpConnectionManager().prepareToolCall(railway.id);
      const names = prepared.catalog.tools.map((tool) => tool.name);
      const statusCapable = names.filter((name) => /deploy|status/i.test(name));
      console.log(`catalog tools (${names.length}): ${names.join(", ") || "(empty)"}`);
      console.log(
        `status-capable MCP tool: ${statusCapable.length === 0 ? "no-status-tool" : statusCapable.join(", ")}`,
      );
    } catch (error) {
      console.log(
        `status-capable MCP tool: no-status-tool (prepareToolCall failed: ${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  await closeConnections();
}

await main();
