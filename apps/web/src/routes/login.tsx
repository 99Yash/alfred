import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowRight, KeyRound, Mail } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { authClient } from "~/lib/auth-client";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [step, setStep] = useState<"email" | "otp">("email");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement | null>(null);
  const otpRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (step === "email") emailRef.current?.focus();
    else otpRef.current?.focus();
  }, [step]);

  const sendOtp = async () => {
    setLoading(true);
    setError(null);
    try {
      await authClient.emailOtp.sendVerificationOtp({ email, type: "sign-in" });
      setStep("otp");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send code");
    } finally {
      setLoading(false);
    }
  };

  const verify = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await authClient.signIn.emailOtp({ email, otp });
      if (result.data) {
        await navigate({ to: "/" });
      } else {
        setError("Invalid or expired code");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-[100dvh] grid place-items-center px-6 py-12 overflow-hidden">
      {/* Soft radial glow centerpiece — quiet, theme-aware */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 -z-10",
          "[background:radial-gradient(60%_60%_at_50%_30%,color-mix(in_oklch,var(--color-foreground)_4%,transparent),transparent)]",
        )}
      />

      <div className="w-full max-w-sm space-y-8">
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center size-10 rounded-2xl bg-foreground text-background mb-2">
            <span className="font-serif text-lg leading-none">A</span>
          </div>
          <h1 className="font-serif text-3xl tracking-tight">Alfred</h1>
          <p className="text-sm text-muted-foreground">
            {step === "email"
              ? "Sign in with your email to continue."
              : (
                <>
                  We sent a 6-digit code to{" "}
                  <span className="font-medium text-foreground">{email}</span>.
                </>
              )}
          </p>
        </div>

        <div className="rounded-xl border bg-card shadow-soft p-5 space-y-4">
          {step === "email" ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (email && !loading) sendOtp();
              }}
              className="space-y-3"
            >
              <Field icon={<Mail size={15} />}>
                <input
                  ref={emailRef}
                  type="email"
                  value={email}
                  inputMode="email"
                  autoComplete="email"
                  required
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
                />
              </Field>

              <SubmitButton loading={loading} disabled={!email}>
                Send code <ArrowRight size={14} />
              </SubmitButton>
            </form>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (otp.length >= 6 && !loading) verify();
              }}
              className="space-y-3"
            >
              <Field icon={<KeyRound size={15} />}>
                <input
                  ref={otpRef}
                  type="text"
                  value={otp}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="\d{6}"
                  maxLength={6}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                  placeholder="123 456"
                  className="w-full bg-transparent text-sm outline-none tracking-[0.4em] tabular placeholder:text-muted-foreground/70"
                />
              </Field>

              <SubmitButton loading={loading} disabled={otp.length < 6}>
                Verify & sign in <ArrowRight size={14} />
              </SubmitButton>

              <button
                type="button"
                onClick={() => {
                  setStep("email");
                  setOtp("");
                  setError(null);
                }}
                className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Use a different email
              </button>
            </form>
          )}

          {error ? (
            <p className="text-xs text-destructive text-center">{error}</p>
          ) : null}
        </div>

        <p className="text-center text-[11px] text-muted-foreground/70">
          Alfred is private to you. Only the allowlisted email can sign in.
        </p>
      </div>
    </div>
  );
}

function Field({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <label
      className={cn(
        "flex items-center gap-2 rounded-md border bg-background px-3 py-2",
        "focus-within:ring-2 focus-within:ring-ring/40 focus-within:border-foreground/40",
        "transition-shadow",
      )}
    >
      <span className="text-muted-foreground">{icon}</span>
      {children}
    </label>
  );
}

function SubmitButton({
  loading,
  disabled,
  children,
}: {
  loading: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="submit"
      disabled={loading || disabled}
      className={cn(
        "w-full inline-flex items-center justify-center gap-1.5 rounded-md",
        "bg-foreground text-background px-4 py-2 text-sm font-medium",
        "hover:bg-foreground/90 transition-colors",
        "disabled:opacity-50 disabled:cursor-not-allowed",
      )}
    >
      {loading ? "Working…" : children}
    </button>
  );
}
