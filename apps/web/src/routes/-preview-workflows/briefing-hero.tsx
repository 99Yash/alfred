import { EmailRow } from "./email-row";

export function BriefingHero({ accent }: { accent: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      {/* Three stacked email rows, slightly fanned. Hover fans them more. */}
      <div className="relative w-[78%]">
        <EmailRow className="vs-stack vs-stack-back -translate-x-2 -translate-y-1 opacity-60" />
        <EmailRow className="vs-stack vs-stack-mid translate-y-2" />
        <EmailRow
          className="vs-stack vs-stack-front translate-x-3 translate-y-5"
          highlight
          accent={accent}
        />
      </div>
    </div>
  );
}
