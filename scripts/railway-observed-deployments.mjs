// The deploy job stops when the release fails, and a stop can leave the two
// services on different releases (ADR-0128). The owner then needs to know,
// per service, what is active and whether this run's submission was accepted
// before recovering. This script reads that answer from Railway's live
// GraphQL API — the owner of the fact — and prints:
//
// - the active deployments (the releases that serve; an active deployment can
//   be SLEEPING and still serve),
// - the latest attempt, which can be a failed or building one,
// - and, when the unique deploy message matches a deployment, the deployment
//   that accepted this run's upload (the provider logs the message —
//   `deployAttemptId` in the patched provider — before each submission;
//   Railway keeps it as the deployment's `meta.cliMessage`).
//
// When a read cannot prove a deployment, it reports "unknown"; it never
// names a release it did not see, and it never reports a service absent
// before the complete service page was read without errors. Every
// diagnostic is bounded and the script returns normally: the report is the
// recovery basis, so one large provider error must not drown the other
// service's lines and the step must not die on one failed read.
//
// The production target is the one declaration the infra program also reads
// (infra/src/target.ts); Node 26, the deploy workflow's runtime, strips the
// types on import.

import { PROJECT_ID, PRODUCTION_ENVIRONMENT_ID, PRODUCTION_SERVICES } from "../infra/src/target.ts";

const API_URL = "https://backboard.railway.app/graphql/v2";

/** The read is one query; the deadline keeps a stuck edge from holding the job. */
const DEADLINE_MS = 15_000;

/** Bounded diagnostics: one large provider error must not flood the report. */
const MAX_DIAGNOSTIC_CHARS = 400;

/** The service page bound: 50 instances per page, 10 pages — production
 * carries a fraction of one page, and a bound keeps a paging edge from
 * holding the job. Past it, absence is not proven. */
const MAX_SERVICE_PAGES = 10;

/** The recent-deployments read the attempt match searches. */
const MAX_MATCH_DEPLOYMENTS = 20;

/**
 * One deployment as the report reads it.
 *
 * @typedef {object} Deployment
 * @property {string} id
 * @property {string} status
 * @property {string} createdAt
 * @property {string | undefined} staticUrl
 */

/**
 * One service instance as the report reads it.
 *
 * @typedef {object} ServiceNode
 * @property {string | undefined} serviceName
 * @property {string | undefined} serviceId
 * @property {Deployment[]} active
 * @property {boolean} activeProven
 * @property {Deployment | undefined} latest
 */

/**
 * @typedef {object} ServicePage
 * @property {ServiceNode[]} nodes
 * @property {string[]} messages
 * @property {boolean} complete
 */

// The script ships with no dependencies (the deploy job installs only the
// infra workspace), so the boundary parse is a hand reader over the parsed
// JSON. These guards are the I/O boundary: everything downstream branches on
// the values they prove, never on the wire's representation.

/**
 * A plain JSON object.
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isObjectRecord = (value) =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- walks Railway's GraphQL response; the parsed body is the untrusted value and this script installs no schema dependency to parse it with
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * A string.
 *
 * @param {unknown} value
 * @returns {value is string}
 */
const isText = (value) =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- same boundary: Railway's GraphQL response is the untrusted value
  typeof value === "string";

/**
 * The deploy message token the provider logged before this run's submission.
 * CI names it from the run id and attempt number, the same env the provider
 * reads, so a re-run never shares a message with the run it recovers.
 * Undefined on a run without it: the match is then unavailable, not failed.
 */
const attemptToken = () => {
  const run = process.env.GITHUB_RUN_ID;
  const attempt = process.env.GITHUB_RUN_ATTEMPT;

  return run && attempt ? `run-${run}-${attempt}` : undefined;
};

/**
 * Bound a diagnostic to one line and the cap, so a large provider error
 * cannot flood the report or drop the lines after it.
 *
 * @param {string | Error} text
 */
const bound = (text) => {
  const line = (text instanceof Error ? text.message : text).replace(/\s+/g, " ").trim();

  return line.length > MAX_DIAGNOSTIC_CHARS ? `${line.slice(0, MAX_DIAGNOSTIC_CHARS)}…` : line;
};

/**
 * The text of a caught error, bounded. A thrown reason rides the report only
 * as its bounded message.
 *
 * @param {unknown} error
 * @returns {string}
 */
const errorText = (error) => {
  if (error instanceof Error) return bound(error.message);

  return bound(JSON.stringify(error) || "unknown failure");
};

/**
 * Report one service whose deployment stays unproven, and mark it in the
 * workflow annotations so the gap is visible without failing the job.
 *
 * @param {string} service
 * @param {string} reason
 */
const unknown = (service, reason) => {
  console.log(`${service}: unknown — ${bound(reason)}`);
  console.log(`::warning::Railway deployment for ${service} stays unproven: ${bound(reason)}`);
};

/**
 * One GraphQL read. Returns a failure reason instead of throwing, so one
 * failed read cannot kill the report.
 *
 * @param {string} token
 * @param {string} query
 * @param {Record<string, unknown>} variables
 * @returns {Promise<{success: {data: unknown; messages: string[]}} | {failure: string}>}
 */
const graphql = async (token, query, variables) => {
  /** @type {Response | undefined} */
  let response;

  try {
    response = await fetch(API_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(DEADLINE_MS),
    });
  } catch (error) {
    return { failure: `the Railway GraphQL read failed: ${errorText(error)}` };
  }

  if (!response.ok) {
    return { failure: `Railway GraphQL answered HTTP ${response.status}` };
  }

  /** @type {unknown} */
  let payload;

  try {
    payload = await response.json();
  } catch (error) {
    return { failure: `the Railway GraphQL body did not parse: ${errorText(error)}` };
  }

  // Parse the envelope at the boundary. A valid JSON response without the
  // fields the report reads must not read as data — the parse returns no
  // record and the caller reports unknown, not absence. GraphQL errors ride
  // along: with partial data the report uses what is present and cites the
  // errors for what is not.
  if (!isObjectRecord(payload)) {
    return { failure: "the Railway GraphQL body is not a GraphQL envelope" };
  }

  const envelope = payload;
  const errorList = Array.isArray(envelope.errors) ? envelope.errors : [];

  const messages = errorList
    .map((error) => {
      if (!isObjectRecord(error)) return undefined;

      return isText(error.message) ? error.message : undefined;
    })
    .filter((message) => message !== undefined);

  return { success: { data: envelope.data ?? null, messages } };
};

const SERVICE_PAGE_QUERY = /* GraphQL */ `
  query ServicePage($id: String!, $after: String) {
    environment(id: $id) {
      serviceInstances(first: 50, after: $after) {
        edges {
          node {
            serviceId
            serviceName
            activeDeployments {
              id
              status
              createdAt
              staticUrl
            }
            latestDeployment {
              id
              status
              createdAt
              staticUrl
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

const DEPLOY_MESSAGES_QUERY = /* GraphQL */ `
  query DeployMessages($input: DeploymentListInput!) {
    deployments(input: $input, first: ${MAX_MATCH_DEPLOYMENTS}) {
      id
      status
      createdAt
      meta
    }
  }
`;

/**
 * Parse one deployment as the report reads it. A deployment the response
 * does not name is not one the report can use.
 *
 * @param {unknown} value
 * @returns {Deployment | undefined}
 */
const parseDeployment = (value) => {
  if (!isObjectRecord(value)) return undefined;

  const { id, status, createdAt, staticUrl } = value;

  if (!isText(id) || id.length === 0) return undefined;

  return {
    id,
    status: isText(status) ? status : "unknown",
    createdAt: isText(createdAt) ? createdAt : "unknown",
    staticUrl: isText(staticUrl) ? staticUrl : undefined,
  };
};

/**
 * Parse one service-instance node as the report reads it.
 *
 * @param {unknown} value
 * @returns {ServiceNode | undefined}
 */
const parseServiceNode = (value) => {
  if (!isObjectRecord(value)) return undefined;

  const activeList = Array.isArray(value.activeDeployments) ? value.activeDeployments : undefined;

  const active = (activeList ?? [])
    .map(parseDeployment)
    .filter((deployment) => deployment !== undefined);

  return {
    serviceName: isText(value.serviceName) ? value.serviceName : undefined,
    serviceId: isText(value.serviceId) ? value.serviceId : undefined,
    active,
    activeProven: activeList !== undefined,
    latest: parseDeployment(value.latestDeployment),
  };
};

/**
 * Read every service instance of the production environment, paginating
 * until the page ends: a service outside the first page is not proven
 * absent. Returns the parsed nodes, the GraphQL error messages seen on the
 * way, and whether the page chain completed — absence is provable only then.
 *
 * @param {string} token
 * @returns {Promise<{success: ServicePage} | {failure: string}>}
 */
const listServiceNodes = async (token) => {
  /** @type {ServiceNode[]} */
  const nodes = [];

  /** @type {string[]} */
  const messages = [];

  /** @type {string | undefined} */
  let after;

  for (let page = 0; page < MAX_SERVICE_PAGES; page += 1) {
    const result = await graphql(token, SERVICE_PAGE_QUERY, {
      id: PRODUCTION_ENVIRONMENT_ID,
      after,
    });

    if ("failure" in result) return result;

    // A response without the connection — `edges: {}` among them — proves
    // nothing: every service reports unknown, not absent.
    if (!isObjectRecord(result.success.data)) {
      return {
        failure:
          result.success.messages.length > 0
            ? `Railway GraphQL returned errors: ${result.success.messages.join("; ")}`
            : "the response carries no data",
      };
    }

    const instances = isObjectRecord(result.success.data.environment)
      ? result.success.data.environment.serviceInstances
      : undefined;

    const edges = isObjectRecord(instances) ? instances.edges : undefined;

    // A response without the connection — `edges: {}` among them — proves
    // nothing: every service reports unknown, not absent.
    if (!Array.isArray(edges)) {
      return {
        failure:
          result.success.messages.length > 0
            ? `Railway GraphQL returned errors: ${result.success.messages.join("; ")}`
            : "the serviceInstances connection is missing from the response",
      };
    }

    for (const edge of edges) {
      const node = isObjectRecord(edge) ? edge.node : undefined;
      const parsed = parseServiceNode(node);

      if (parsed !== undefined) nodes.push(parsed);
    }

    messages.push(...result.success.messages);

    const info =
      isObjectRecord(instances) && isObjectRecord(instances.pageInfo)
        ? instances.pageInfo
        : undefined;

    if (info?.hasNextPage === true && isText(info.endCursor)) {
      after = info.endCursor;
      continue;
    }

    return { success: { nodes, messages, complete: true } };
  }

  return { success: { nodes, messages, complete: false } };
};

/**
 * The recent deployments of the environment with their meta, for the attempt
 * match. A failed read is reported as an unavailable match, never as
 * acceptance or refusal.
 *
 * @param {string} token
 * @returns {Promise<{success: Record<string, unknown>[]} | {failure: string}>}
 */
const listDeployments = async (token) => {
  const result = await graphql(token, DEPLOY_MESSAGES_QUERY, {
    input: { projectId: PROJECT_ID, environmentId: PRODUCTION_ENVIRONMENT_ID },
  });

  if ("failure" in result) return result;

  if (!isObjectRecord(result.success.data) || !Array.isArray(result.success.data.deployments)) {
    return {
      failure:
        result.success.messages.length > 0
          ? `Railway GraphQL returned errors: ${result.success.messages.join("; ")}`
          : "the deployments list is missing from the response",
    };
  }

  const deployments = result.success.data.deployments.filter(isObjectRecord);

  return { success: deployments };
};

/**
 * Match this run's submission against the deployment that accepted it. A
 * match identifies the deployment; an absent match leaves the outcome
 * unknown.
 *
 * @param {Record<string, unknown>[]} deployments
 * @param {string} serviceId
 * @returns {{state: "unavailable"; reason: string} | {state: "absent"; reason: string} | {state: "accepted"; token: string; deployments: Record<string, unknown>[]}}
 */
const matchAttempt = (deployments, serviceId) => {
  const wanted = attemptToken();

  if (wanted === undefined) {
    return { state: "unavailable", reason: "the run's attempt id is not in the environment" };
  }

  const matched = deployments.filter((deployment) => {
    if (deployment.serviceId !== serviceId) return false;

    const meta = isObjectRecord(deployment.meta) ? deployment.meta : undefined;

    return isText(meta?.cliMessage) && meta.cliMessage.includes(wanted);
  });

  if (matched.length === 0) {
    return {
      state: "absent",
      reason: `no deployment of the latest ${deployments.length} carries the deploy message ${wanted}`,
    };
  }

  return { state: "accepted", token: wanted, deployments: matched };
};

/**
 * One deployment line of the report.
 *
 * @param {string} service
 * @param {string} kind
 * @param {Deployment} deployment
 */
const deploymentLine = (service, kind, deployment) => {
  const url = deployment.staticUrl === undefined ? "" : ` url=${deployment.staticUrl}`;

  console.log(
    `${service}: ${kind} ${deployment.id} status=${deployment.status}` +
      ` createdAt=${deployment.createdAt}${url}`,
  );
};

/**
 * Report one service: what serves (every active deployment, not the newest
 * attempt — a failed or building attempt can be the latest while an older
 * release serves), the latest attempt, and whether this run's upload was
 * accepted.
 *
 * @param {string} service
 * @param {ServiceNode} node
 * @param {string[]} messages
 * @param {{success: Record<string, unknown>[]} | {failure: string}} deployments
 */
const reportService = (service, node, messages, deployments) => {
  const cite =
    messages.length > 0
      ? `Railway GraphQL returned errors, so the read is partial: ${messages.join("; ")}`
      : undefined;

  if (!node.activeProven) {
    unknown(service, cite ?? "the response carries no activeDeployments for the service");
  } else if (node.active.length === 0) {
    console.log(`${service}: no active deployment — nothing serves`);
  } else {
    for (const deployment of node.active) {
      deploymentLine(service, "active deployment", deployment);
    }
  }

  if (node.latest === undefined) {
    unknown(service, cite ?? "the service shows no deployment");
  } else {
    deploymentLine(service, "latest attempt", node.latest);
  }

  if ("failure" in deployments) {
    unknown(service, `the attempt match is unavailable: ${deployments.failure}`);

    return;
  }

  if (node.serviceId === undefined) {
    unknown(service, cite ?? "the response carries no serviceId for the service");

    return;
  }

  const match = matchAttempt(deployments.success, node.serviceId);

  if (match.state === "accepted") {
    for (const deployment of match.deployments) {
      const id = isText(deployment.id) ? deployment.id : "unknown";
      const status = isText(deployment.status) ? deployment.status : "unknown";

      console.log(
        `${service}: this run's submission (${match.token}) was accepted as deployment ${id}` +
          ` status=${status}`,
      );
    }
  } else {
    unknown(
      service,
      match.state === "unavailable"
        ? `the attempt match is unavailable: ${match.reason}`
        : `no accepted submission for this run is provable: ${match.reason}`,
    );
  }
};

const main = async () => {
  const token = process.env.RAILWAY_API_TOKEN;

  if (!token) {
    for (const service of PRODUCTION_SERVICES) unknown(service, "RAILWAY_API_TOKEN is not set");

    return;
  }

  const pages = await listServiceNodes(token);

  if ("failure" in pages) {
    for (const service of PRODUCTION_SERVICES) unknown(service, pages.failure);

    return;
  }

  const deployments = attemptToken() === undefined ? { success: [] } : await listDeployments(token);

  const byService = new Map(pages.success.nodes.map((node) => [node.serviceName, node]));

  for (const service of PRODUCTION_SERVICES) {
    const node = byService.get(service);

    if (node === undefined) {
      // Absence is a fact only when the page chain completed without errors;
      // otherwise the service may be outside the pages that were read.
      unknown(
        service,
        pages.success.messages.length > 0
          ? `Railway GraphQL returned errors, so absence is not proven: ${pages.success.messages.join("; ")}`
          : pages.success.complete
            ? "the service is not in the production environment"
            : "the service page did not finish, so absence is not proven",
      );
      continue;
    }

    reportService(service, node, pages.success.messages, deployments);
  }
};

await main();
