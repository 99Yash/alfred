/**
 * Read the live catalogs of the Google Workspace servers for the policy drift script
 * (`src/scripts/mcp-policy-drift.ts`). A throwaway client per server: it writes no row and
 * publishes no catalog. The hashes are the ones the gate compares (`descriptorHash`).
 */

import type { Tool } from "@modelcontextprotocol/client";
import { GOOGLE_WORKSPACE_BUILT_INS, BUILT_IN_REGISTRY, type BuiltInProvider } from "./built-ins";
import { McpRawClient } from "./client";
import { getMcpEndpointAuthorizer } from "./endpoint-authorization";
import { googleCredentialTokenSession } from "./google-credential-session";

interface LiveBuiltInCatalog {
  readonly provider: BuiltInProvider;
  readonly tools: readonly Tool[];
}

/** One live catalog for each Google Workspace server, read with the user's Google credential. */
export async function readLiveGoogleWorkspaceCatalogs(
  userId: string,
): Promise<LiveBuiltInCatalog[]> {
  const catalogs: LiveBuiltInCatalog[] = [];

  for (const provider of GOOGLE_WORKSPACE_BUILT_INS) {
    const endpoint = new URL(BUILT_IN_REGISTRY[provider].endpointHref);

    const client = new McpRawClient({
      connectionId: `policy-drift:${provider}`,
      endpoint: { endpointUrl: endpoint.href, endpointOrigin: endpoint.origin },
      endpointAuthorizer: getMcpEndpointAuthorizer(),
      auth: { mode: "borrowed", session: googleCredentialTokenSession(userId) },
    });

    try {
      await client.connect();
      const catalog = await client.refreshCatalog();

      catalogs.push({ provider, tools: catalog.tools });
    } finally {
      // oxlint-disable-next-line alfred/no-swallowed-catch -- best-effort close of a throwaway client; the read result or its fault is already decided
      await client.close({ terminateSession: true }).catch(() => undefined);
    }
  }

  return catalogs;
}
