import { useState } from "react";
import { cn } from "~/lib/utils";

/** Landing footer. `onGetStarted` is unused; the closing CTA above owns the ask. */
export function LandingFooter({ onGetStarted: _onGetStarted }: { onGetStarted: () => void }) {
  const year = useCurrentYear();

  return (
    <footer
      id="landing-footer"
      className="relative w-full border-t border-neutral-900 text-neutral-400"
    >
      <div className="mx-auto w-full max-w-5xl px-5 py-16 sm:px-10 sm:py-20 lg:px-0">
        <div className="grid grid-cols-1 gap-12 md:grid-cols-[1.5fr_1fr_1fr] lg:gap-16">
          {/* Tagline column */}
          <div className="flex flex-col gap-5">
            <a href="/" className="inline-flex items-center gap-2">
              <img
                src="/images/logo/alfred-logo.svg"
                alt="Alfred"
                className="size-6 rounded-[7px]"
              />
              <span className="text-[15px] font-semibold text-white">Alfred</span>
            </a>
            <p className="max-w-sm text-[14px] leading-[1.55] text-neutral-400">
              Built because{" "}
              <a href="https://dimension.dev" className="underline">
                Dimension
              </a>{" "}
              wound down, Alfred is the personal AI coworker that runs quietly across every tool you
              already use.
            </p>
            <p className="text-[12.5px] text-neutral-400">© {year} Alfred</p>
          </div>

          {/* Product + Made by */}
          <div className="flex flex-col gap-10">
            <FooterColumn title="Product" items={PRODUCT_ITEMS} />
            <FooterColumn title="Made by" items={MADE_BY_ITEMS} />
          </div>

          {/* Features + Legal */}
          <div className="flex flex-col gap-10">
            <FooterColumn title="Features" items={FEATURE_ITEMS} />
            <FooterColumn title="Legal" items={LEGAL_ITEMS} />
          </div>
        </div>
      </div>
    </footer>
  );
}

interface FooterLink {
  label: string;
  href: string;
  external?: boolean | undefined;
}

const PRODUCT_ITEMS: ReadonlyArray<FooterLink> = [
  { label: "How it works", href: "#how-it-works" },
  { label: "Why trust it", href: "#why" },
  { label: "Access", href: "#access" },
  { label: "Sign in", href: "/login" },
];

const FEATURE_ITEMS: ReadonlyArray<FooterLink> = [
  { label: "Inbox triage", href: "#features" },
  { label: "Morning briefing", href: "#features" },
  { label: "Chat that acts", href: "#features" },
  { label: "Meeting prep — soon", href: "#features" },
];

// Link to the profile, not a site's front page.
const MADE_BY_ITEMS: ReadonlyArray<FooterLink> = [
  { label: "GitHub", href: "https://github.com/99Yash/alfred", external: true },
];

const LEGAL_ITEMS: ReadonlyArray<FooterLink> = [
  { label: "Privacy", href: "/privacy-policy" },
  { label: "Terms", href: "/terms-of-service" },
];

function FooterColumn({ title, items }: { title: string; items: ReadonlyArray<FooterLink> }) {
  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-[12.5px] font-semibold text-white">{title}</h3>
      <ul className="flex flex-col gap-3">
        {items.map((item) => (
          <li key={`${title}-${item.label}`}>
            <a
              href={item.href}
              target={item.external ? "_blank" : undefined}
              rel={item.external ? "noopener noreferrer" : undefined}
              className={cn("text-[14px] text-neutral-400 transition-colors", "hover:text-white")}
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Lazy init reads the year once, without a mount effect. */
function useCurrentYear(): number {
  const [year] = useState(() => new Date().getFullYear());

  return year;
}
