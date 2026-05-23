import {
  VsThemed,
  VsThemeProvider,
  VsThemeToggle,
} from "~/components/ui/visitors";
import { AuthPanel } from "./auth-panel";
import { ShowcasePanel } from "./showcase-panel";

export function PreviewLoginPage() {
  return (
    <VsThemeProvider>
      <VsThemed className="relative min-h-dvh bg-vs-background-subtle">
        <div className="absolute top-3 right-3 z-50">
          <VsThemeToggle />
        </div>
        <div className="grid min-h-dvh lg:grid-cols-2">
          <AuthPanel />
          <ShowcasePanel />
        </div>
      </VsThemed>
    </VsThemeProvider>
  );
}
