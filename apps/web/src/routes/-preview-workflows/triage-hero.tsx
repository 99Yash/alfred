import { cn } from "~/lib/utils";

export function TriageHero({ accent }: { accent: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="relative flex items-center gap-2">
        {[
          { label: "Inbox", tone: "bg-vs-bg-2 text-vs-fg-3" },
          { label: "Action", tone: cn("bg-vs-bg-1", accent), classNames: "vs-stack vs-stack-mid" },
          { label: "Newsletter", tone: "bg-vs-bg-2 text-vs-fg-3", classNames: "vs-stack vs-stack-back" },
          { label: "Receipt", tone: "bg-vs-bg-2 text-vs-fg-3", classNames: "vs-stack vs-stack-front" },
        ].map((chip, i) => (
          <span
            key={chip.label}
            className={cn(
              "inline-flex items-center h-7 px-2.5 rounded-lg text-[11px] font-medium",
              "shadow-[var(--vs-shadow-elevated)]",
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
