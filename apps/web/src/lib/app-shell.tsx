import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { Brain, ChevronLeft, ChevronRight, FileText, LogOut, Sparkles } from "lucide-react";
import { useState, type ComponentType } from "react";
import { authClient } from "~/lib/auth-client";
import { cn } from "~/lib/utils";

type IconComponent = ComponentType<{ size?: number; className?: string }>;

const NAV: ReadonlyArray<{ to: string; label: string; icon: IconComponent }> = [
  { to: "/skills", label: "Skills", icon: Sparkles },
  { to: "/memory", label: "Memory", icon: Brain },
  { to: "/notes", label: "Notes", icon: FileText },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const { data: session, isPending } = authClient.useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(false);

  if (isPending || !session?.user || location.pathname === "/login") {
    return <>{children}</>;
  }

  const signOut = async () => {
    await authClient.signOut();
    await navigate({ to: "/login" });
  };

  const initial = session.user.email?.[0]?.toUpperCase() ?? "?";

  return (
    <div className="flex min-h-screen">
      <aside
        className={cn(
          "shrink-0 border-r bg-muted/30 flex flex-col transition-[width] duration-150",
          collapsed ? "w-14" : "w-56",
        )}
      >
        <div className="flex items-center gap-2 px-3 py-3 border-b">
          <div className="size-7 rounded-full bg-primary/10 flex items-center justify-center text-xs font-medium shrink-0">
            {initial}
          </div>
          {!collapsed ? (
            <span className="text-xs text-muted-foreground truncate flex-1">
              {session.user.email}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="text-muted-foreground hover:text-foreground"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          </button>
        </div>

        <nav className="flex-1 py-2 space-y-0.5">
          {NAV.map((item) => {
            const active = location.pathname.startsWith(item.to);
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "flex items-center gap-3 mx-2 px-2 py-1.5 rounded-md text-sm",
                  active
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
                )}
                title={collapsed ? item.label : undefined}
              >
                <Icon size={16} className="shrink-0" />
                {!collapsed ? <span>{item.label}</span> : null}
              </Link>
            );
          })}
        </nav>

        <div className="border-t py-2">
          <button
            type="button"
            onClick={signOut}
            className="flex items-center gap-3 mx-2 px-2 py-1.5 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-accent/50 w-[calc(100%-1rem)]"
            title={collapsed ? "Sign out" : undefined}
          >
            <LogOut size={16} className="shrink-0" />
            {!collapsed ? <span>Sign out</span> : null}
          </button>
        </div>
      </aside>

      <main className="flex-1 min-w-0">{children}</main>
    </div>
  );
}
