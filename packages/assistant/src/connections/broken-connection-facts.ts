/**
 * Broken connections as facts for a model (ADR-0100 amendment 2026-10-28, revised). The code
 * supplies what it knows; the model decides what to tell the user. The briefing composer and the
 * weekly alert email both read this, so the two surfaces reason from one set of facts.
 */

import {
  INTEGRATIONS,
  integrationConnectPath,
  mcpConnectionAuthorizePath,
  type DeliveryAlert,
  type McpConnectionAlert,
} from "@alfred/contracts";
import type { BriefingBrokenConnections } from "./availability";

/** One connection the user must repair, from either alert list. */
export type BrokenConnection =
  | { kind: "delivery"; key: string; name: string; alert: DeliveryAlert }
  | { kind: "mcp"; key: string; name: string; alert: McpConnectionAlert };

/**
 * A stable key per connection. An MCP connection keys by id, because two connections can share a
 * label. The composer echoes the key, so the send step can match its notice to the row.
 */
export function deliveryConnectionKey(alert: DeliveryAlert): string {
  return `integration:${alert.integration}`;
}

export function mcpConnectionKey(alert: McpConnectionAlert): string {
  return `mcp:${alert.connectionId}`;
}

export function listBrokenConnections(broken: BriefingBrokenConnections): BrokenConnection[] {
  return [
    ...broken.integrations.map(
      (alert): BrokenConnection => ({
        kind: "delivery",
        key: deliveryConnectionKey(alert),
        name: INTEGRATIONS[alert.integration].displayName,
        alert,
      }),
    ),
    ...broken.mcp.map(
      (alert): BrokenConnection => ({
        kind: "mcp",
        key: mcpConnectionKey(alert),
        name: alert.label,
        alert,
      }),
    ),
  ];
}

/** The repair route, relative to the API origin. The banner uses the same routes. */
export function brokenConnectionRepairPath(connection: BrokenConnection): string {
  return connection.kind === "delivery"
    ? integrationConnectPath(connection.alert.integration)
    : mcpConnectionAuthorizePath(connection.alert.connectionId);
}

/**
 * How to talk about a broken connection. Principles, not wording: the model writes the words.
 * Static, so it caches.
 */
export const BROKEN_CONNECTION_GUIDANCE = [
  "You are Alfred, the user's personal assistant, telling them about one of your connections that stopped working. Say `I`, never `Alfred`.",
  "From the facts, work out the likely cause, what it costs the user in concrete terms (what you can no longer see, check, or do for them with that service), and what the fix takes. Lead with the cost, keep it short, and skip pleasantries such as `please`.",
  "Reason from the facts, and do not add facts that are not listed:",
  "- `delivery` means updates stopped arriving live. It does not prove that direct reads fail, so do not say that you see nothing from that source.",
  "- `mcp` means your tool calls through that connection fail until the user repairs it.",
  "- Missing scopes mean that the grant is narrower than the tools need. Say what the missing access covers in plain words; name a scope only when it helps the user choose the right box on the consent screen.",
  "- A saved sign-in that does not open means you lost the key on your side. The user's account is fine, and one new sign-in fixes it.",
  "- A last error is the client's own record. Use what it tells you; do not paste it raw.",
  "Do not write a URL, a button, or a sign-off, and do not mention the link or the email. The repair link appears after your words.",
].join("\n");

/** The facts for one connection, as lines a model reads. */
export function describeBrokenConnection(connection: BrokenConnection): string {
  const lines = [`- key: ${connection.key}`, `  name: ${connection.name}`];

  if (connection.kind === "delivery") {
    lines.push(
      `  kind: delivery (the integration sends Alfred live activity events)`,
      `  health check: ${connection.alert.reason}`,
    );

    return lines.join("\n");
  }

  const { alert } = connection;

  lines.push(
    `  kind: mcp (an MCP server that Alfred calls tools on)`,
    `  status: ${alert.status}`,
    `  saved sign-in opens with Alfred's current key: ${alert.credentialUnopenable ? "no" : "yes"}`,
    `  missing scopes: ${alert.missingScopes.length > 0 ? alert.missingScopes.join(", ") : "none"}`,
    `  last error: ${alert.lastError ?? "none recorded"}`,
    `  last connected: ${alert.lastConnectedAt ?? "never"}`,
  );

  return lines.join("\n");
}
