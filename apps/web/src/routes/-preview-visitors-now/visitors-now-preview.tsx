import { VsThemeProvider } from "~/components/ui/visitors";
import { VsThemedPreview } from "./vs-themed-preview";

export function VisitorsNowPreview() {
  return (
    <VsThemeProvider>
      <VsThemedPreview />
    </VsThemeProvider>
  );
}
