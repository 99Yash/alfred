import { mcpInvocation } from "@alfred/db/schemas";
import { sql } from "drizzle-orm";
import { z } from "zod";

/**
 * One ordering protocol for both bounded settlement repair and product paging.
 * A caller may advance only past the durable key the broker reports as scanned.
 */
export const mcpRecoveryOrderKeySchema = z
  .object({ timestamp: z.string().datetime(), invocationId: z.string() })
  .strict();

export type McpRecoveryOrderKey = z.infer<typeof mcpRecoveryOrderKeySchema>;

export const mcpRecoveryEffectiveAt = sql<string>`coalesce(${mcpInvocation.deliveryPossibleAt}, ${mcpInvocation.createdAt})`;

export function mcpRecoveryOrderKey(input: {
  effectiveAt: string | Date;
  invocationId: string;
}): McpRecoveryOrderKey {
  return {
    timestamp: new Date(input.effectiveAt).toISOString(),
    invocationId: input.invocationId,
  };
}

export function afterMcpRecoveryOrderKey(key: McpRecoveryOrderKey) {
  return sql`(${mcpRecoveryEffectiveAt}, ${mcpInvocation.id}) > (${new Date(key.timestamp)}, ${key.invocationId})`;
}

export function atOrBeforeMcpRecoveryOrderKey(key: McpRecoveryOrderKey) {
  return sql`(${mcpRecoveryEffectiveAt}, ${mcpInvocation.id}) <= (${new Date(key.timestamp)}, ${key.invocationId})`;
}
