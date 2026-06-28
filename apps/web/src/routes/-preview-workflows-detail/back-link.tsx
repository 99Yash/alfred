import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { cn } from "~/lib/utils";

export function BackLink() {
  return (
    <Link
      to="/workflows"
      className={cn(
        "inline-flex items-center gap-2 text-sm text-app-fg-3",
        "transition-colors hover:text-app-fg-4",
        "rounded outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
      )}
    >
      <ArrowLeft size={14} />
      All workflows
    </Link>
  );
}
