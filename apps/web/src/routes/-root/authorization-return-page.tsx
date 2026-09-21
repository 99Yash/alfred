import { ArrowRight, Plug } from "lucide-react";
import { continueAfterAuthorization } from "~/lib/integrations/authorization-tab";

/** The quiet return screen for a provider tab opened from Integrations. */
export function AuthorizationReturnPage() {
  return (
    <main className="relative isolate flex min-h-dvh items-center justify-center overflow-hidden bg-[#0a0a0a] px-6 py-16 text-white antialiased">
      <div className="relative z-10 flex w-full max-w-lg flex-col items-center text-center">
        <div className="relative flex items-center gap-12 sm:gap-16" aria-hidden="true">
          <div className="pointer-events-none absolute top-1/2 left-1/2 -z-20 h-[240px] w-[400px] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(ellipse_at_center,#fff_0%,#c829ff_29%,#6b62f2_55%,transparent_74%)] opacity-20 blur-3xl" />

          <div className="pointer-events-none absolute top-1/2 left-1/2 -z-10 h-[240px] w-[440px] max-w-[95vw] -translate-x-1/2 -translate-y-1/2">
            <span className="absolute top-[28%] left-[9%] size-0.5 rounded-full bg-white/75 shadow-[0_0_8px_2px_#fff8]" />
            <span className="absolute top-[12%] left-[27%] size-px rounded-full bg-white/70" />
            <span className="absolute top-[81%] left-[38%] size-0.5 rounded-full bg-[#e5a2fc] shadow-[0_0_8px_2px_#e5a2fc88]" />
            <span className="absolute top-[20%] left-[56%] size-px rounded-full bg-white/75" />
            <span className="absolute top-[76%] left-[76%] size-0.5 rounded-full bg-white/80 shadow-[0_0_8px_2px_#fff8]" />
            <span className="absolute top-[35%] left-[91%] size-px rounded-full bg-[#e5a2fc]" />
          </div>

          <svg
            className="pointer-events-none absolute top-1/2 left-1/2 -z-10 h-[120px] w-[260px] -translate-x-1/2 -translate-y-1/2"
            viewBox="0 0 260 120"
            fill="none"
          >
            <defs>
              <linearGradient id="authorization-return-line" x1="30" y1="0" x2="230" y2="0">
                <stop stopColor="#7b65f6" stopOpacity="0.1" />
                <stop offset="0.2" stopColor="#e5a2fc" stopOpacity="0.6" />
                <stop offset="0.5" stopColor="white" />
                <stop offset="0.8" stopColor="#e5a2fc" stopOpacity="0.6" />
                <stop offset="1" stopColor="#7b65f6" stopOpacity="0.1" />
              </linearGradient>
              <filter id="authorization-return-glow">
                <feGaussianBlur stdDeviation="3" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            <path
              d="M 30 60 Q 130 30 230 60"
              stroke="url(#authorization-return-line)"
              strokeWidth="2"
              filter="url(#authorization-return-glow)"
            />
          </svg>

          <div className="flex size-20 -rotate-8 items-center justify-center rounded-[24px] bg-[linear-gradient(145deg,#38373d,#1d1c23)] text-white shadow-[inset_0_1px_1px_#ffffff45,0_16px_36px_#0009,0_0_0_1px_#ffffff24] sm:size-24 sm:rounded-[28px]">
            <Plug className="size-9 sm:size-10" strokeWidth={1.5} />
          </div>
          <img
            src="/images/logo/alfred-logo.svg"
            alt=""
            className="size-20 rotate-8 rounded-[24px] shadow-[0_16px_36px_#0009,0_0_0_1px_#ffffff24] sm:size-24 sm:rounded-[28px]"
          />
        </div>

        <h1 className="mt-20 bg-[linear-gradient(90deg,#999_0%,#fff_38%,#999_100%)] bg-clip-text text-[28px] leading-tight font-medium text-balance text-transparent sm:mt-24 sm:text-[32px]">
          Return to Alfred
        </h1>
        <p className="mt-3 max-w-md text-base leading-7 text-pretty text-[#a0a0a0]">
          Authorization has returned to Alfred. You can close this tab and check the connection in
          your original tab.
        </p>
        <button
          className="mt-8 inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[linear-gradient(145deg,#6b57e9,#4f37cb)] px-5 text-sm font-medium text-white shadow-[inset_0_1px_1px_#ffffff55,0_8px_24px_#281b7555,0_0_0_1px_#ffffff26] transition-[transform,filter] duration-200 ease-[cubic-bezier(0.2,0,0,1)] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#a4acfd] active:scale-[0.96]"
          onClick={continueAfterAuthorization}
          type="button"
        >
          Continue in this tab
          <ArrowRight className="size-4" strokeWidth={1.75} />
        </button>
      </div>
    </main>
  );
}
