import { Bell, Bot, Sparkles } from "lucide-react";
import { useState } from "react";
import { VsSwitch } from "~/components/ui/visitors";
import { SettingCard } from "./setting-card";

export function PreferencesSection() {
  const [productUpdates, setProductUpdates] = useState(true);

  return (
    <>
      <SettingCard
        title="Default model"
        description="Model Alfred uses to reason. Picker lands with milestone 13."
        icon={Bot}
        tone="purple"
      >
        <div className="inline-flex items-center gap-2 rounded-xl px-3 h-9 bg-vs-bg-2 text-sm text-vs-fg-3">
          <Sparkles size={13} className="text-vs-fg-2" />
          <span>Alfred (default)</span>
        </div>
      </SettingCard>

      <SettingCard
        title="Product updates"
        description="Get notified about new features and improvements."
        icon={Bell}
        tone="amber"
        noDivider
        action={<VsSwitch checked={productUpdates} onCheckedChange={setProductUpdates} />}
      />
    </>
  );
}
