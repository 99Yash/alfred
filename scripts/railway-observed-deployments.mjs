// The deploy job stops when the release fails, and a stop can leave the two
// services on different releases (ADR-0128). The owner then needs to know which
// release each service carries before recovering. This script reads that answer
// from Railway's live GraphQL API — the owner of the fact — and prints the
// observed deployment per service. When the read cannot prove a deployment, it
// reports "unknown"; it never names a release it did not see. The deploy
// workflow runs it with `if: always()`, so a failed deploy still reports.
//
// The environment id is the constant the infra program declares in
// `infra/src/project.ts`. A change there must move here too.

const ENVIRONMENT_ID = "9fbd12bc-6b88-430f-ac88-3ce71b60714b";

/** The services the infra program declares (infra/src/services.ts). */
const SERVICES = ["server", "web"];

const API_URL = "https://backboard.railway.app/graphql/v2";

/** The read is one query; the deadline keeps a stuck edge from holding the job. */
const DEADLINE_MS = 15_000;

const query = `
  query ObservedDeployments($id: String!) {
    environment(id: $id) {
      serviceInstances(first: 50) {
        edges {
          node {
            serviceName
            latestDeployment {
              id
              status
              createdAt
              staticUrl
            }
          }
        }
      }
    }
  }
`;

/**
 * Report one service whose deployment stays unproven, and mark it in the
 * workflow annotations so the gap is visible without failing the job.
 *
 * @param {string} service
 * @param {string} reason
 */
const unknown = (service, reason) => {
  console.log(`${service}: unknown — ${reason}`);
  console.log(`::warning::Railway deployment for ${service} stays unproven: ${reason}`);
};

/**
 * Report every service as unknown, then stop.
 *
 * @param {(service: string) => void} report
 */
const allUnknown = (report) => {
  for (const service of SERVICES) report(service);
  process.exit(0);
};

const main = async () => {
  const token = process.env.RAILWAY_API_TOKEN;

  if (!token) {
    return allUnknown((service) => unknown(service, "RAILWAY_API_TOKEN is not set"));
  }

  /** @type {Response | undefined} */
  let response;

  try {
    response = await fetch(API_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, variables: { id: ENVIRONMENT_ID } }),
      signal: AbortSignal.timeout(DEADLINE_MS),
    });
  } catch (error) {
    return allUnknown((service) =>
      unknown(service, `the Railway GraphQL read failed: ${String(error)}`),
    );
  }

  if (!response.ok) {
    return allUnknown((service) =>
      unknown(service, `Railway GraphQL answered HTTP ${String(response.status)}`),
    );
  }

  /** @type {any} */
  let payload;

  try {
    payload = await response.json();
  } catch (error) {
    return allUnknown((service) =>
      unknown(service, `the Railway GraphQL body did not parse: ${String(error)}`),
    );
  }

  const errors = Array.isArray(payload?.errors) ? payload.errors : [];

  if (errors.length > 0) {
    const reason = errors
      .map((/** @type {any} */ e) => e?.message)
      .filter(Boolean)
      .join("; ");

    return allUnknown((service) => unknown(service, `Railway GraphQL returned errors: ${reason}`));
  }

  /** @type {any[]} */
  const nodes =
    payload?.data?.environment?.serviceInstances?.edges?.map(
      (/** @type {any} */ edge) => edge?.node,
    ) ?? [];

  const byService = new Map(nodes.map((node) => [node?.serviceName, node]));

  for (const service of SERVICES) {
    const node = byService.get(service);
    const deployment = node?.latestDeployment;

    if (!deployment?.id) {
      unknown(
        service,
        node === undefined
          ? "the service is not in the production environment"
          : "the service shows no deployment",
      );
      continue;
    }

    const url = String(deployment.staticUrl ?? "");

    console.log(
      `${service}: observed deployment ${deployment.id} status=${deployment.status}` +
        ` createdAt=${deployment.createdAt}${url ? ` url=${url}` : ""}`,
    );
  }
};

await main();
