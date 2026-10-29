import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { McpClientPage } from "./-legal/mcp-client-page";

/** Public `/mcp-client`, the documentation link on MCP server client reviews, so no auth. */
export const Route = createFileRoute("/mcp-client")({
  staticData: { publicRoute: true },
  head: () =>
    pageMeta({
      title: "MCP Client",
      description: "How Alfred connects to and authorizes with remote MCP servers.",
      path: "/mcp-client",
    }),
  component: McpClientPage,
});
