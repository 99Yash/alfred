import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { cn } from "~/lib/utils";

export function BackLink() {
  return (
    <Link
      to="/integrations"
      className={cn(
        "-ml-1 inline-flex h-8 items-center gap-2 rounded-lg px-2 text-sm",
        "app-press text-app-fg-3 transition-colors hover:bg-app-bg-a2 hover:text-app-fg-4",
        "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
      )}
    >
      <ArrowLeft size={14} />
      All integrations
    </Link>
  );
}
