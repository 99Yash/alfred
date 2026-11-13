import type { BuiltInMCPProvider } from "@alfred/contracts";
import { McpBuiltInCard } from "../mcp-built-in-card";
import { useMcpConnections } from "~/lib/integrations/mcp-connections";
import { SectionHeading } from "./section-heading";

/**
 * The built-in MCP server on an integration page (ADR-0093, amended 2026-10-23). The card
 * is the same one the list shows. The caller writes `note`: only it knows how the server connects.
 */
export function McpConnectionPanel({
  provider,
  note,
}: {
  provider: BuiltInMCPProvider;
  note: string;
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
      <p className="px-1 text-[12.5px] leading-5 text-app-fg-3">{note}</p>
    </section>
  );
}
