/**
 * Tool registry barrel + server-boot registration entry point.
 *
 * `registerBuiltinTools()` is the single call apps make at boot to load
 * the initial m13 tool slice. Per-integration modules own their
 * registration lists; this file only stitches them together so the boot
 * sequence has one obvious lever to pull.
 */

import { calendarTools } from "./calendar";
import { docsTools } from "./docs";
import { driveTools } from "./drive";
import { githubTools } from "./github";
import { gmailTools } from "./gmail";
import { mcpTools } from "./mcp";
import { notionTools } from "./notion";
import { railwayTools } from "./railway";
import { assertKernelToolsRegistered, registerTools } from "./registry";
import { sheetsTools } from "./sheets";
import { slidesTools } from "./slides";
import { systemTools } from "./system";
import { vercelTools } from "./vercel";

export {
  liveTool,
  registerTool,
  registerTools,
  getTool,
  listToolsForIntegration,
  riskTierCountsForIntegration,
  clearToolRegistryForTests,
  type RiskTierCounts,
  type RegisteredTool,
  type LiveToolArgs,
  type ToolExecuteContext,
} from "./registry";

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
}
