import { BadgeDollarSign, Gift, PackageCheck } from "lucide-react";
import { FeaturesSection } from "./features-section";
import type { SectionId } from "./helpers";
import { PlaceholderCard } from "./placeholder-card";
import { PreferencesSection } from "./preferences-section";
import { UserSection } from "./user-section";

export function SectionPanel({ section }: { section: SectionId }) {
  if (section === "user") return <UserSection />;
  if (section === "features") return <FeaturesSection />;
  if (section === "preferences") return <PreferencesSection />;
  if (section === "billing") {
    return (
      <PlaceholderCard
        icon={BadgeDollarSign}
        title="Billing"
        description="Manage invoices, payment method, and billing contact."
      />
    );
  }
  if (section === "plan") {
    return (
      <PlaceholderCard
        icon={PackageCheck}
        title="Plan"
        description="Review your current plan and usage limits."
      />
    );
  }
  return (
    <PlaceholderCard
      icon={Gift}
      title="Referrals"
      description="Referral credit sharing arrives with billing."
    />
  );
}
