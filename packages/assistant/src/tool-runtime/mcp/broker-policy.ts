/**
 * Process-local limits owned by the MCP execution broker.
 *
 * These values protect provider admission and local settlement repair. They do
 * not describe a product page, so they must not depend on recovery-card paging
 * from `@alfred/contracts`.
 */
export const MCP_BROKER_ADMISSION_CAPACITY = 40;
// Deliberately smaller than the product recovery page. The progress cursor, not
// an accidental ratio between these limits, guarantees complete traversal.
export const MCP_SETTLEMENT_REPAIR_BATCH_SIZE = 8;

export function hasMcpBrokerAdmissionCapacity(input: {
  pendingRepairs: number;
  activeSettlements: number;
}): boolean {
  return input.pendingRepairs + input.activeSettlements < MCP_BROKER_ADMISSION_CAPACITY;
}
