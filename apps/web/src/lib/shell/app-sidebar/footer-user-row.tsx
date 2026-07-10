import { Link, useNavigate } from "@tanstack/react-router";
import { Settings } from "lucide-react";
import { useState } from "react";
import { authClient } from "~/lib/auth/auth-client";
import type { SessionUser } from "~/lib/user-display";
import { cn } from "~/lib/utils";
import { NavLink, RailTip } from "./navigation-primitives";

export function FooterRow({ path }: { path: string }) {
  return (
    <div className="px-2 pb-1">
      <NavLink
        icon={Settings}
        label="Settings"
        to="/settings"
        active={path.startsWith("/settings")}
      />
    </div>
  );
}

/** Collapsed-rail avatar mirroring the expanded footer's user identity. */
export function RailUserButton() {
  const { name, email, initial } = useUserRow();
  const label = name || email || "Account";
  return (
    <RailTip label={label}>
      <Link
        to="/settings"
        aria-label={`${label} — settings`}
        className={cn(
          "app-press inline-flex size-9 shrink-0 items-center justify-center rounded-xl",
          "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2",
        )}
      >
        <span
          aria-hidden
          className="inline-flex size-7 items-center justify-center rounded-full bg-app-pink-4 text-xs font-semibold text-white"
        >
          {initial}
        </span>
      </Link>
    </RailTip>
  );
}

function useUserRow() {
  const { data: session } = authClient.useSession();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);

  const email = session?.user?.email ?? "";
  const name = displayName(session?.user);
  const initial = (name || email || "·").charAt(0).toUpperCase();

  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await authClient.signOut();
    } catch (err) {
      console.error("Sign out failed", err instanceof Error ? err.message : String(err));
    } finally {
      await navigate({ to: "/login" });
      setSigningOut(false);
    }
  };

  return { name, email, initial, signingOut, signOut };
}

function displayName(user: SessionUser | null | undefined): string {
  if (!user) return "";
  if (user.name && user.name.trim()) return user.name.trim().split(/\s+/)[0] ?? "";
  if (user.email) return user.email.split("@")[0] ?? "";
  return "";
}
