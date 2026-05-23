import type { ReactNode } from "react";

export function SectionHeading({ children }: { children: ReactNode }) {
  return <h2 className="text-sm font-medium text-vs-fg-4">{children}</h2>;
}
