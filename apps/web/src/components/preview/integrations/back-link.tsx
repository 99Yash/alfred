import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { cn } from "~/lib/utils";

export function BackLink() {
  return (
    <Link
      to="/integrations"
      className={cn(
        "inline-flex items-center gap-2 rounded-lg h-8 -ml-1 px-2 text-sm",
        "text-app-fg-3 hover:text-app-fg-4 hover:bg-app-bg-a2 transition-colors app-press",
        "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
      )}
    >
      <ArrowLeft size={14} />
      All integrations
    </Link>
  );
}
