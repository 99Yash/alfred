/**
 * Live probe for the cross-project Railway deployment activity sweep (the
 * `railway.recent_deployments` tool / `listRecentDeploymentsForCredentials`
 * fan-out). Confirms against the live API that (a) the connected credential can
 * list projects and (b) each project answers `list_deployments` — i.e. the
 * two-level fan-out is the right shape (Railway's `deployments` query needs a
 * projectId, so there is no flat "all deployments" call). Read-only.
 *
 *   $ pnpm --filter server tsx --env-file=.env \
 *       src/scripts/probes/probe-railway-recent-deployments.ts <userId>
 *
 * Defaults to the sole local user when no id is passed. Prints project + service
 * + status + createdAt per recent deployment; never prints the token.
 */

import { railwayListDeployments, railwayListProjects } from "@alfred/integrations/railway";
import { listActiveBearerCredentials } from "@alfred/integrations/shared";
import { closeConnections } from "@alfred/db";

async function main(): Promise<void> {
  const userId = process.argv[2] ?? "f3lTMg2DZzoR7KgGFtjUFNQvqwpUP0y4";
  const credentials = await listActiveBearerCredentials(userId, "railway");
  if (credentials.length === 0) {
    console.error(`No active Railway credential for user ${userId}.`);
    process.exit(1);
  }
  console.log(`Railway credentials: ${credentials.map((c) => c.accountLabel ?? c.id).join(", ")}`);

  const rows: Array<{
    project: string;
    service: string | null;
    status: string;
    createdAt: string | null;
    id: string;
    credential: string;
  }> = [];

  for (const credential of credentials) {
    const { projects } = await railwayListProjects(credential.accessToken);
    console.log(
      `\n[${credential.accountLabel ?? credential.id}] projects: ${projects
        .map((p) => p.name)
        .join(", ")}`,
    );
    for (const project of projects) {
      const serviceNameById = new Map(project.services.map((s) => [s.id, s.name]));
      const { deployments } = await railwayListDeployments({
        token: credential.accessToken,
        projectId: project.id,
        limit: 5,
      });
      for (const d of deployments) {
        rows.push({
          project: project.name,
          service: d.serviceId ? (serviceNameById.get(d.serviceId) ?? null) : null,
          status: d.status,
          createdAt: d.createdAt,
          id: d.id,
          credential: credential.accountLabel ?? credential.id,
        });
      }
    }
  }

  rows.sort((a, b) => {
    const at = a.createdAt ? Date.parse(a.createdAt) : NaN;
    const bt = b.createdAt ? Date.parse(b.createdAt) : NaN;
    return (Number.isNaN(bt) ? -Infinity : bt) - (Number.isNaN(at) ? -Infinity : at);
  });

  console.log(`\n=== recent deployments, newest first (${rows.length} total) ===`);
  for (const r of rows.slice(0, 15)) {
    console.log(
      `${r.createdAt ?? "(no time)"}  ${r.status.padEnd(10)}  ${r.project}/${r.service ?? "?"}  ${r.id}`,
    );
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => void closeConnections());
