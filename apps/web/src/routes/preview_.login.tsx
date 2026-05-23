import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowRight, KeyRound, Mail, Sparkles } from "lucide-react";
import { useEffect, useReducer, useRef, useState } from "react";
import {
  VsButton,
  VsThemed,
  VsThemeProvider,
  VsThemeToggle,
} from "~/components/ui/visitors";
import { authClient } from "~/lib/auth-client";
import { cn } from "~/lib/utils";

/**
 * Visitors-now-grammar port of `/login`. Mirrors the visitors.now sign-in
 * layout: a centered auth panel on the left (Google CTA above the OTP flow)
 * and a quiet brand showcase on the right at >=lg.
 *
 * The file name uses the trailing-underscore convention
 * (`preview_.login.tsx`) so the URL resolves to `/preview/login` but the
 * route does NOT nest under `preview.tsx` — login is a pre-shell surface
 * and should not inherit the sidebar.
 *
 * Google is rendered as the primary CTA per the long-term direction, but
 * stubbed — clicking surfaces a "coming soon" hint and focuses the email
 * field. Email-OTP remains the real, working path through `authClient`.
 */
export const Route = createFileRoute("/preview_/login")({
  component: PreviewLoginPage,
});

interface FlowState {
  step: "email" | "otp";
  loading: boolean;
  error: string | null;
}

type FlowAction =
  | { type: "submitting" }
  | { type: "code-sent" }
  | { type: "error"; message: string }
  | { type: "restart" };

const GOOGLE_LEADING = <GoogleMark />;
const ARROW_RIGHT_TRAILING = <ArrowRight size={14} />;

function flowReducer(state: FlowState, action: FlowAction): FlowState {
  switch (action.type) {
    case "submitting":
      return { ...state, loading: true, error: null };
    case "code-sent":
      return { step: "otp", loading: false, error: null };
    case "error":
      return { ...state, loading: false, error: action.message };
    case "restart":
      return { step: "email", loading: false, error: null };
  }
}

function PreviewLoginPage() {
  return (
    <VsThemeProvider>
      <VsThemed className="relative min-h-dvh bg-vs-background-subtle">
        <div className="absolute top-3 right-3 z-50">
          <VsThemeToggle />
        </div>
        <div className="grid min-h-dvh lg:grid-cols-2">
          <AuthPanel />
          <ShowcasePanel />
        </div>
      </VsThemed>
    </VsThemeProvider>
  );
}

function AuthPanel() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [googleHint, setGoogleHint] = useState(false);
  const [flow, dispatchFlow] = useReducer(flowReducer, {
    step: "email",
    loading: false,
    error: null,
  });
  const emailRef = useRef<HTMLInputElement | null>(null);
  const otpRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (flow.step === "email") emailRef.current?.focus();
    else otpRef.current?.focus();
  }, [flow.step]);

  const sendOtp = async () => {
    dispatchFlow({ type: "submitting" });
    try {
      const { error: otpError } = await authClient.emailOtp.sendVerificationOtp({
        email,
        type: "sign-in",
      });
      if (otpError) {
        dispatchFlow({ type: "error", message: otpError.message ?? "Failed to send code" });
        return;
      }
      dispatchFlow({ type: "code-sent" });
    } catch (err) {
      dispatchFlow({
        type: "error",
        message: err instanceof Error ? err.message : "Failed to send code",
      });
    }
  };

  const verify = async () => {
    dispatchFlow({ type: "submitting" });
    try {
      const { data, error: signInError } = await authClient.signIn.emailOtp({ email, otp });
      if (signInError) {
        dispatchFlow({
          type: "error",
          message: signInError.message ?? "Invalid or expired code",
        });
        return;
      }
      if (data) {
        await navigate({ to: "/" });
      } else {
        dispatchFlow({ type: "error", message: "Invalid or expired code" });
      }
    } catch (err) {
      dispatchFlow({
        type: "error",
        message: err instanceof Error ? err.message : "Verification failed",
      });
    }
  };

  const handleGoogle = () => {
    setGoogleHint(true);
    emailRef.current?.focus();
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
          <h1 className="text-[22px] font-medium text-vs-fg-4 leading-tight">
            Sign in to Alfred
          </h1>
          <p className="text-sm text-vs-fg-2">
            {flow.step === "email" ? (
              "Your personal assistant, on email and calendar."
            ) : (
              <>
                We sent a 6-digit code to{" "}
                <span className="font-medium text-vs-fg-4">{email}</span>.
              </>
            )}
          </p>
        </div>

        {flow.step === "email" ? (
          <>
            <VsButton
              variant="primary"
              size="lg"
              onClick={handleGoogle}
              leading={GOOGLE_LEADING}
              className="w-full"
            >
              Continue with Google
            </VsButton>

            {googleHint ? (
              <p
                role="status"
                className="-mt-4 text-center text-[11px] text-vs-fg-2"
              >
                Google sign-in is coming soon. Use your email for now.
              </p>
            ) : null}

            <Divider />
          </>
        ) : null}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (flow.step === "email") {
              if (email && !flow.loading) sendOtp();
            } else if (otp.length >= 6 && !flow.loading) {
              verify();
            }
          }}
          className="space-y-3"
        >
          {flow.step === "email" ? (
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
                className="w-full bg-transparent text-sm text-vs-fg-4 outline-none placeholder:text-vs-fg-2"
              />
            </Field>
          ) : (
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
                className="w-full bg-transparent text-sm text-vs-fg-4 outline-none tracking-[0.4em] tabular-nums placeholder:text-vs-fg-2"
              />
            </Field>
          )}

          <VsButton
            type="submit"
            variant={flow.step === "email" ? "white" : "primary"}
            size="lg"
            loading={flow.loading}
            disabled={flow.step === "email" ? !email : otp.length < 6}
            trailing={!flow.loading ? ARROW_RIGHT_TRAILING : undefined}
            className="w-full"
          >
            {flow.loading
              ? "Working…"
              : flow.step === "email"
                ? "Continue with email"
                : "Verify & sign in"}
          </VsButton>

          {flow.step === "otp" ? (
            <button
              type="button"
              onClick={() => {
                dispatchFlow({ type: "restart" });
                setOtp("");
              }}
              className="w-full text-xs text-vs-fg-2 hover:text-vs-fg-4 transition-colors"
            >
              Use a different email
            </button>
          ) : null}
        </form>

        {flow.error ? (
          <p className="text-xs text-vs-red-4 text-center">{flow.error}</p>
        ) : null}

        <p className="text-center text-[11px] text-vs-fg-2">
          Alfred is private to you. Only the allowlisted email can sign in.
        </p>
      </div>
    </div>
  );
}

function ShowcasePanel() {
  return (
    <div className="hidden lg:flex relative items-center justify-center overflow-hidden border-l border-vs-bg-a1">
      {/* Quiet ambient wash — pulls the purple accent across the right half */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(60% 60% at 70% 35%, color-mix(in oklch, var(--vs-purple-4) 14%, transparent), transparent 70%)",
        }}
      />

      <div className="relative z-10 max-w-[420px] px-10 py-12 space-y-7">
        <div className="space-y-2">
          <h2 className="text-[26px] font-medium text-vs-fg-4 leading-[1.15]">
            Your morning, briefed.
            <br />
            Your inbox, triaged.
          </h2>
          <p className="text-[13px] text-vs-fg-2">
            Alfred reads your email, surfaces what matters, and writes the
            drafts you'd write anyway, quietly, every morning.
          </p>
        </div>

        <div className="relative">
          {/* Stacked card hint — second card peeks from behind */}
          <div
            aria-hidden
            className={cn(
              "absolute inset-x-3 top-3 bottom-[-12px] rounded-2xl bg-vs-bg-1",
              "shadow-[0_1px_1px_rgba(0,0,0,0.04),0_0_0_1px_rgba(0,0,0,0.04)]",
              "opacity-70",
            )}
          />
          <div
            className={cn(
              "relative rounded-2xl bg-vs-bg-1 p-5 space-y-4",
              "shadow-[0_1px_1px_rgba(0,0,0,0.06),0_0_0_1px_rgba(0,0,0,0.05),0_12px_32px_-12px_rgba(0,0,0,0.10)]",
            )}
          >
            <div className="flex items-center justify-between">
              <span className="text-[11px] uppercase tracking-[0.08em] text-vs-fg-2">
                Friday morning · 8:02
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-vs-purple-1 px-2 py-0.5 text-[10px] font-medium text-vs-purple-4">
                <Sparkles size={10} /> Brief
              </span>
            </div>
            <p className="text-[13px] text-vs-fg-4 leading-relaxed">
              <span className="font-medium">3 things</span> need you today:
              Sycamore's term sheet, a recruiter intro to Avery, and the design
              review you moved off Thursday.
            </p>
            <ul className="space-y-2 text-[12.5px]">
              <BriefRow
                hue="purple"
                lead="Sycamore"
                body="Term sheet expires Sunday 9pm — reply, or push it"
              />
              <BriefRow
                hue="sky"
                lead="Avery (Engineering)"
                body="Recruiter wants a 15-min intro this week"
              />
              <BriefRow
                hue="amber"
                lead="Design review"
                body="Rescheduled Thursday → Friday 3pm; agenda still empty"
              />
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

function BriefRow({ hue, lead, body }: { hue: "purple" | "sky" | "amber"; lead: string; body: string }) {
  const dotClass =
    hue === "purple" ? "bg-vs-purple-4" : hue === "sky" ? "bg-vs-sky-4" : "bg-vs-amber-4";
  return (
    <li className="flex items-start gap-2.5">
      <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", dotClass)} aria-hidden />
      <span className="text-vs-fg-3 leading-snug">
        <span className="text-vs-fg-4 font-medium">{lead}</span>
        <span className="text-vs-fg-2">: </span>
        {body}
      </span>
    </li>
  );
}

function Field({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <label
      className={cn(
        "flex items-center gap-2 rounded-xl bg-vs-bg-1 px-3 h-10",
        "vs-elevated",
        "focus-within:ring-2 focus-within:ring-vs-purple-2 focus-within:ring-offset-4 focus-within:ring-offset-vs-background",
        "transition-shadow",
      )}
    >
      <span className="text-vs-fg-2">{icon}</span>
      {children}
    </label>
  );
}

function Divider() {
  return (
    <div className="flex items-center gap-3 text-[11px] text-vs-fg-2">
      <span className="h-px flex-1 bg-vs-bg-a2" aria-hidden />
      <span>or</span>
      <span className="h-px flex-1 bg-vs-bg-a2" aria-hidden />
    </div>
  );
}

function GoogleMark() {
  return (
    <svg width="15" height="15" viewBox="0 0 18 18" aria-hidden>
      <path
        d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"
        fill="#4285F4"
      />
      <path
        d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z"
        fill="#34A853"
      />
      <path
        d="M3.964 10.706A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.038l3.007-2.332z"
        fill="#FBBC05"
      />
      <path
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.962L3.964 7.294C4.672 5.167 6.656 3.58 9 3.58z"
        fill="#EA4335"
      />
    </svg>
  );
}
