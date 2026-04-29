import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
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
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-sm space-y-6 p-6">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-bold">Alfred</h1>
          <p className="text-sm text-muted-foreground">
            {step === "email" ? "Enter your email to sign in" : `Enter the code sent to ${email}`}
          </p>
        </div>

        {step === "email" ? (
          <div className="space-y-4">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary"
              onKeyDown={(e) => e.key === "Enter" && sendOtp()}
            />
            <button
              onClick={sendOtp}
              disabled={loading || !email}
              className={cn(
                "w-full rounded-md px-4 py-2 text-sm font-medium transition-colors",
                "bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50",
              )}
            >
              {loading ? "Sending…" : "Send code"}
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <input
              type="text"
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
              placeholder="6-digit code"
              className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary"
              onKeyDown={(e) => e.key === "Enter" && verify()}
            />
            <button
              onClick={verify}
              disabled={loading || otp.length < 6}
              className={cn(
                "w-full rounded-md px-4 py-2 text-sm font-medium transition-colors",
                "bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50",
              )}
            >
              {loading ? "Verifying…" : "Sign in"}
            </button>
            <button
              onClick={() => {
                setStep("email");
                setOtp("");
                setError(null);
              }}
              className="w-full text-sm text-muted-foreground underline"
            >
              Back
            </button>
          </div>
        )}

        {error && <p className="text-sm text-red-500 text-center">{error}</p>}
      </div>
    </div>
  );
}
