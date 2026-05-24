import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { cn } from "~/lib/utils";

export function BackLink() {
  return (
    <Link
      to="/workflows"
      className={cn(
        "inline-flex items-center gap-2 text-sm text-vs-fg-3",
        "transition-colors hover:text-vs-fg-4",
        "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background rounded",
      )}
    >
      <ArrowLeft size={14} />
      All workflows
    </Link>
  );
}
