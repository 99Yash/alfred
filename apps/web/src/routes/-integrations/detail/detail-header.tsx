import { credentialProviderOf, isLiveProviderSlug, type LiveProviderSlug } from "@alfred/contracts";
import { useState } from "react";
import { GoogleConsentDialog } from "~/components/onboarding/google-consent-dialog";
import { AppButton } from "~/components/ui/v2";
import { API_URL } from "~/lib/eden";
import { IntegrationIcon } from "~/lib/integrations/integration-icons";
import { connectPathFor, type IntegrationPage } from "~/lib/integrations/integrations";
import { openAuthorizationTab } from "~/lib/integrations/authorization-tab";

/** Planned: disabled "Coming Soon". Otherwise: redirect to `connectPathFor`. */
function ConnectAction({ provider, connected }: { provider: IntegrationPage; connected: boolean }) {
  if (!isLiveProviderSlug(provider.slug)) {
    return (
      <AppButton variant="white" size="lg" disabled>
        Coming Soon
      </AppButton>
    );
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

/** OAuth redirect providers. */
function RedirectConnect({ slug, connected }: { slug: LiveProviderSlug; connected: boolean }) {
  // Google gets consent coaching first: one grant covers Workspace, and the
  // unverified-app screens need explaining. Other providers redirect directly.
  const [consentOpen, setConsentOpen] = useState(false);
  const isGoogle = credentialProviderOf(slug) === "google";
  const label = connected ? "Add Account" : "Connect";

  const redirect = () => {
    openAuthorizationTab(`${API_URL}${connectPathFor(slug)}`);
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
