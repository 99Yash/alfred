import { cn } from "~/lib/utils";

export function BriefRow({
  hue,
  lead,
  body,
}: {
  hue: "purple" | "sky" | "amber";
  lead: string;
  body: string;
}) {
  const dotClass =
    hue === "purple" ? "bg-app-purple-4" : hue === "sky" ? "bg-app-sky-4" : "bg-app-amber-4";
  return (
    <li className="flex items-start gap-2.5">
      <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", dotClass)} aria-hidden />
      <span className="text-app-fg-3 leading-snug">
        <span className="text-app-fg-4 font-medium">{lead}</span>
        <span className="text-app-fg-2">: </span>
        {body}
      </span>
    </li>
  );
}
