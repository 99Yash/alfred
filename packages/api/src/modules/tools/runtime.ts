/** Server-boot registration for the built-in tool definitions. */

import { calendarTools } from "./calendar";
import { registerToolsRuntimeAdapter } from "./tool-runtime-adapter";
import { docsTools } from "./docs";
import { driveTools } from "./drive";
import { githubTools } from "./github";
import { gmailTools } from "./gmail";
import { mcpTools } from "./mcp";
import { notionTools } from "./notion";
import { railwayTools } from "./railway";
import { assertKernelToolsRegistered, registerTools } from "@alfred/assistant/tool-runtime";
import { sheetsTools } from "./sheets";
import { slidesTools } from "./slides";
import { systemTools } from "./system";
import { vercelTools } from "./vercel";
import { registerWorkflowToolCatalog } from "./workflow-tool-catalog-source";

export function registerBuiltinTools(): void {
  registerTools(systemTools);
  registerTools(gmailTools);
  registerTools(calendarTools);
  registerTools(driveTools);
  registerTools(githubTools);
  registerTools(docsTools);
  registerTools(sheetsTools);
  registerTools(slidesTools);
  registerTools(notionTools);
  registerTools(railwayTools);
  registerTools(vercelTools);
  registerTools(mcpTools);
  assertKernelToolsRegistered(systemTools);
  registerToolsRuntimeAdapter();
  registerWorkflowToolCatalog();
}
