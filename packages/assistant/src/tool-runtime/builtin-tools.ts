/** Server-boot registration for the built-in tool definitions. */

import { registerToolsRuntimeAdapter } from "./surface-adapter";
import {
  assertKernelToolsRegistered,
  getTool,
  listToolsForIntegration,
  registerTools,
  type RegisteredTool,
} from "./internal/registry";
import { contactsTools } from "./internal/tools/contacts";
import { contextSearchTools } from "./internal/tools/context-search";
import { corpusTools } from "./internal/tools/corpus";
import { gmailTools } from "./internal/tools/gmail";
import { mcpTools } from "./internal/tools/mcp";
import { sheetsTools } from "./internal/tools/sheets";
import { systemTools } from "./internal/tools/system";
import { vercelTools } from "./internal/tools/vercel";
import { registerWorkflowToolCatalog } from "./workflow-tool-catalog-source";
import type { IntegrationSlug, ToolName } from "@alfred/contracts";

export interface BuiltinToolRegistry {
  get(name: ToolName): RegisteredTool | undefined;
  listForIntegration(integration: IntegrationSlug): readonly RegisteredTool[];
}

const builtinToolRegistry: BuiltinToolRegistry = {
  get: getTool,
  listForIntegration: listToolsForIntegration,
};

export function registerBuiltinTools(): BuiltinToolRegistry {
  registerTools(systemTools);
  registerTools(contextSearchTools);
  registerTools(corpusTools);
  registerTools(gmailTools);
  registerTools(sheetsTools);
  registerTools(contactsTools);
  registerTools(vercelTools);
  registerTools(mcpTools);
  assertKernelToolsRegistered([...systemTools, ...contextSearchTools]);
  registerToolsRuntimeAdapter();
  registerWorkflowToolCatalog();

  return builtinToolRegistry;
}
