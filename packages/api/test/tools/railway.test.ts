import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  railwayGetLogsInput,
  railwayListDeploymentsInput,
  railwayRedeployInput,
} from "@alfred/contracts";
import {
  railwayListProjects,
  railwayValidateToken,
  type RailwayProject,
} from "@alfred/integrations/railway";

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

describe("Railway token handling", () => {
  test("validates workspace tokens with a stable workspace id", async () => {
    await withMockedRailwayFetch(
      [
        { body: { data: null, errors: [{ message: "Not Authorized" }] } },
        {
          body: {
            data: { apiToken: { workspaceId: "ws_123", name: "Production automation" } },
          },
        },
        {
          body: {
            data: { workspace: { id: "ws_123", name: "Acme" } },
          },
        },
      ],
      async (calls) => {
        const account = await railwayValidateToken("tok_workspace");

        assert.deepEqual(account, {
          id: "workspace:ws_123",
          name: "Acme",
          email: null,
        });
        assert.match(calls[0]?.query ?? "", /me \{ id name email \}/);
        assert.match(calls[1]?.query ?? "", /apiToken \{ workspaceId name \}/);
        assert.match(calls[2]?.query ?? "", /workspace\(workspaceId: \$workspaceId\)/);
        assert.deepEqual(calls[2]?.variables, { workspaceId: "ws_123" });
      },
    );
  });

  test("keeps workspace tokens valid when workspace-name enrichment fails", async () => {
    await withMockedRailwayFetch(
      [
        { body: { data: null, errors: [{ message: "Not Authorized" }] } },
        {
          body: {
            data: { apiToken: { workspaceId: "ws_123", name: "Production automation" } },
          },
        },
        { body: { data: null, errors: [{ message: "Not Authorized" }] } },
      ],
      async () => {
        const account = await railwayValidateToken("tok_workspace");

        assert.deepEqual(account, {
          id: "workspace:ws_123",
          name: "Production automation",
          email: null,
        });
      },
    );
  });

  test("rejects bearer tokens that are not account or workspace scoped", async () => {
    await withMockedRailwayFetch(
      [
        { body: { data: null, errors: [{ message: "Not Authorized" }] } },
        { body: { data: { apiToken: { workspaceId: null, name: "Project deploy" } } } },
      ],
      async () => {
        await assert.rejects(
          () => railwayValidateToken("tok_project"),
          /not an account or workspace-scoped API token/,
        );
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
        { body: { data: null, errors: [{ message: "Not Authorized" }] } },
        {
          body: {
            data: {
              projects: {
                edges: [{ node: projectNode("project_workspace", "Workspace scoped") }],
              },
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

  test("requires credential provenance on follow-up Railway tools", () => {
    assert.throws(
      () => railwayListDeploymentsInput.parse({ projectId: "project_1", limit: 5 }),
      /credentialId/,
    );
    assert.throws(
      () => railwayGetLogsInput.parse({ deploymentId: "deployment_1", limit: 100 }),
      /credentialId/,
    );
    assert.throws(
      () => railwayRedeployInput.parse({ deploymentId: "deployment_1" }),
      /credentialId/,
    );

    assert.equal(
      railwayListDeploymentsInput.parse({
        credentialId: "intc_1",
        projectId: "project_1",
        limit: 5,
      }).credentialId,
      "intc_1",
    );
  });
});
