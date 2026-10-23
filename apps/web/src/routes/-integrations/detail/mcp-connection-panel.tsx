import type { BuiltInMCPProvider } from "@alfred/contracts";
import { McpBuiltInCard } from "../mcp-built-in-card";
import { useMcpConnections } from "../use-mcp-connections";
import { SectionHeading } from "./section-heading";

/**
 * Shown for a planned integration that connects only through its built-in MCP
 * server (ADR-0093, amended 2026-10-23). The card is the same one the list shows.
 */
export function McpConnectionPanel({
  provider,
  name,
}: {
  provider: BuiltInMCPProvider;
  name: string;
}) {
  const connectionQuery = useMcpConnections();

  return (
    <section className="app-card-in space-y-3" style={{ animationDelay: "120ms" }}>
      <SectionHeading>MCP connection</SectionHeading>
      <McpBuiltInCard
        provider={provider}
        connection={connectionQuery.data?.find(
          (connection) => connection.builtInProvider === provider,
        )}
        loading={connectionQuery.isPending}
        readError={connectionQuery.isError}
        onRetry={() => {
          void connectionQuery.refetch();
        }}
      />
      <p className="px-1 text-[12.5px] leading-5 text-app-fg-3">
        {name} connects only through its MCP server. Each call waits for your approval before it
        runs.
      </p>
    </section>
  );
}
