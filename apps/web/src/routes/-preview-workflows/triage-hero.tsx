import { cn } from "~/lib/utils";

export function TriageHero({ accent }: { accent: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="relative flex items-center gap-2">
        {[
          { label: "Inbox", tone: "bg-app-bg-2 text-app-fg-3" },
          {
            label: "Action",
            tone: cn("bg-app-bg-1", accent),
            classNames: "app-stack app-stack-mid",
          },
          {
            label: "Newsletter",
            tone: "bg-app-bg-2 text-app-fg-3",
            classNames: "app-stack app-stack-back",
          },
          {
            label: "Receipt",
            tone: "bg-app-bg-2 text-app-fg-3",
            classNames: "app-stack app-stack-front",
          },
        ].map((chip, i) => (
          <span
            key={chip.label}
            className={cn(
              "inline-flex items-center h-7 px-2.5 rounded-lg text-[11px] font-medium",
              "shadow-[var(--app-shadow-elevated)]",
              chip.tone,
              chip.classNames,
            )}
            style={{ transitionDelay: `${i * 30}ms` }}
          >
            {chip.label}
          </span>
        ))}
      </div>
    </div>
  );
}
