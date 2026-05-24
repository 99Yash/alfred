import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { VsButton } from "~/components/ui/visitors";
import { authClient } from "~/lib/auth-client";
import { GoogleMark } from "./google-mark";

const GOOGLE_LEADING = <GoogleMark />;
const ARROW_TRAILING = <ArrowRight size={14} />;

export function AuthPanel() {
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
        callbackURL: `${window.location.origin}/`,
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
          <div
            aria-hidden
            className="inline-flex items-center justify-center size-9 rounded-2xl bg-vs-fg-4 text-vs-bg-1 mb-1 shadow-[0_1px_2px_rgba(0,0,0,0.10)]"
          >
            <span className="text-base font-medium leading-none">A</span>
          </div>
          <h1 className="text-[22px] font-medium tracking-[-0.04em] text-vs-fg-4 leading-tight">Sign in to Alfred</h1>
          <p className="text-sm text-vs-fg-2">Your personal assistant, on email and calendar.</p>
        </div>

        <VsButton
          variant="primary"
          size="lg"
          onClick={handleGoogle}
          loading={loading}
          leading={loading ? undefined : GOOGLE_LEADING}
          trailing={loading ? undefined : ARROW_TRAILING}
          className="w-full"
        >
          {loading ? "Redirecting…" : "Continue with Google"}
        </VsButton>

        {error ? (
          <p role="alert" className="text-xs text-vs-red-4 text-center">
            {error}
          </p>
        ) : null}

        <p className="text-center text-[11px] text-vs-fg-2">
          Alfred is private to you. Only the allowlisted Google account can sign in.
        </p>
      </div>
    </div>
  );
}
