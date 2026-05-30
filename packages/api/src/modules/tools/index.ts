/**
 * Tool registry barrel + server-boot registration entry point.
 *
 * `registerBuiltinTools()` is the single call apps make at boot to load
 * the initial m13 tool slice. Per-integration modules own their
 * registration lists; this file only stitches them together so the boot
 * sequence has one obvious lever to pull.
 */

import { calendarTools } from "./calendar";
import { gmailTools } from "./gmail";
import { registerTools } from "./registry";
import { sheetsTools } from "./sheets";
import { slidesTools } from "./slides";
import { systemTools } from "./system";

export {
  liveTool,
  registerTool,
  registerTools,
  getTool,
  listToolsForIntegration,
  clearToolRegistryForTests,
  type RegisteredTool,
  type LiveToolArgs,
  type ToolExecuteContext,
} from "./registry";

export function registerBuiltinTools(): void {
  registerTools(systemTools);
  registerTools(gmailTools);
  registerTools(calendarTools);
  registerTools(sheetsTools);
  registerTools(slidesTools);
}
