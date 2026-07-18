import { FeaturesSection } from "./features-section";
import type { SectionId } from "./helpers";
import { PreferencesSection } from "./preferences-section";
import { UsageSection } from "./usage/usage-section";
import { UserSection } from "./user-section";

export function SectionPanel({ section }: { section: SectionId }) {
  switch (section) {
    case "user":
      return <UserSection />;
    case "features":
      return <FeaturesSection />;
    case "usage":
      return <UsageSection />;
    case "preferences":
      return <PreferencesSection />;
  }
}
