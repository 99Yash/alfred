import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { AppButton } from "~/components/ui/v2";
import { authClient } from "~/lib/auth/auth-client";
import { GoogleMark } from "./google-mark";

const GOOGLE_LEADING = <GoogleMark />;
const ARROW_TRAILING = <ArrowRight size={14} />;

export function AuthPanel({ redirect }: { redirect?: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGoogle = async () => {
    setLoading(true);
    setError(null);
    try {
      const { error: signInError } = await authClient.signIn.social({
        provider: "google",
        // Absolute URL so Better Auth doesn't resolve it against BETTER_AUTH_URL
        // (the server origin) and strand the user on :3001 after the OAuth callback.
        // `redirect` (sanitized in the route's validateSearch) returns the user to
        // wherever the auth guard bounced them from; default `/` for a cold sign-in.
        callbackURL: `${window.location.origin}${redirect ?? "/"}`,
      });
      if (signInError) {
        setError(signInError.message ?? "Couldn't start Google sign-in");
        setLoading(false);
      }
      // On success the browser is redirected to Google — no further state to set.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start Google sign-in");
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center px-6 py-12">
      <div className="w-full max-w-[360px] space-y-7">
        <div className="text-center space-y-2.5">
          <img
            src="/images/logo/alfred-logo.svg"
            alt="Alfred"
            aria-hidden
            className="inline-block size-9 rounded-2xl mb-1 shadow-[0_1px_2px_rgba(0,0,0,0.10)]"
          />
          <h1 className="text-[22px] font-medium tracking-[-0.04em] text-app-fg-4 leading-tight">
            Sign in to Alfred
          </h1>
          <p className="text-sm text-app-fg-2">One private workspace for the work around you.</p>
        </div>

        <AppButton
          variant="primary"
          size="lg"
          onClick={handleGoogle}
          loading={loading}
          leading={loading ? undefined : GOOGLE_LEADING}
          trailing={loading ? undefined : ARROW_TRAILING}
          className="w-full"
        >
          {loading ? "Redirecting…" : "Continue with Google"}
        </AppButton>

        {error ? (
          <p role="alert" className="text-xs text-app-red-4 text-center">
            {error}
          </p>
        ) : null}

        <p className="text-center text-[11px] text-app-fg-2">
          Alfred only signs in with your allowlisted Google account.
        </p>
      </div>
    </div>
  );
}
