import {
  credentialProviderOf,
  INTEGRATIONS,
  isLiveProviderSlug,
  type LiveProviderSlug,
} from "@alfred/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { GoogleConsentDialog } from "~/components/onboarding/google-consent-dialog";
import { AppButton, AppInput } from "~/components/ui/v2";
import { client, API_URL } from "~/lib/eden";
import { IntegrationIcon } from "~/lib/integrations/integration-icons";
import { connectPathFor, type IntegrationPage } from "~/lib/integrations/integrations";
import { INTEGRATION_STATUS_QUERY_KEY } from "~/lib/integrations/use-integration-status";
import { toast } from "~/lib/toast";

/**
 * The connect action reads the registry entry's credential: a planned provider
 * renders a disabled "Coming Soon"; a `token_paste` credential renders a form
 * that POSTs the token; every other live credential redirects to the path
 * `connectPathFor` builds (the provider's route family plus, for a Google
 * product, the `?features=` its entry declares).
 */
function ConnectAction({ provider, connected }: { provider: IntegrationPage; connected: boolean }) {
  if (!isLiveProviderSlug(provider.slug)) {
    return (
      <AppButton variant="white" size="lg" disabled>
        Coming Soon
      </AppButton>
    );
  }
  const credential = INTEGRATIONS[provider.slug].credential;
  if (credential.shape === "bearer" && credential.connect === "token_paste") {
    return <RailwayConnect connected={connected} />;
  }
  return <RedirectConnect slug={provider.slug} connected={connected} />;
}

export function DetailHeader({
  provider,
  connected,
}: {
  provider: IntegrationPage;
  connected: boolean;
}) {
  return (
    <header className="app-card-in flex items-start justify-between gap-4">
      <div className="flex min-w-0 items-start gap-3">
        <IntegrationIcon
          brand={provider.brand}
          size="md"
          connected={connected}
          title={provider.name}
        />
        <div className="min-w-0 pt-0.5">
          <h1 className="text-base font-medium tracking-tight text-app-fg-4">{provider.name}</h1>
          <p className="mt-1 text-[12.5px] leading-5 text-app-fg-3">{provider.description}</p>
        </div>
      </div>
      <ConnectAction provider={provider} connected={connected} />
    </header>
  );
}

/** OAuth/redirect providers (Google, GitHub, Notion, Vercel). */
function RedirectConnect({ slug, connected }: { slug: LiveProviderSlug; connected: boolean }) {
  // Google providers gate the redirect behind consent coaching: one grant
  // covers the whole Workspace, and an unverified app trips two consent-screen
  // gotchas (uncheckable per-scope boxes + the "unverified app" interstitial)
  // that the dialog pre-explains. Other OAuth providers carry no such gotcha,
  // so they redirect straight through. Mirrors the onboarding flow.
  const [consentOpen, setConsentOpen] = useState(false);
  const isGoogle = credentialProviderOf(slug) === "google";
  const label = connected ? "Add Account" : "Connect";

  const redirect = () => {
    window.location.href = `${API_URL}${connectPathFor(slug)}`;
  };
  const onConnect = isGoogle ? () => setConsentOpen(true) : redirect;

  return (
    <>
      {isGoogle ? (
        <GoogleConsentDialog
          open={consentOpen}
          onOpenChange={setConsentOpen}
          onConfirm={() => {
            setConsentOpen(false);
            redirect();
          }}
        />
      ) : null}
      <AppButton variant="white" size="lg" onClick={onConnect}>
        {label}
      </AppButton>
    </>
  );
}

/**
 * The `token_paste` connect flow. Railway has no OAuth — the user pastes an
 * account or workspace API token. We POST it to the connect route (which
 * validates it against Railway before storing) and refresh the credential
 * query on success so the tile flips to "Connected". Railway is the one
 * `token_paste` credential today; the Eden path below is its mechanics.
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
      await queryClient.invalidateQueries({ queryKey: INTEGRATION_STATUS_QUERY_KEY });
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
        placeholder="Railway workspace or account token"
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
        <AppButton
          variant="white"
          size="sm"
          onClick={() => void submit()}
          disabled={pending || !token.trim()}
        >
          {pending ? "Connecting…" : "Save"}
        </AppButton>
      </div>
    </div>
  );
}
