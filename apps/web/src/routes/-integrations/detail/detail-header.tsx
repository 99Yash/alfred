import {
  credentialProviderOf,
  INTEGRATIONS,
  isLiveProviderSlug,
  isTokenPasteSlug,
  type LiveProviderSlug,
  type TokenPasteSlug,
} from "@alfred/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type KeyboardEvent } from "react";
import { GoogleConsentDialog } from "~/components/onboarding/google-consent-dialog";
import { AppButton, AppInput } from "~/components/ui/v2";
import { responseErrorMessage } from "~/lib/api-error";
import { client, API_URL } from "~/lib/eden";
import { IntegrationIcon } from "~/lib/integrations/integration-icons";
import { connectPathFor, type IntegrationPage } from "~/lib/integrations/integrations";
import { INTEGRATION_STATUS_QUERY_KEY } from "~/lib/integrations/use-integration-status";
import { toast } from "~/lib/toast";

/**
 * The connect action reads the registry entry's credential: a planned provider
 * renders a disabled "Coming Soon"; a `token_paste` credential renders the form
 * its `TOKEN_PASTE_FORMS` row declares; every other live credential redirects to
 * the path `connectPathFor` builds (the provider's route family plus, for a
 * Google product, the `?features=` its entry declares).
 */
function ConnectAction({ provider, connected }: { provider: IntegrationPage; connected: boolean }) {
  if (!isLiveProviderSlug(provider.slug)) {
    return (
      <AppButton variant="white" size="lg" disabled>
        Coming Soon
      </AppButton>
    );
  }
  if (isTokenPasteSlug(provider.slug)) {
    return <TokenPasteConnect slug={provider.slug} connected={connected} />;
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
 * The `token_paste` connect flow. Neither Railway nor Sentry has a public
 * OAuth for this use, so the user pastes a token they generated themselves. We
 * POST it to the provider's connect route (which validates it upstream before
 * storing) and refresh the credential query on success so the tile flips to
 * "Connected". The table below is the per-provider half: what the user pastes,
 * where to get it, whether the route needs a second field beside the token, and
 * the typed Eden call. Its key set is the registry's token-paste slugs, so a new
 * `token_paste` credential cannot ship without a form.
 */
interface TokenPasteForm {
  tokenPlaceholder: string;
  /** Where the user generates the token. */
  tokenUrl: string;
  /**
   * A second identifier the connect route needs beside the token (Sentry's
   * organization slug), or `undefined` when the token alone names the account.
   */
  scope?: { placeholder: string } | undefined;
  submit(values: {
    token: string;
    scope: string;
  }): Promise<{ error: { status: number; value: unknown } | null }>;
}

const TOKEN_PASTE_FORMS = {
  railway: {
    tokenPlaceholder: "Railway workspace or account token",
    tokenUrl: "https://railway.com/account/tokens",
    submit: ({ token }) => client.api.integrations.railway.connect.post({ token }),
  },
  sentry: {
    tokenPlaceholder: "Sentry internal integration token",
    tokenUrl: "https://sentry.io/settings/developer-settings/",
    scope: { placeholder: "Sentry organization slug" },
    submit: ({ token, scope }) =>
      client.api.integrations.sentry.connect.post({ token, organization: scope }),
  },
} satisfies Record<TokenPasteSlug, TokenPasteForm>;

function TokenPasteConnect({ slug, connected }: { slug: TokenPasteSlug; connected: boolean }) {
  const form: TokenPasteForm = TOKEN_PASTE_FORMS[slug];
  const name = INTEGRATIONS[slug].displayName;
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [scope, setScope] = useState("");
  const [pending, setPending] = useState(false);
  const complete = token.trim().length > 0 && (!form.scope || scope.trim().length > 0);

  async function submit() {
    if (!complete) return;
    setPending(true);
    try {
      const res = await form.submit({ token: token.trim(), scope: scope.trim() });
      if (res.error) {
        // The connect route distinguishes a wrong token, a missing installation,
        // an unconfigured server, and an upstream outage; show its message.
        toast.error(responseErrorMessage(res.error.value, res.error.status, `Connect ${name}`));
        return;
      }
      toast.success(`Connected ${name}`);
      setToken("");
      setScope("");
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

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") void submit();
    if (e.key === "Escape") setOpen(false);
  };

  return (
    <div className="flex flex-col items-end gap-2">
      {form.scope ? (
        <AppInput
          autoFocus
          value={scope}
          placeholder={form.scope.placeholder}
          className="w-64"
          onChange={(e) => setScope(e.target.value)}
          onKeyDown={onKeyDown}
        />
      ) : null}
      <AppInput
        type="password"
        autoFocus={!form.scope}
        value={token}
        placeholder={form.tokenPlaceholder}
        className="w-64"
        onChange={(e) => setToken(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="flex items-center gap-2">
        <a
          href={form.tokenUrl}
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
          disabled={pending || !complete}
        >
          {pending ? "Connecting…" : "Save"}
        </AppButton>
      </div>
    </div>
  );
}
