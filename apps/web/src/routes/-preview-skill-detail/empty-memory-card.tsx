import { Sparkles } from "lucide-react";
import { VsCard } from "~/components/ui/visitors";
import { Kbd } from "./kbd";

export function EmptyMemoryCard() {
  return (
    <VsCard className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <span
        className="grid size-10 place-items-center rounded-xl bg-vs-bg-2 text-vs-fg-3"
        aria-hidden
      >
        <Sparkles size={18} />
      </span>
      <p className="text-sm font-medium text-vs-fg-4">No memory yet</p>
      <p className="max-w-[28rem] text-xs leading-5 text-vs-fg-3">
        Write a prompt above and press <Kbd inline>⌘↵</Kbd> to author the first revision.
      </p>
    </VsCard>
  );
}
