import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { cn } from "~/lib/utils";

export function BackLink() {
  return (
    <Link
      to="/skills"
      className={cn(
        "inline-flex items-center gap-1.5 text-xs text-app-fg-3",
        "transition-colors hover:text-app-fg-4",
        "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background rounded",
      )}
    >
      <ArrowLeft size={12} /> All skills
    </Link>
  );
}
