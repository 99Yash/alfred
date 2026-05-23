import { FactCard } from "./fact-card";

export function ResearchHero({ accent }: { accent: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="relative w-[78%] h-[80px]">
        <FactCard className="vs-stack vs-stack-back top-0 -translate-x-2 rotate-[-3deg] opacity-60" />
        <FactCard className="vs-stack vs-stack-mid top-3 left-2 rotate-[0deg]" />
        <FactCard
          className="vs-stack vs-stack-front top-6 left-6 rotate-[3deg]"
          highlight
          accent={accent}
        />
      </div>
    </div>
  );
}
