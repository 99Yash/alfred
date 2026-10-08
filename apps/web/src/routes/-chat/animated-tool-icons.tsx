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
 * Glyphs for `system.*` and `mcp.*` tools, which have no logo, so brandless rows look different.
 * The same glyph pulses in flight (a CSS class; see {@link RunningToolIcon}).
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

  // Globe is the live web; library is the user's corpus. Keep them distinct: different sources.
  "system.web_search": Globe,
  "system.fetch_url": Link,
  "system.corpus_search": Library,
  "system.search_context": Radar,

  // Artifacts.
  "system.create_artifact": FileText,
  "system.append_artifact_page": FilePlus,
  "system.append_artifact_section": ListPlus,
  "system.update_artifact": FilePen,

  // MCP servers carry no registry logo.
  "mcp.call": Plug,
  "mcp.list_tools": Plug,
} satisfies Partial<Record<ToolName, LucideIcon>>;

const ICON_BY_TOOL_NAME: ReadonlyMap<string, LucideIcon> = new Map(
  Object.entries(BRANDLESS_TOOL_ICONS),
);

/** `undefined` for an unknown name, which keeps the generic fallback. */
export function brandlessToolIcon(toolName: string): LucideIcon | undefined {
  return isToolName(toolName) ? ICON_BY_TOOL_NAME.get(toolName) : undefined;
}

/** Pulses while `running`. CSS, so the global reduced-motion block can stop it. */
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
