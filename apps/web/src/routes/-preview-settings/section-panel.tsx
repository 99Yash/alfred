import { FeaturesSection } from "./features-section";
import type { SectionId } from "./helpers";
import { PreferencesSection } from "./preferences-section";
import { UserSection } from "./user-section";

export function SectionPanel({ section }: { section: SectionId }) {
  switch (section) {
    case "user":
      return <UserSection />;
    case "features":
      return <FeaturesSection />;
    case "preferences":
      return <PreferencesSection />;
  }
}
