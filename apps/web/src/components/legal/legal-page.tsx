import { ArrowLeft } from "lucide-react";
import { type ReactNode } from "react";
import { LandingBackground } from "~/components/landing";
import { cn } from "~/lib/utils";

/**
 * Standalone layout for the public legal pages (`/privacy-policy`,
 * `/terms-of-service`). These render chromeless and auth-free so Google's
 * OAuth verification reviewers — and any signed-out visitor — can read them
 * directly. Mirrors the landing's dark canvas; quiet, document-shaped column.
 */
export function LegalPage({
  title,
  effectiveDate,
  children,
}: {
  title: string;
  effectiveDate: string;
  children: ReactNode;
}) {
  return (
    <LandingBackground className="min-h-[100dvh] w-full overflow-x-hidden">
      {/* `<main>` gives these chromeless public pages their required primary
       * landmark (the authed shell supplies one for app routes; chromeless
       * routes must bring their own). */}
      <main className="relative mx-auto w-full max-w-3xl px-5 pt-16 pb-24 sm:px-8 sm:pt-24">
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

        <h1 className="mt-8 text-3xl font-semibold tracking-[-0.03em] text-balance text-white sm:text-4xl">
          {title}
        </h1>
        <p className="mt-3 text-[13.5px] text-neutral-400">Effective {effectiveDate}</p>

        <div className="legal-prose mt-10 space-y-8 text-[15px] leading-[1.65] text-neutral-300">
          {children}
        </div>
      </main>
    </LandingBackground>
  );
}

/** A titled section within a legal document. */
export function LegalSection({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-white">{heading}</h2>
      {children}
    </section>
  );
}
