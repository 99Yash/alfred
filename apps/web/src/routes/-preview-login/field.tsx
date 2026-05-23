import { cn } from "~/lib/utils";

export function Field({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <label
      className={cn(
        "flex items-center gap-2 rounded-xl bg-vs-bg-1 px-3 h-10",
        "vs-elevated",
        "focus-within:ring-2 focus-within:ring-vs-purple-2 focus-within:ring-offset-4 focus-within:ring-offset-vs-background",
        "transition-shadow",
      )}
    >
      <span className="text-vs-fg-2">{icon}</span>
      {children}
    </label>
  );
}
