import { Gift } from "lucide-react";
import { FeaturesSection } from "./features-section";
import type { SectionId } from "./helpers";
import { PlaceholderCard } from "./placeholder-card";
import { PreferencesSection } from "./preferences-section";
import { UserSection } from "./user-section";

export function SectionPanel({ section }: { section: SectionId }) {
  if (section === "user") return <UserSection />;
  if (section === "features") return <FeaturesSection />;
  if (section === "preferences") return <PreferencesSection />;
  return (
    <PlaceholderCard
      icon={Gift}
      title="Referrals"
      description="Invite teammates and share referral credit."
    />
  );
}
