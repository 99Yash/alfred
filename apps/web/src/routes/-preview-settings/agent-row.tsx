import { AppSwitch } from "~/components/ui/v2";
import { cn } from "~/lib/utils";
import { TINT_TILE, type BackgroundAgentDef } from "./helpers";

export function AgentRow({
  agent,
  checked,
  onChange,
  disabled = false,
  comingSoon = false,
}: {
  agent: BackgroundAgentDef;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  comingSoon?: boolean;
}) {
  const Icon = agent.icon;
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-4 px-5 py-3.5",
        disabled && "opacity-60",
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
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
          <p className="flex items-center gap-2 text-sm font-medium text-app-fg-4">
            {agent.label}
            {comingSoon && (
              <span className="rounded-full bg-app-bg-2 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-app-fg-3 uppercase">
                Coming soon
              </span>
            )}
          </p>
          <p className="truncate text-xs text-app-fg-3">{agent.helper}</p>
        </div>
      </div>
      <AppSwitch
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        aria-label={`Enable ${agent.label}`}
      />
    </div>
  );
}
