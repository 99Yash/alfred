import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AppButton, AppInput } from "~/components/ui/v2";
import { client } from "~/lib/eden";
import { IntegrationIcon } from "~/lib/integration-icons";
import type { IntegrationProvider } from "~/lib/integrations";
import { toast } from "~/lib/toast";

const API_URL =
  (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL ?? "http://localhost:3001";

/**
 * Provider id → API path that initiates the OAuth flow (with optional
 * `?features=` narrowing). Absent ids either have no wired backend
 * (status: "soon", CTA renders disabled) or use a non-redirect connect flow
 * handled below (Railway pastes a token).
 *
 * Per-provider features:
 *  - Gmail → `?features=briefing,triage,reply_draft`: requests the full
 *    Gmail grant so every downstream workflow works without an extra
 *    re-consent, but explicitly excludes Calendar so the Gmail tile's
 *    consent screen doesn't ask for calendar access. (Calendar lives in
 *    `GOOGLE_FEATURE_SCOPES` and would otherwise be picked up by the
 *    no-arg default.)
 *  - Calendar → `?features=calendar`: ask only for calendar scopes so
 *    a Gmail-already-connected user sees a focused consent screen.
 *    Google's `include_granted_scopes=true` merges this into their
 *    existing grant.
 */
const CONNECT_PATHS: Readonly<Record<string, string>> = {
  google_gmail: "/api/integrations/google/connect?features=briefing,triage,reply_draft",
  google_calendar: "/api/integrations/google/connect?features=calendar",
  github: "/api/integrations/github/connect",
  notion: "/api/integrations/notion/connect",
  vercel: "/api/integrations/vercel/connect",
};

export function DetailHeader({
  provider,
  connected,
}: {
  provider: IntegrationProvider;
  connected: boolean;
}) {
  return (
    <header className="flex items-start justify-between gap-4 app-card-in">
      <div className="flex min-w-0 items-start gap-3">
        <IntegrationIcon
          brand={provider.brand}
          size="md"
          connected={connected}
          title={provider.name}
        />
        <div className="min-w-0 pt-0.5">
          <h1 className="text-base font-medium text-app-fg-4 tracking-tight">{provider.name}</h1>
          <p className="mt-1 text-[12.5px] leading-5 text-app-fg-3">{provider.description}</p>
        </div>
      </div>
      {provider.id === "railway" ? (
        <RailwayConnect connected={connected} />
      ) : (
        <RedirectConnect provider={provider} connected={connected} />
      )}
    </header>
  );
}

/** OAuth/redirect providers (Google, GitHub, Notion, Vercel). */
function RedirectConnect({
  provider,
  connected,
}: {
  provider: IntegrationProvider;
  connected: boolean;
}) {
  const path = CONNECT_PATHS[provider.id];
  const wired = Boolean(path);
  const label = connected ? "Add Account" : wired ? "Connect" : "Coming Soon";
  const onConnect = wired
    ? () => {
        window.location.href = `${API_URL}${path}`;
      }
    : undefined;
  return (
    <AppButton variant="white" size="lg" disabled={!wired} onClick={onConnect}>
      {label}
    </AppButton>
  );
}

/**
 * Railway has no OAuth — the user pastes an account API token. We POST it to
 * the connect route (which validates it against Railway before storing) and
 * refresh the credential query on success so the tile flips to "Connected".
 */
function RailwayConnect({ connected }: { connected: boolean }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);

  async function submit() {
    const trimmed = token.trim();
    if (!trimmed) return;
    setPending(true);
    try {
      const res = await client.api.integrations.railway.connect.post({ token: trimmed });
      if (res.error) {
        toast.error("Railway rejected that token — check it and try again");
        return;
      }
      toast.success("Connected Railway");
      setToken("");
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["integrations", "railway", "credentials"] });
    } catch {
      toast.error("Couldn't reach the server — try again");
    } finally {
      setPending(false);
    }
  }

  if (!open) {
    return (
      <AppButton variant="white" size="lg" onClick={() => setOpen(true)}>
        {connected ? "Add Token" : "Connect"}
      </AppButton>
    );
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <AppInput
        type="password"
        autoFocus
        value={token}
        placeholder="Railway account API token"
        className="w-64"
        onChange={(e) => setToken(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
          if (e.key === "Escape") setOpen(false);
        }}
      />
      <div className="flex items-center gap-2">
        <a
          href="https://railway.com/account/tokens"
          target="_blank"
          rel="noreferrer"
          className="text-[11.5px] text-app-fg-2 underline-offset-2 hover:underline"
        >
          Get a token
        </a>
        <AppButton variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </AppButton>
        <AppButton variant="white" size="sm" onClick={() => void submit()} disabled={pending || !token.trim()}>
          {pending ? "Connecting…" : "Save"}
        </AppButton>
      </div>
    </div>
  );
}
