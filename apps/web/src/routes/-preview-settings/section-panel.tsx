import { FeaturesSection } from "./features-section";
import type { SectionId } from "./helpers";
import { PreferencesSection } from "./preferences-section";
import { UserSection } from "./user-section";

export function SectionPanel({ section }: { section: SectionId }) {
  if (section === "user") return <UserSection />;
  if (section === "features") return <FeaturesSection />;
  return <PreferencesSection />;
}
