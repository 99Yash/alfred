import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  railwayGetLogsInput,
  railwayListDeploymentsInput,
  railwayRecentDeploymentsInput,
  railwayRedeployInput,
} from "@alfred/contracts";
import {
  RailwayGraphqlError,
  railwayListProjects,
  railwayValidateToken,
  type RailwayDeployment,
  type RailwayProject,
} from "@alfred/integrations/railway";
import type { ActiveBearerCredential } from "@alfred/integrations/shared";

import {
  listProjectsForCredentials,
  listRecentDeploymentsForCredentials,
  pickCredential,
} from "../../src/modules/tools/railway-fanout";

interface RecordedGraphqlRequest {
  query: string;
  variables?: Record<string, unknown>;
}

interface QueuedResponse {
  status?: number;
  body: unknown;
}

async function withMockedRailwayFetch<T>(
  responses: QueuedResponse[],
  run: (calls: RecordedGraphqlRequest[]) => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  const calls: RecordedGraphqlRequest[] = [];
  const queue = [...responses];
  const mockedFetch: typeof fetch = async (_input, init) => {
    const next = queue.shift();
    if (!next) throw new Error("unexpected Railway fetch");
    const request: RecordedGraphqlRequest = JSON.parse(String(init?.body));
    calls.push(request);
    return new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  globalThis.fetch = mockedFetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function projectNode(
  id: string,
  name: string,
): {
  id: string;
  name: string;
  services: { edges: Array<{ node: { id: string; name: string } }> };
  environments: { edges: Array<{ node: { id: string; name: string } }> };
} {
  return {
    id,
    name,
    services: { edges: [] },
    environments: { edges: [] },
  };
}

function projectIds(projects: RailwayProject[]): string[] {
  return projects.map((project) => project.id);
}

const notAuthorized: QueuedResponse = {
  body: { data: null, errors: [{ message: "Not Authorized" }] },
};

describe("Railway token validation", () => {
  test("validates account tokens via me", async () => {
    await withMockedRailwayFetch(
      [{ body: { data: { me: { id: "u1", name: "Yash", email: "y@x.com" } } } }],
      async (calls) => {
        const account = await railwayValidateToken("tok_account");
        assert.deepEqual(account, { id: "u1", name: "Yash", email: "y@x.com" });
        assert.equal(calls.length, 1);
        assert.match(calls[0]?.query ?? "", /me \{ id name email \}/);
      },
    );
  });

  test("validates workspace tokens with a stable workspace id via introspection", async () => {
    await withMockedRailwayFetch(
      [
        notAuthorized,
        { body: { data: { apiToken: { workspaces: [{ id: "ws_123", name: "Acme" }] } } } },
      ],
      async (calls) => {
        const account = await railwayValidateToken("tok_workspace");

        assert.deepEqual(account, { id: "workspace:ws_123", name: "Acme", email: null });
        assert.equal(calls.length, 2);
        assert.match(calls[0]?.query ?? "", /me \{ id name email \}/);
        assert.match(calls[1]?.query ?? "", /apiToken \{ workspaces \{ id name \} \}/);
      },
    );
  });

  test("names a workspace token by its workspace, falling back to the id when unnamed", async () => {
    await withMockedRailwayFetch(
      [
        notAuthorized,
        { body: { data: { apiToken: { workspaces: [{ id: "ws_123", name: null }] } } } },
      ],
      async () => {
        const account = await railwayValidateToken("tok_workspace");
        assert.deepEqual(account, {
          id: "workspace:ws_123",
          name: "Railway workspace ws_123",
          email: null,
        });
      },
    );
  });

  test("ignores ambiguous multi-workspace introspection and falls back to the projects team", async () => {
    await withMockedRailwayFetch(
      [
        notAuthorized,
        {
          body: {
            data: {
              apiToken: {
                workspaces: [
                  { id: "w1", name: "One" },
                  { id: "w2", name: "Two" },
                ],
              },
            },
          },
        },
        {
          body: {
            data: { projects: { edges: [{ node: { team: { id: "team_9", name: "Acme" } } }] } },
          },
        },
      ],
      async () => {
        const account = await railwayValidateToken("tok_multi");
        assert.deepEqual(account, { id: "team:team_9", name: "Acme", email: null });
      },
    );
  });

  test("falls back to the projects team identity when introspection errors (never rejects a valid token over a schema guess)", async () => {
    await withMockedRailwayFetch(
      [
        notAuthorized,
        {
          body: {
            data: null,
            errors: [{ message: 'Cannot query field "workspaces" on type "ApiTokenContext"' }],
          },
        },
        {
          body: {
            data: { projects: { edges: [{ node: { team: { id: "team_9", name: "Acme" } } }] } },
          },
        },
      ],
      async (calls) => {
        const account = await railwayValidateToken("tok_workspace");
        assert.deepEqual(account, { id: "team:team_9", name: "Acme", email: null });
        assert.match(calls[1]?.query ?? "", /apiToken \{ workspaces \{ id name \} \}/);
        assert.match(calls[2]?.query ?? "", /projects \{ edges \{ node \{ team/);
      },
    );
  });

  test("accepts a team-less workspace token with a synthetic token-fingerprint identity", async () => {
    await withMockedRailwayFetch(
      [
        notAuthorized,
        { body: { data: { apiToken: { workspaces: [] } } } },
        { body: { data: { projects: { edges: [{ node: { team: null } }] } } } },
      ],
      async () => {
        const account = await railwayValidateToken("tok_teamless");
        assert.match(account.id, /^workspace-token:[0-9a-f]{16}$/);
        assert.equal(account.name, "Railway workspace");
        assert.equal(account.email, null);
      },
    );
  });

  test("two distinct team-less tokens get distinct synthetic ids (no upsert collision)", async () => {
    const idFor = async (token: string): Promise<string> =>
      withMockedRailwayFetch(
        [
          notAuthorized,
          { body: { data: { apiToken: { workspaces: [] } } } },
          { body: { data: { projects: { edges: [{ node: { team: null } }] } } } },
        ],
        async () => (await railwayValidateToken(token)).id,
      );
    const first = await idFor("tok_teamless_one");
    const second = await idFor("tok_teamless_two");
    assert.notEqual(first, second);
    // Same token reconnecting stays idempotent (same id → in-place upsert).
    assert.equal(await idFor("tok_teamless_one"), first);
  });

  test("rejects a token that can neither introspect nor list projects", async () => {
    await withMockedRailwayFetch(
      [notAuthorized, { body: { data: { apiToken: { workspaces: [] } } } }, notAuthorized],
      async () => {
        await assert.rejects(() => railwayValidateToken("tok_project"), /Not Authorized/);
      },
    );
  });

  test("does not treat upstream failures as workspace-token fallback", async () => {
    await withMockedRailwayFetch(
      [{ status: 503, body: "temporarily unavailable" }],
      async (calls) => {
        await assert.rejects(() => railwayValidateToken("tok_account"), /503/);
        assert.equal(calls.length, 1);
      },
    );
  });
});

describe("Railway project listing", () => {
  test("unions account workspace projects with top-level projects", async () => {
    await withMockedRailwayFetch(
      [
        {
          body: {
            data: {
              me: {
                workspaces: [
                  {
                    team: {
                      projects: {
                        edges: [{ node: projectNode("project_1", "Workspace project") }],
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        {
          body: {
            data: {
              projects: {
                edges: [
                  { node: projectNode("project_1", "Workspace project duplicate") },
                  { node: projectNode("project_2", "Personal project") },
                ],
              },
            },
          },
        },
      ],
      async () => {
        const result = await railwayListProjects("tok_account");

        assert.deepEqual(projectIds(result.projects), ["project_1", "project_2"]);
        assert.equal(result.projects[0]?.name, "Workspace project");
      },
    );
  });

  test("lists projects for workspace tokens after the account path is unauthorized", async () => {
    await withMockedRailwayFetch(
      [
        notAuthorized,
        {
          body: {
            data: {
              projects: { edges: [{ node: projectNode("project_workspace", "Workspace scoped") }] },
            },
          },
        },
      ],
      async (calls) => {
        const result = await railwayListProjects("tok_workspace");

        assert.deepEqual(projectIds(result.projects), ["project_workspace"]);
        assert.match(calls[0]?.query ?? "", /me/);
        assert.match(calls[1]?.query ?? "", /projects/);
      },
    );
  });

  test("keeps me-path projects when the additive top-level query fails transiently", async () => {
    await withMockedRailwayFetch(
      [
        {
          body: {
            data: {
              me: {
                workspaces: [
                  { team: { projects: { edges: [{ node: projectNode("project_1", "P1") }] } } },
                ],
              },
            },
          },
        },
        { status: 503, body: "temporarily unavailable" },
      ],
      async () => {
        const result = await railwayListProjects("tok_account");
        assert.deepEqual(projectIds(result.projects), ["project_1"]);
      },
    );
  });
});

function cred(id: string, label: string | null): ActiveBearerCredential {
  return {
    id,
    accessToken: `tok_${id}`,
    accountId: `acct_${id}`,
    accountLabel: label,
    metadata: {},
  };
}

function proj(id: string, name = id): RailwayProject {
  return { id, name, services: [], environments: [] };
}

const authz = (): RailwayGraphqlError => new RailwayGraphqlError([{ message: "Not Authorized" }]);

describe("Railway credential fan-out", () => {
  test("pickCredential defaults to the sole connection when none is named", () => {
    assert.equal(pickCredential([cred("a", "A")]).id, "a");
  });

  test("pickCredential requires an explicit choice when several are connected", () => {
    assert.throws(
      () => pickCredential([cred("a", "A"), cred("b", "B")]),
      /Choose an active Railway credential/,
    );
  });

  test("pickCredential resolves a named credential and rejects an unknown id", () => {
    assert.equal(pickCredential([cred("a", "A"), cred("b", "B")], "b").id, "b");
    assert.throws(
      () => pickCredential([cred("a", "A")], "zzz"),
      /Choose an active Railway credential/,
    );
  });

  test("de-dupes projects across credentials (first wins) and tags provenance", async () => {
    const byToken: Record<string, RailwayProject[]> = {
      tok_a: [proj("p1", "from-a")],
      tok_b: [proj("p1", "from-b"), proj("p2")],
    };
    const { projects, failures } = await listProjectsForCredentials(
      [cred("a", "A"), cred("b", "B")],
      async (token) => ({ projects: byToken[token] ?? [] }),
    );
    assert.deepEqual(
      projects.map((p) => p.id),
      ["p1", "p2"],
    );
    assert.equal(projects[0]?.name, "from-a");
    assert.equal(projects[0]?.credentialId, "a");
    assert.equal(projects[1]?.credentialId, "b");
    assert.deepEqual(failures, []);
  });

  test("tolerates an authz failure on one credential when another succeeds", async () => {
    const { projects, failures } = await listProjectsForCredentials(
      [cred("dead", "Dead"), cred("ok", "Ok")],
      async (token) => {
        if (token === "tok_dead") throw authz();
        return { projects: [proj("p1")] };
      },
    );
    assert.deepEqual(
      projects.map((p) => p.id),
      ["p1"],
    );
    assert.equal(projects[0]?.credentialId, "ok");
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.credentialId, "dead");
    assert.equal(failures[0]?.code, "railway_account_read_failed");
    assert.doesNotMatch(JSON.stringify(failures[0]), /Not Authorized/);
  });

  test("returns empty without throwing when a dead credential coexists with a valid-but-empty one", async () => {
    // Regression: empty must not be conflated with all-failed.
    const { projects, failures } = await listProjectsForCredentials(
      [cred("dead", "Dead"), cred("empty", "Empty")],
      async (token) => {
        if (token === "tok_dead") throw authz();
        return { projects: [] };
      },
    );
    assert.deepEqual(projects, []);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.credentialId, "dead");
  });

  test("throws when every credential fails authz", async () => {
    await assert.rejects(
      () =>
        listProjectsForCredentials([cred("a", "A"), cred("b", "B")], async () => {
          throw authz();
        }),
      /Railway projects could not be read/,
    );
  });

  test("projects a single-credential authz error through the safe registry", async () => {
    await assert.rejects(
      () =>
        listProjectsForCredentials([cred("only", "Only")], async () => {
          throw authz();
        }),
      /Railway projects could not be read/,
    );
  });

  test("projects a single-credential provider error through the safe registry", async () => {
    await assert.rejects(
      () =>
        listProjectsForCredentials([cred("only", "Only")], async () => {
          throw new Error("network down");
        }),
      /Railway projects could not be read/,
    );
  });

  test("tolerates a transient non-authz failure on one credential when another succeeds", async () => {
    const { projects, failures } = await listProjectsForCredentials(
      [cred("flaky", "Flaky"), cred("ok", "Ok")],
      async (token) => {
        if (token === "tok_flaky") throw new Error("network down");
        return { projects: [proj("p1")] };
      },
    );
    assert.deepEqual(
      projects.map((p) => p.id),
      ["p1"],
    );
    assert.equal(projects[0]?.credentialId, "ok");
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.credentialId, "flaky");
    assert.equal(failures[0]?.code, "railway_account_read_failed");
    assert.doesNotMatch(JSON.stringify(failures[0]), /network down/);
  });
});

function dep(
  id: string,
  createdAt: string | null,
  serviceId: string | null = null,
  status = "SUCCESS",
): RailwayDeployment {
  return { id, status, createdAt, url: null, serviceId };
}

function projSvc(
  id: string,
  name: string,
  services: Array<{ id: string; name: string }> = [],
): RailwayProject {
  return { id, name, services, environments: [] };
}

describe("Railway recent-deployment fan-out", () => {
  test("merges deployments across projects and credentials, newest first, tagged with project/service/credential", async () => {
    const projectsByToken: Record<string, RailwayProject[]> = {
      tok_a: [projSvc("p1", "alfred", [{ id: "svc1", name: "server" }])],
      tok_b: [projSvc("p2", "milkpod", [{ id: "svc2", name: "web" }])],
    };
    const depsByProject: Record<string, RailwayDeployment[]> = {
      p1: [dep("d_a1", "2026-07-14T03:00:00Z", "svc1")],
      p2: [dep("d_b1", "2026-07-14T05:00:00Z", "svc2"), dep("d_b2", "2026-07-14T01:00:00Z", "svc2")],
    };
    const { deployments, failures } = await listRecentDeploymentsForCredentials(
      [cred("a", "A"), cred("b", "B")],
      async (token) => ({ projects: projectsByToken[token] ?? [] }),
      async ({ projectId }) => ({ deployments: depsByProject[projectId] ?? [] }),
    );
    assert.deepEqual(
      deployments.map((d) => d.id),
      ["d_b1", "d_a1", "d_b2"],
    );
    const newest = deployments[0];
    assert.equal(newest?.projectId, "p2");
    assert.equal(newest?.projectName, "milkpod");
    assert.equal(newest?.serviceName, "web");
    assert.equal(newest?.credentialId, "b");
    assert.deepEqual(failures, []);
  });

  test("resolves serviceName from the project's services, null when the id is unknown or absent", async () => {
    const { deployments } = await listRecentDeploymentsForCredentials(
      [cred("a", "A")],
      async () => ({ projects: [projSvc("p1", "alfred", [{ id: "svc1", name: "server" }])] }),
      async () => ({
        deployments: [
          dep("known", "2026-07-14T03:00:00Z", "svc1"),
          dep("unknown", "2026-07-14T02:00:00Z", "svcX"),
          dep("none", "2026-07-14T01:00:00Z", null),
        ],
      }),
    );
    const serviceById = new Map(deployments.map((d) => [d.id, d.serviceName]));
    assert.equal(serviceById.get("known"), "server");
    assert.equal(serviceById.get("unknown"), null);
    assert.equal(serviceById.get("none"), null);
  });

  test("caps to overallLimit after sorting newest first", async () => {
    const { deployments } = await listRecentDeploymentsForCredentials(
      [cred("a", "A")],
      async () => ({ projects: [projSvc("p1", "alfred")] }),
      async () => ({
        deployments: [
          dep("old", "2026-07-14T01:00:00Z"),
          dep("new", "2026-07-14T09:00:00Z"),
          dep("mid", "2026-07-14T05:00:00Z"),
        ],
      }),
      { overallLimit: 2 },
    );
    assert.deepEqual(
      deployments.map((d) => d.id),
      ["new", "mid"],
    );
  });

  test("sorts deployments with a missing createdAt last", async () => {
    const { deployments } = await listRecentDeploymentsForCredentials(
      [cred("a", "A")],
      async () => ({ projects: [projSvc("p1", "alfred")] }),
      async () => ({
        deployments: [dep("nulltime", null), dep("real", "2026-07-14T03:00:00Z")],
      }),
    );
    assert.deepEqual(
      deployments.map((d) => d.id),
      ["real", "nulltime"],
    );
  });

  test("tolerates a single project's deployment failure and records it in failures", async () => {
    const { deployments, failures } = await listRecentDeploymentsForCredentials(
      [cred("a", "A")],
      async () => ({ projects: [projSvc("good", "good-proj"), projSvc("bad", "bad-proj")] }),
      async ({ projectId }) => {
        if (projectId === "bad") throw authz();
        return { deployments: [dep("d1", "2026-07-14T03:00:00Z")] };
      },
    );
    assert.deepEqual(
      deployments.map((d) => d.id),
      ["d1"],
    );
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.credentialId, "a");
    assert.equal(failures[0]?.code, "railway_account_read_failed");
    // The raw provider message must never leak into the surfaced failure.
    assert.doesNotMatch(JSON.stringify(failures[0]), /Not Authorized/);
  });

  test("carries a project-list failure through into the combined failures", async () => {
    const { deployments, failures } = await listRecentDeploymentsForCredentials(
      [cred("dead", "Dead"), cred("ok", "Ok")],
      async (token) => {
        if (token === "tok_dead") throw authz();
        return { projects: [projSvc("p1", "alfred")] };
      },
      async () => ({ deployments: [dep("d1", "2026-07-14T03:00:00Z")] }),
    );
    assert.deepEqual(
      deployments.map((d) => d.id),
      ["d1"],
    );
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.credentialId, "dead");
  });
});

describe("Railway tool schemas", () => {
  test("credentialId is optional on follow-up tools but validated when present", () => {
    assert.equal(
      railwayListDeploymentsInput.parse({ projectId: "project_1", limit: 5 }).credentialId,
      undefined,
    );
    assert.equal(
      railwayGetLogsInput.parse({ deploymentId: "deployment_1", limit: 100 }).credentialId,
      undefined,
    );
    assert.equal(
      railwayRedeployInput.parse({
        deploymentId: "deployment_1",
        serviceName: "api",
        projectName: "alfred",
      }).credentialId,
      undefined,
    );
    // serviceName + projectName are required so the approval card can never fall
    // back to bare ids; environmentName is optional.
    assert.throws(() => railwayRedeployInput.parse({ deploymentId: "deployment_1" }));

    assert.equal(
      railwayListDeploymentsInput.parse({
        credentialId: "intc_1",
        projectId: "project_1",
        limit: 5,
      }).credentialId,
      "intc_1",
    );

    // present-but-empty is still rejected by min(1)
    assert.throws(() =>
      railwayListDeploymentsInput.parse({ credentialId: "", projectId: "project_1", limit: 5 }),
    );
  });

  test("recent_deployments takes no target ids, defaults limit to 15, and clamps out-of-range", () => {
    assert.equal(railwayRecentDeploymentsInput.parse({}).limit, 15);
    assert.equal(railwayRecentDeploymentsInput.parse({ limit: 5 }).limit, 5);
    // out-of-range coerces back to the default via .catch rather than throwing
    assert.equal(railwayRecentDeploymentsInput.parse({ limit: 999 }).limit, 15);
    // it's a cross-project sweep, so per-project ids are not part of its shape
    assert.throws(() => railwayRecentDeploymentsInput.parse({ projectId: "project_1" }));
  });
});
