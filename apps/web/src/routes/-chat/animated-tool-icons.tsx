import { isToolName, type ToolName } from "@alfred/contracts";
import {
  Blocks,
  Bookmark,
  Brain,
  Cctv,
  CircleCheckBig,
  CirclePlay,
  Clock,
  Eraser,
  Fan,
  FilePen,
  FilePlus,
  FileText,
  Globe,
  Library,
  Link,
  ListChecks,
  ListPlus,
  MessageCircleQuestionMark,
  MessagesSquare,
  Notebook,
  NotebookPen,
  PencilLine,
  Plug,
  Radar,
  ScanText,
  SquarePen,
  Telescope,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { cn } from "~/lib/utils";

/**
 * The glyph for a tool that belongs to no integration — every `system.*` and
 * `mcp.*` tool, which have no logo to wear. One map, not two: the same glyph
 * draws the idle row and the in-flight pulse, because the pulse is a CSS class
 * on the icon rather than a different icon (see {@link RunningToolIcon}).
 *
 * The point of the map is that a reader can tell two brandless rows apart
 * without reading them — a run that searches the corpus, loads a tool, and
 * files a to-do should not draw the same wrench three times. Exhaustive over
 * the brandless tool names via `satisfies`, so a tool added to the registry
 * fails the typecheck here rather than silently falling back to the wrench.
 *
 * Tools that DO belong to an integration never reach this map: their card
 * shows the service's own logo coin instead.
 */
const BRANDLESS_TOOL_ICONS = {
  // The tool ladder.
  "system.search_tools": Telescope,
  "system.load_tool": Blocks,
  "system.current_time": Clock,

  // Workflows.
  "system.author_workflow": Workflow,
  "system.recover_workflow": Workflow,
  "system.activate_workflow": CirclePlay,

  // Delegation.
  "system.spawn_sub_agent": Fan,
  "system.await_sub_agent": Cctv,
  "system.ask_user": MessageCircleQuestionMark,

  // What Alfred knows about the user.
  "system.read_user_context": ScanText,
  "system.read_chat_history": MessagesSquare,
  "system.read_scratch": Notebook,
  "system.write_scratch": NotebookPen,
  "system.promote": Bookmark,
  "system.remember": Brain,
  "system.list_instructions": ListChecks,
  "system.forget_instruction": Eraser,
  "system.edit_instruction": PencilLine,
  "system.resolve_todo": CircleCheckBig,
  "system.suggest_todo": SquarePen,

  // Reading. The globe is the live web; the library is the user's own corpus.
  // Keeping them distinct is the whole point — "searched the web" and
  // "searched your documents" are different claims about where an answer came
  // from, and a shared glyph would blur them.
  "system.web_search": Globe,
  "system.fetch_url": Link,
  "system.corpus_search": Library,
  "system.search_context": Radar,

  // Artifacts.
  "system.create_artifact": FileText,
  "system.append_artifact_page": FilePlus,
  "system.append_artifact_section": ListPlus,
  "system.update_artifact": FilePen,

  // MCP servers carry no registry logo of their own.
  "mcp.call": Plug,
  "mcp.list_tools": Plug,
} satisfies Partial<Record<ToolName, LucideIcon>>;

const ICON_BY_TOOL_NAME: ReadonlyMap<string, LucideIcon> = new Map(
  Object.entries(BRANDLESS_TOOL_ICONS),
);

/**
 * The glyph for a brandless tool, or `undefined` for a name this build does
 * not know (a web-scoped or future tool), which keeps the generic fallback.
 */
export function brandlessToolIcon(toolName: string): LucideIcon | undefined {
  return isToolName(toolName) ? ICON_BY_TOOL_NAME.get(toolName) : undefined;
}

/**
 * Renders a tool glyph that pulses while `running` is true. The actual motion is
 * CSS so the app's `prefers-reduced-motion` block can disable it globally.
 */
export function RunningToolIcon({
  icon: Icon,
  running,
  size = 13,
}: {
  icon: LucideIcon;
  running: boolean;
  size?: number | undefined;
}) {
  return (
    <Icon
      size={size}
      className={cn("tool-animated-icon", running && "tool-animated-icon--running")}
    />
  );
}
