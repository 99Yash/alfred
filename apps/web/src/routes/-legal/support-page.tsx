import { ArrowLeft } from "lucide-react";
import { LandingBackground } from "~/components/landing";
import { LegalSection } from "~/components/legal/legal-page";
import { cn } from "~/lib/utils";

const CONTACT = "yashgouravkar@gmail.com";

export function SupportPage() {
  return (
    <LandingBackground className="min-h-[100dvh] w-full overflow-x-hidden">
      {/* `<main>` gives this chromeless public page its required primary
       * landmark (the authed shell supplies one for app routes; chromeless
       * routes must bring their own). */}
      <main className="relative mx-auto w-full max-w-3xl px-5 pb-24 pt-16 sm:px-8 sm:pt-24">
        <a
          href="/"
          className={cn(
            "inline-flex items-center gap-1.5 text-[13px] font-medium",
            "text-neutral-400 transition-colors hover:text-white",
          )}
        >
          <ArrowLeft className="size-3.5" />
          Back to Alfred
        </a>

        <header className="mt-10 flex items-center gap-3">
          <img src="/images/logo/alfred-logo.svg" alt="Alfred" className="size-8 rounded-[9px]" />
          <span className="text-[15px] font-semibold text-white">Alfred</span>
        </header>

        <h1 className="mt-8 text-balance text-3xl font-semibold tracking-[-0.03em] text-white sm:text-4xl">
          Support
        </h1>
        <p className="mt-3 text-[13.5px] text-neutral-400">We&rsquo;re here to help.</p>

        <div className="legal-prose mt-10 space-y-8 text-[15px] leading-[1.65] text-neutral-300">
          <p>
            Need a hand with Alfred? Whether something isn&rsquo;t working, you have a question
            about an integration, or you want to request a feature, reach out and we&rsquo;ll get
            back to you.
          </p>

          <LegalSection heading="Get in touch">
            <p>
              Email us at{" "}
              <a href={`mailto:${CONTACT}`} className="underline hover:text-white">
                {CONTACT}
              </a>
              . This is the fastest way to reach a person.
            </p>
          </LegalSection>

          <LegalSection heading="What to include">
            <p>So we can help quickly, it helps to tell us:</p>
            <ul className="ml-5 list-disc space-y-1.5 text-neutral-400">
              <li>
                <strong className="text-neutral-200">What you were doing</strong> when the issue
                happened, and what you expected instead.
              </li>
              <li>
                <strong className="text-neutral-200">Which integration</strong> is involved (for
                example Vercel, GitHub, or Google), if any.
              </li>
              <li>
                <strong className="text-neutral-200">A screenshot</strong> or the exact wording of
                any error message.
              </li>
            </ul>
          </LegalSection>

          <LegalSection heading="Account &amp; data">
            <p>
              You can disconnect any integration at any time from Alfred&rsquo;s settings. For how
              your data is handled, see our{" "}
              <a href="/privacy-policy" className="underline hover:text-white">
                Privacy Policy
              </a>{" "}
              and{" "}
              <a href="/terms-of-service" className="underline hover:text-white">
                Terms of Service
              </a>
              .
            </p>
          </LegalSection>
        </div>
      </main>
    </LandingBackground>
  );
}
