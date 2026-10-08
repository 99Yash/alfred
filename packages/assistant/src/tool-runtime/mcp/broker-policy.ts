/**
 * Process-local limits for the MCP broker's admission and settlement repair.
 * Not product paging, so do not tie them to recovery-card paging in `@alfred/contracts`.
 */
export const MCP_BROKER_ADMISSION_CAPACITY = 40;

/** Settlement repairs one drain pass retries before it yields. */
export const MCP_SETTLEMENT_REPAIR_BATCH_SIZE = 8;

/** Delay before the broker retries a settlement repair that failed locally. */
export const MCP_SETTLEMENT_REPAIR_RETRY_MS = 5_000;

export function hasMcpBrokerAdmissionCapacity(input: {
  pendingRepairs: number;
  activeSettlements: number;
}): boolean {
  return input.pendingRepairs + input.activeSettlements < MCP_BROKER_ADMISSION_CAPACITY;
}
