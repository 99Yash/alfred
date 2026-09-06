/** Server-boot registration for the built-in tool definitions. */

import { registerToolsRuntimeAdapter } from "./surface-adapter";
import {
  assertKernelToolsRegistered,
  getTool,
  listToolsForIntegration,
  registerTools,
  type RegisteredTool,
} from "./internal/registry";
import { calendarTools } from "./internal/tools/calendar";
import { corpusTools } from "./internal/tools/corpus";
import { docsTools } from "./internal/tools/docs";
import { driveTools } from "./internal/tools/drive";
import { githubTools } from "./internal/tools/github";
import { gmailTools } from "./internal/tools/gmail";
import { mcpTools } from "./internal/tools/mcp";
import { notionTools } from "./internal/tools/notion";
import { railwayTools } from "./internal/tools/railway";
import { sentryTools } from "./internal/tools/sentry";
import { sheetsTools } from "./internal/tools/sheets";
import { slidesTools } from "./internal/tools/slides";
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
  registerTools(corpusTools);
  registerTools(gmailTools);
  registerTools(calendarTools);
  registerTools(driveTools);
  registerTools(githubTools);
  registerTools(docsTools);
  registerTools(sheetsTools);
  registerTools(slidesTools);
  registerTools(notionTools);
  registerTools(railwayTools);
  registerTools(sentryTools);
  registerTools(vercelTools);
  registerTools(mcpTools);
  assertKernelToolsRegistered(systemTools);
  registerToolsRuntimeAdapter();
  registerWorkflowToolCatalog();
  return builtinToolRegistry;
}
