import { AppSwitch } from "~/components/ui/v2";
import { cn } from "~/lib/utils";
import { TINT_TILE, type BackgroundAgentDef } from "./helpers";

export function AgentRow({
  agent,
  checked,
  onChange,
}: {
  agent: BackgroundAgentDef;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  const Icon = agent.icon;
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3.5">
      <div className="flex items-center gap-3 min-w-0">
        <span
          className={cn(
            "grid size-8 shrink-0 place-items-center rounded-xl",
            TINT_TILE[agent.tint],
          )}
          aria-hidden
        >
          <Icon size={14} />
        </span>
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium text-app-fg-4">{agent.label}</p>
          <p className="text-xs text-app-fg-3 truncate">{agent.helper}</p>
        </div>
      </div>
      <AppSwitch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
