import { Sparkles } from "lucide-react";
import { AppCard } from "~/components/ui/v2";
import { Kbd } from "./kbd";

export function EmptyMemoryCard() {
  return (
    <AppCard className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <span
        className="grid size-10 place-items-center rounded-xl bg-app-bg-2 text-app-fg-3"
        aria-hidden
      >
        <Sparkles size={18} />
      </span>
      <p className="text-sm font-medium text-app-fg-4">No memory yet</p>
      <p className="max-w-[28rem] text-xs leading-5 text-app-fg-3">
        Add instructions above and press <Kbd inline>⌘↵</Kbd> to author the first revision.
      </p>
    </AppCard>
  );
}
