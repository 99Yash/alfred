import { cn } from '~/lib/utils';

/**
 * Dark, quiet footer — sits on the same black canvas as the rest of the
 * landing. Structurally mirrors visitors.now's footer (tagline column with
 * status pill + copyright; two columns of grouped links), adapted to
 * Alfred's much smaller surface area (single-user product, no docs/pricing
 * pages to link to).
 *
 * `onGetStarted` is accepted but unused — kept for call-site symmetry while
 * the closing CTA above already owns the conversion ask.
 */
export function LandingFooter({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onGetStarted: _onGetStarted,
  healthOk,
}: {
  onGetStarted: () => void;
  healthOk?: boolean;
}) {
  const operational = healthOk !== false;
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
              <span className="grid size-6 place-items-center rounded-full bg-white text-[11px] font-bold text-black">
                A
              </span>
              <span className="text-[15px] font-semibold text-white">
                Alfred
              </span>
            </a>
            <p className="max-w-sm text-[14px] leading-[1.55] text-neutral-500">
              Built over a lots of sweat and iterations, Alfred is the personal
              AI coworker that runs quietly across every tool you already use.
            </p>
            <div className="flex flex-col gap-2.5">
              <OperationalPill operational={operational} />
              <p className="text-[12.5px] text-neutral-600">
                © {new Date().getFullYear()} Alfred
              </p>
            </div>
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
  external?: boolean;
}

const PRODUCT_ITEMS: ReadonlyArray<FooterLink> = [
  { label: 'Home', href: '/' },
  { label: 'Why Alfred', href: '#benefits' },
  { label: 'Get Started', href: '/login' },
];

const FEATURE_ITEMS: ReadonlyArray<FooterLink> = [
  { label: 'Inbox triage', href: '#features' },
  { label: 'Morning briefing', href: '#features' },
  { label: 'Meeting prep', href: '#features' },
  { label: 'Talk to it anywhere', href: '#features' },
];

const MADE_BY_ITEMS: ReadonlyArray<FooterLink> = [
  { label: 'GitHub', href: 'https://github.com/99Yash/alfred', external: true },
  { label: 'X', href: 'https://x.com', external: true },
];

const LEGAL_ITEMS: ReadonlyArray<FooterLink> = [
  { label: 'Privacy', href: '/privacy-policy' },
  { label: 'Terms', href: '/terms-of-service' },
];

function FooterColumn({
  title,
  items,
}: {
  title: string;
  items: ReadonlyArray<FooterLink>;
}) {
  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-[12.5px] font-semibold text-white">{title}</h3>
      <ul className="flex flex-col gap-3">
        {items.map((item) => (
          <li key={`${title}-${item.label}`}>
            <a
              href={item.href}
              target={item.external ? '_blank' : undefined}
              rel={item.external ? 'noopener noreferrer' : undefined}
              className={cn(
                'text-[14px] text-neutral-500 transition-colors',
                'hover:text-white',
              )}
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Inline "Operational" status pill — mirrors visitors.now's footer status
 * indicator. Green dot when the API is reachable, amber when health hasn't
 * resolved yet or returned an error. We don't link to a dedicated status
 * page (there isn't one); the dot is the affordance.
 */
function OperationalPill({ operational }: { operational: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex w-fit items-center gap-2 text-[13px] font-medium',
        operational ? 'text-neutral-400' : 'text-amber-400/85',
      )}
    >
      <span className="relative grid size-2 place-items-center" aria-hidden>
        {operational ? (
          <>
            <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/55" />
            <span className="relative size-1.5 rounded-full bg-emerald-400" />
          </>
        ) : (
          <span className="relative size-1.5 rounded-full bg-amber-400" />
        )}
      </span>
      {operational ? 'Operational' : 'Degraded'}
    </span>
  );
}
