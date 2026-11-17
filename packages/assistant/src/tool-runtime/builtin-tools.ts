/** Server-boot registration for the built-in tool definitions. */

import { registerToolsRuntimeAdapter } from "./surface-adapter";
import {
  assertKernelToolsRegistered,
  getTool,
  listRegisteredTools,
  listToolsForIntegration,
  registerTools,
  type RegisteredTool,
} from "./internal/registry";
import { codeRunTool } from "./internal/tools/code-run";
import { contactsTools } from "./internal/tools/contacts";
import { contextSearchTools } from "./internal/tools/context-search";
import { corpusTools } from "./internal/tools/corpus";
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

let codeRun: RegisteredTool | undefined;

export function registerBuiltinTools(): BuiltinToolRegistry {
  registerTools(systemTools);
  registerTools(contextSearchTools);
  registerTools(corpusTools);
  registerTools(sheetsTools);
  registerTools(contactsTools);
  registerTools(vercelTools);
  registerTools(mcpTools);
  // Last: its index lists the read tools registered above (ADR-0124). Built one time, so a second
  // call registers the same object again, as it does for every other tool.
  codeRun ??= codeRunTool(listRegisteredTools().filter((tool) => tool.codeModeRead));
  registerTools([codeRun]);
  assertKernelToolsRegistered([...systemTools, ...contextSearchTools]);
  registerToolsRuntimeAdapter();
  registerWorkflowToolCatalog();

  return builtinToolRegistry;
}
