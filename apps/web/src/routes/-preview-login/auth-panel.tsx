import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, KeyRound, Mail } from "lucide-react";
import { useEffect, useReducer, useRef, useState } from "react";
import { VsButton } from "~/components/ui/visitors";
import { authClient } from "~/lib/auth-client";
import { Divider } from "./divider";
import { Field } from "./field";
import { GoogleMark } from "./google-mark";

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

export function AuthPanel() {
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
                aria-label="Email address"
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
                aria-label="One-time code"
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
