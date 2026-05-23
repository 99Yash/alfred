import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { cn } from "~/lib/utils";

export function BackLink() {
  return (
    <Link
      to="/preview/integrations"
      className={cn(
        "inline-flex items-center gap-2 rounded-lg h-8 -ml-1 px-2 text-sm",
        "text-vs-fg-3 hover:text-vs-fg-4 hover:bg-vs-bg-a2 transition-colors vs-press",
        "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
      )}
    >
      <ArrowLeft size={14} />
      All integrations
    </Link>
  );
}
