import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildAddServerBody,
  type AddServerFields,
} from "../src/routes/-integrations/mcp-add-server-form";

const FIELDS: AddServerFields = {
  endpointUrl: "  https://mcp.example.com/mcp  ",
  label: "",
  authMode: "oauth",
  apiKey: { placementIn: "header", placementName: "X-Api-Key", value: "sk_live_123" },
};

test("the oauth arm omits auth and a blank label, and trims the URL", () => {
  const body = buildAddServerBody(FIELDS);

  assert.deepEqual(body, { endpointUrl: "https://mcp.example.com/mcp" });
  assert.equal("label" in body, false);
  assert.equal("auth" in body, false);
});

test("a supplied label is trimmed and carried", () => {
  const body = buildAddServerBody({ ...FIELDS, label: "  Billing MCP  " });

  assert.deepEqual(body, {
    endpointUrl: "https://mcp.example.com/mcp",
    label: "Billing MCP",
  });
});

test("the api_key arm builds the exact placement union and trims the placement name", () => {
  const body = buildAddServerBody({
    ...FIELDS,
    authMode: "api_key",
    apiKey: { placementIn: "query", placementName: "  api_key  ", value: "sk_live_123" },
  });

  assert.deepEqual(body, {
    endpointUrl: "https://mcp.example.com/mcp",
    auth: {
      kind: "api_key",
      placement: { in: "query", name: "api_key" },
      value: "sk_live_123",
    },
  });
});
