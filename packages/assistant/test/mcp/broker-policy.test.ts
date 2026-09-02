import assert from "node:assert/strict";
import { test } from "node:test";

import {
  hasMcpBrokerAdmissionCapacity,
  MCP_BROKER_ADMISSION_CAPACITY,
  MCP_SETTLEMENT_REPAIR_BATCH_SIZE,
  MCP_SETTLEMENT_REPAIR_RETRY_MS,
} from "../../src/tool-runtime/mcp/broker-policy";

test("broker admission and repair limits are independent of product recovery paging", () => {
  assert.equal(MCP_BROKER_ADMISSION_CAPACITY, 40);
  assert.equal(MCP_SETTLEMENT_REPAIR_BATCH_SIZE, 8);
  assert.equal(MCP_SETTLEMENT_REPAIR_RETRY_MS, 5_000);
  assert.equal(hasMcpBrokerAdmissionCapacity({ pendingRepairs: 20, activeSettlements: 19 }), true);
  assert.equal(hasMcpBrokerAdmissionCapacity({ pendingRepairs: 20, activeSettlements: 20 }), false);
});
