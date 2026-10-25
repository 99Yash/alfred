import { BUILT_IN_MCP_CATALOG, getStringPath, type ToolName } from "@alfred/contracts";
import { createContext, use, type ReactNode } from "react";
import { Favicon } from "~/components/favicon";
import {
  IntegrationIcon,
  type IntegrationBrand,
  type IntegrationIconSize,
} from "~/lib/integrations/integration-icons";
import { brandForIntegration } from "~/lib/integrations/integrations";
import { cn } from "~/lib/utils";
import {
  mcpConnectionFaviconDomain,
  useMcpConnections,
  type McpConnection,
} from "~/lib/integrations/mcp-connections";

/** The server an `mcp.call` ran on, drawn the way the integrations page draws it. */
export interface McpServerView {
  label: string;
  /** A built-in server carries its provider's artwork. */
  brand?: IntegrationBrand | undefined;
  /** A user-added server shows its vendor's favicon. */
  faviconDomain?: string | undefined;
}

/** `undefined` for a connection the owner removed, or while the list loads. */
export type McpServerLookup = (connectionId: string) => McpServerView | undefined;

const NO_SERVERS: McpServerLookup = () => undefined;

/**
 * Marks the signed-in chat. Default `false`: the public `/c/$slug` page renders the same rows
 * and must make no authenticated read (ADR-0102), so it names no server.
 */
const McpServerScope = createContext(false);

export function McpServerScopeProvider({ children }: { children: ReactNode }) {
  return <McpServerScope.Provider value={true}>{children}</McpServerScope.Provider>;
}

function serverView(connection: McpConnection): McpServerView {
  if (connection.builtInProvider !== null) {
    const { slug } = BUILT_IN_MCP_CATALOG[connection.builtInProvider];

    return { label: connection.label, brand: brandForIntegration(slug) };
  }

  return { label: connection.label, faviconDomain: mcpConnectionFaviconDomain(connection) };
}

/**
 * Names the server behind each `mcp.call`. Pass `needed: false` when no such call is on screen,
 * so a chat with no MCP work makes no request.
 */
export function useMcpServerLookup(needed: boolean): McpServerLookup {
  const inScope = use(McpServerScope);
  const { data: connections } = useMcpConnections({ enabled: inScope && needed });

  if (!connections) return NO_SERVERS;

  return (connectionId) => {
    const connection = connections.find((c) => c.id === connectionId);

    return connection ? serverView(connection) : undefined;
  };
}

export const MCP_CALL_TOOL = "mcp.call" satisfies ToolName;

/** The server a staged `mcp.call` will run on. `undefined` for any other tool or an unknown server. */
export function useMcpCallServer(toolName: string, input: unknown): McpServerView | undefined {
  const connectionId =
    toolName === MCP_CALL_TOOL ? getStringPath(input, "connectionId") : undefined;

  const lookup = useMcpServerLookup(connectionId !== undefined);

  return connectionId === undefined ? undefined : lookup(connectionId);
}

const FAVICON_COIN = {
  xs: { className: "size-6", favicon: 16 },
  sm: { className: "size-7", favicon: 16 },
  md: { className: "size-10", favicon: 20 },
} as const satisfies Record<IntegrationIconSize, { className: string; favicon: number }>;

/**
 * The server's mark: brand artwork for a built-in server, else the vendor's favicon in a coin.
 * Null when the server has neither, so the caller keeps its own glyph.
 */
export function McpServerIcon({
  server,
  size = "md",
}: {
  server: McpServerView;
  size?: IntegrationIconSize | undefined;
}) {
  if (server.brand)
    return <IntegrationIcon brand={server.brand} size={size} title={server.label} />;

  if (!server.faviconDomain) return null;
  const coin = FAVICON_COIN[size];

  return (
    <span
      aria-hidden
      title={server.label}
      className={cn(
        "grid shrink-0 place-items-center rounded-full bg-app-bg-2 shadow-(--app-shadow-elevated)",
        coin.className,
      )}
    >
      <Favicon domain={server.faviconDomain} size={coin.favicon} />
    </span>
  );
}
