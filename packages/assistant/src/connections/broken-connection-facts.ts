/**
 * Broken connections as facts for a model (ADR-0100 amendment 2026-10-28, revised). The code
 * supplies what it knows; the model decides what to tell the user. The briefing composer and the
 * weekly alert email both read this, so the two surfaces reason from one set of facts.
 */

import {
  assertNever,
  INTEGRATIONS,
  integrationConnectPath,
  type BlockingGatherProvenance,
  type LiveProviderSlug,
  mcpConnectionAuthorizePath,
  type DeliveryAlert,
  type McpConnectionAlert,
} from "@alfred/contracts";
import type { BriefingBrokenConnections } from "./availability";

/**
 * One connection the user must repair: a delivery alert, an MCP alert, or a briefing input that
 * Alfred could not read and the user can reconnect (ADR-0117 decision 2). A delivery alert carries
 * `input` when a briefing input of the same integration is also a block row, so the one row states
 * both facts.
 */
export type BrokenConnection =
  | {
      kind: "delivery";
      key: string;
      name: string;
      alert: DeliveryAlert;
      input?: BlockingGatherProvenance | undefined;
    }
  | { kind: "mcp"; key: string; name: string; alert: McpConnectionAlert }
  | { kind: "input"; key: string; name: string; entry: BlockingGatherProvenance };

/**
 * A stable key per connection. An MCP connection keys by id, because two connections can share a
 * label. The composer echoes the key, so the send step can match its notice to the row.
 */
export function deliveryConnectionKey(alert: DeliveryAlert): string {
  return integrationConnectionKey(alert.integration);
}

/** One key per integration, so a delivery alert and an input row for it are one row. */
function integrationConnectionKey(integration: LiveProviderSlug): string {
  return `integration:${integration}`;
}

export function mcpConnectionKey(alert: McpConnectionAlert): string {
  return `mcp:${alert.connectionId}`;
}

/**
 * Every connection to repair, one per key. An input row shares its key with a delivery alert for
 * the same integration, so one integration is one row. The delivery alert takes the row, because
 * the repair link is the same, and it carries the input entry, so the row does not lose the fact
 * that the read failed. When two inputs share an integration, the first one counts. `blockingInputs`
 * are the briefing's block rows (`blockingProvenance` in `briefings/provenance.ts`); a caller
 * without input rows passes `[]`.
 */
export function listBrokenConnections(
  broken: BriefingBrokenConnections,
  blockingInputs: readonly BlockingGatherProvenance[],
): BrokenConnection[] {
  const inputByKey = new Map<string, BlockingGatherProvenance>();

  for (const entry of blockingInputs) {
    const key = integrationConnectionKey(entry.recovery.integration);

    if (!inputByKey.has(key)) inputByKey.set(key, entry);
  }

  const listed: BrokenConnection[] = [
    ...broken.integrations.map((alert): BrokenConnection => {
      const key = deliveryConnectionKey(alert);

      return {
        kind: "delivery",
        key,
        name: INTEGRATIONS[alert.integration].displayName,
        alert,
        input: inputByKey.get(key),
      };
    }),
    ...broken.mcp.map(
      (alert): BrokenConnection => ({
        kind: "mcp",
        key: mcpConnectionKey(alert),
        name: alert.label,
        alert,
      }),
    ),
  ];

  const keys = new Set(listed.map((connection) => connection.key));

  for (const [key, entry] of inputByKey) {
    if (keys.has(key)) continue;
    listed.push({
      kind: "input",
      key,
      name: INTEGRATIONS[entry.recovery.integration].displayName,
      entry,
    });
  }

  return listed;
}

/** The repair route, relative to the API origin. The banner uses the same routes. */
export function brokenConnectionRepairPath(connection: BrokenConnection): string {
  switch (connection.kind) {
    case "delivery":
      return integrationConnectPath(connection.alert.integration);
    case "input":
      return integrationConnectPath(connection.entry.recovery.integration);
    case "mcp":
      return mcpConnectionAuthorizePath(connection.alert.connectionId);
    default:
      return assertNever(connection, "broken connection kind");
  }
}

/**
 * How to talk about a broken connection. Principles, not wording: the model writes the words.
 * Static, so it caches.
 */
export const BROKEN_CONNECTION_GUIDANCE = [
  "You are Alfred, the user's personal assistant, telling them about one of your connections that stopped working. Say `I`, never `Alfred`.",
  "From the facts, work out the likely cause, what it costs the user in concrete terms (what you can no longer see, check, or do for them with that service), and what the fix takes. Lead with the cost, keep it short, and skip pleasantries such as `please`.",
  "Reason from the facts, and do not add facts that are not listed:",
  "- `delivery` means updates stopped arriving live. On its own, it does not prove that direct reads fail. When the same entry names a briefing input, or another fact you were given says that you could not read the same source, that read failed too: say so. Otherwise, do not say that you see nothing from that source.",
  "- `mcp` means your tool calls through that connection fail until the user repairs it.",
  "- `input` means you could not read that source for this briefing. The reason says why.",
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

    if (connection.input) {
      lines.push(
        `  briefing input: ${connection.input.input} (Alfred could not read it)`,
        `  reason: ${connection.input.reason}`,
      );
    }

    return lines.join("\n");
  }

  if (connection.kind === "input") {
    lines.push(
      `  kind: input (a source this briefing reads; Alfred could not read it)`,
      `  briefing input: ${connection.entry.input}`,
      `  reason: ${connection.entry.reason}`,
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
