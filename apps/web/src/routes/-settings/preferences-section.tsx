import { Bell, Bot, Sparkles, Volume2 } from "lucide-react";
import { useState } from "react";
import type { ChatSoundPreference } from "~/lib/chat/use-run-complete";
import { getLocalStorageItem, setLocalStorageItem } from "~/lib/storage/storage";
import { AppSegmented, type AppSegmentedItem, AppSwitch } from "~/components/ui/v2";
import { SettingCard } from "./setting-card";

const SOUND_ITEMS: ReadonlyArray<AppSegmentedItem<ChatSoundPreference>> = [
  { value: "unfocused", label: "When away" },
  { value: "always", label: "Always" },
  { value: "mute", label: "Off" },
];

export function PreferencesSection() {
  const [productUpdates, setProductUpdates] = useState(true);
  const [soundPref, setSoundPref] = useState<ChatSoundPreference>(() =>
    getLocalStorageItem("alfred.chat.soundPreference"),
  );

  const onSoundPrefChange = (next: ChatSoundPreference) => {
    setSoundPref(next);
    setLocalStorageItem("alfred.chat.soundPreference", next);
  };

  return (
    <>
      <SettingCard
        title="Default model"
        description="Model Alfred uses to reason. Picker lands with milestone 13."
        icon={Bot}
        tone="purple"
      >
        <div className="inline-flex h-9 items-center gap-2 rounded-xl bg-app-bg-2 px-3 text-sm text-app-fg-3">
          <Sparkles size={13} className="text-app-fg-2" />
          <span>Alfred (default)</span>
        </div>
      </SettingCard>

      <SettingCard
        title="Reply notifications"
        description="Chime + a toast when Alfred finishes a reply. 'When away' only fires while this tab is in the background."
        icon={Volume2}
        tone="sky"
        action={
          <AppSegmented
            label="When the reply chime plays"
            value={soundPref}
            onValueChange={onSoundPrefChange}
            items={SOUND_ITEMS}
          />
        }
      />

      <SettingCard
        title="Product updates"
        description="Get notified about new features and improvements."
        icon={Bell}
        tone="amber"
        noDivider
        action={
          <AppSwitch
            checked={productUpdates}
            onCheckedChange={setProductUpdates}
            aria-label="Product updates"
          />
        }
      />
    </>
  );
}
