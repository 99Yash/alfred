# Dimension.dev — onboarding flow (post-signup)

Captured 2026-05-17. Reconstructed from the production JS bundle (no screenshots — see [the section at the end](#why-no-screenshots) for why).

The full bundle dump lives at the path noted in the [extraction context](#extraction-context) — the strings below were grep'd out of webpack modules 4068 (the page-level state machine), 15557 (welcome screen), 8363 (questionnaire engine), 64028 (integration-connect + "in your pocket" tiles), and 9499/81410 (small step components).

## How the flow is triggered

Server-side. The auth/me response carries a boolean `user.routeToOnboarding`. On client mount in `_app.tsx`, if this is `true` the app routes into the onboarding shell; if `false` the user goes to `/chat`. The middleware also redirects raw GETs to `/onboarding` based on the same flag (so you can't deep-link into onboarding once you're past it).

Setting `routeToOnboarding: true` in `localStorage["current-user-store"]` and reloading **does not work** — the cached user gets overwritten by a fresh tRPC/Replicache pull on boot, and the route guard reads server-truth, not the cache. There's no client-only path back into onboarding once a user has been marked complete.

## Step sequence

The step IDs are minified to single letters in the bundle, so the canonical enum names are lost. The visible screens, in order, are:

### 1. Sign-in screen

The login surface (also reachable at `/sso`). Buttons:

- `Continue With Google`
- `Continue With Apple`
- `Sign In With Demo Account` *(this is interesting — they ship a demo-account button into the public sign-in flow)*

On success fires the `"Signed Up"` analytics event with `{ id, email, isAdmin }`. Apple Sign In errors surface inline as `"Apple Sign In failed. Please try again."`

### 2. "What you'll unlock" feature carousel

A six-tile snap-scroll carousel under the heading `"What you'll unlock"`. The carousel position is driven by an `OnboardingFeatureCarouselContextProvider` — separate context just for this step's index.

Each tile pairs a marketing image with a one-line pitch:

| Image | Headline |
| --- | --- |
| `/images/features/morning-briefing.png` | A daily briefing on what needs your attention |
| `/images/features/auto-drafting.png` | Email replies drafted in your voice, ready to send |
| `/images/features/managed-inbox.png` | Every email labeled and sorted automatically |
| `/images/features/meetings.png` | Walk into every meeting with prep notes ready |
| `/images/features/google-suite.png` | Find anything across your files in seconds |
| `/images/features/workflows.png` | Custom automations that handle the busywork |

These six tiles map 1:1 to the six "Features" agents from `/settings?section=features` (Morning Briefing, Email Auto-Drafting, Email Tagging, Meeting Prep, Action Items, …) plus a "Search Files" surface. So **the carousel is the marketing version of the settings catalog** — same agents, different framing.

### 3. Profile questionnaire

A series of questions, each rendered as a card with answers + optional follow-up custom text. Two render modes seen in the bundle:

- **Single-card** — one question at a time, with `questionIndex / totalQuestions` counter
- **Stacked** — multiple short questions on one screen

Question schema:

```ts
{
  context?: string;            // optional supporting blurb above the question
  multi_select: boolean;       // checkbox-style vs radio-style
  options: { label: string; description?: string }[];
  // Answer payload:
  selected_options: string[];  // ids of chosen options
  custom_answer: string | null; // free-text override / addition
}
```

Free-text placeholder: `"Type your answer here…"`

The actual question copy didn't survive minification (questions are loaded as data, not hardcoded strings). The question SHAPE is what's interesting — it supports mixed multi-select + freeform, which lets them ask "What roles are you hiring for?" with checkboxes AND a "tell me more" field on the same screen.

### 4. Integration connect

A `Connect Google Workspace` CTA that triggers OAuth requesting `GOOGLE_GMAIL` + `GOOGLE_CALENDAR` scopes simultaneously (referenced as `j.IQ.GOOGLE_GMAIL`, `j.IQ.GOOGLE_CALENDAR`). The OAuth permission screen header is `Grant Google Workspace Access`.

Below the primary CTA: an `Explore all integrations` (or `Explore + integrations`) tile that opens a broader provider grid. Includes `Connect iMessage` marked `Coming Soon`.

Step-completion analytics fires with `{ connected_integrations: string[], skipped: boolean }`. The same shape fires twice in the bundle, suggesting **two separate integration screens** — one focused on Google Workspace alone, then a second optional one for everything else.

Helper copy: `"Check all the boxes on the next screen so Dimension can work across your email, calendar, and files."`

### 5. Trust / control beat

A pause screen with two short trust statements:

- `"You're always in control. Critical actions need your approval by default."`
- `"Enterprise-grade encryption. We never train on your data."` (links to `https://dimension.dev/privacy-policy`)

This is the "auto-approve" preference's first introduction — even though the toggle itself lives in Settings, the user is told about the approval model here, *before* they start using the agent. Worth lifting for Alfred: it sets the trust frame upfront instead of burying it in settings.

### 6. "Dimension in your pocket"

A multi-surface install screen with four tiles:

- **Desktop App** — `"One click from your dock"`
- **Mobile App** — App Store QR code (`appstore-qr-code.png`) + `"Dimension in your pocket"`
- **iMessage** — `"Chat with Dimension via text"`
- *(Slack tile also referenced)*

Terminal CTA on this screen: `I Understand, Continue`.

### 7. Finish

Single button: `Start using Dimension`. Fires the final analytics event and flips `routeToOnboarding` to `false` server-side, then `router.replace("/chat")`.

## Sheet / sidebar component

The top-level onboarding component (`module 4068`) renders **two viewport variants** of the same step content:

```tsx
<>
  <FlowMobile className="lg:hidden" step={step} />
  <FlowDesktop className="max-lg:hidden" step={step} />
</>
<Sheet open={...} setOpen={...} />
```

The `Sheet` is a side-drawer overlay that comes out separately — likely for "more info" / "see options" subflows inside steps, not a step on its own.

The component also has a `useEffect` that **eagerly preloads** all step images in an array (`ef.forEach(e => new Image().src = e)`) right after mount, so screens further down the flow render instantly when the user advances. Worth borrowing.

## Analytics events captured

- `Signed Up` — post-auth, with identify payload `{ id, email, isAdmin }`
- `onboarding_step_viewed` — fires on every step change with `{ step }`
- An integration-completion event (name minified) with `{ connected_integrations: string[], skipped: boolean }`

The `onboarding_step_viewed` event with the step ID is exactly the right shape for funnel analytics — Alfred should mirror this.

## Cross-references to other surfaces

Several keys mentioned in onboarding map to **settings/preferences** elsewhere:

- Feature toggle keys: `morning_briefing`, `evening_briefing`, `action_items`, `meeting_prep`, `reply_generation` — these match the `/settings?section=features` toggles (`08b-settings-features.png`)
- Sideline-setting mutations (`enableMorningBriefing`, `enableEveningRecap`, etc.) — set in settings, not onboarding

So **onboarding doesn't ask the user to opt INTO the background agents** — they default to on, and the user can later toggle them off in settings. This is a deliberate UX decision (lower friction during signup) that's worth replicating in Alfred.

## Patterns worth borrowing for Alfred

1. **Two-step "feature carousel + questionnaire"** before any integration connect. The user gets the pitch *first*, then identifies their use case, then is asked to connect tools. Connecting Gmail without context feels intrusive; connecting Gmail after "you said you spend 2 hours/day in email" feels obvious.

2. **`Connect Google Workspace`** as a single button that bundles Gmail + Calendar scopes, rather than two separate connect flows. Lifts directly from Alfred's m10-pre per-feature scope split (`scopesForFeatures(["briefing", "triage"])` from `packages/integrations/src/google/oauth.ts`) — onboarding should request the full bundle on first connect.

3. **Trust beat as a dedicated screen**, not a footnote. Same content as the marketing home's "we never train on your data" bullet, surfaced *before* the user is asked to grant scopes. Removes the moment of hesitation.

4. **Image preloading on step mount.** Every onboarding image gets `new Image().src = url` in a single effect right after mount — so screens never flash blank on advance. This is the polish that makes the flow feel native.

5. **`Sign In With Demo Account`** on the public sign-in screen. They ship a demo account into the production sign-in surface. For Alfred (single-user) this isn't relevant, but the pattern is bold — it's how SaaS products surface the product without forcing signup.

6. **Default-on background agents.** Onboarding never asks "do you want the morning briefing?" — it ships on and the user can opt out in settings. Saves three onboarding screens.

7. **The `routeToOnboarding` server-flag pattern.** Server returns a boolean on the auth response; client routes based on it. Simple, cacheable, hard to forge. Better than a "first-time user" cookie heuristic.

## Live capture (2026-05-17 follow-up)

User signed up with a fresh Google account, which got us live onto `/onboarding`. Captured: 6 carousel-tab variants + design tokens. The reconstructed flow above is mostly right, but **step 1 is more compact in production than the bundle suggested** — the feature carousel + Google connect CTA + trust beat are all on the *same screen*, not three separate steps.

### Screenshots

- `25-onboarding-step-1.png` — landing (Morning Briefing tab active by default)
- `25c-onboarding-tab-auto-drafting.png` — Auto Drafting tab
- `25e-onboarding-tab-search.png` — Search Files tab
- `25f-onboarding-tab-workflows.png` — Workflows tab
- `25g-onboarding-tab-meetings.png` — Meetings tab (first attempt, wait timed out — used 25i below)
- `25h-onboarding-tab-labeling.png` — Labeling tab (shows "Managed Inbox" image + headline "Every email labeled and sorted automatically")
- `25i-onboarding-tab-meetings.png` — Meetings tab (clean capture)

Plus `snapshots/onboarding-step-1-rendered.html` — the full rendered HTML of step 1 (~93KB). Most useful single artifact for pixel-replica work.

### Step 1 layout — confirmed structure

A single full-viewport screen, dark (`rgb(12,12,12)`) with a sky-image background (`/images/sky-background.jpg`) used as the carousel tile backdrop. Stacked:

1. **`WHAT YOU'LL UNLOCK`** uppercase eyebrow
2. **Tab strip** — 6 pill tabs (Labeling, Morning Briefing, Auto Drafting, Search Files, Workflows, Meetings). Active = off-white pill (`rgb(249,249,249)`), inactive = pure white (`rgb(255,255,255)`) at 50% opacity text. Both are `12px` border-radius, `8px 12px` padding.
3. **Active feature tile** — image + one-line headline. Image fills the tile.
4. **`Set up in under a minute`** — huge 48px DM Sans 500 weight headline
5. **`Link your Google account so Dimension can start working for you.`** — 18px subtitle at 80% white
6. **`Connect Google Workspace`** — pill CTA, white linear-gradient background, black text, full pill radius
7. **`Enterprise-grade encryption. We never train on your data.`** — small 14px trust line at 80% white

Feature tab → image + headline mapping (verbatim, captured live):

| Tab | Image file | Headline |
| --- | --- | --- |
| Labeling | `managed-inbox.png` | Every email labeled and sorted automatically |
| Morning Briefing | `morning-briefing.png` | A daily briefing on what needs your attention |
| Auto Drafting | `auto-drafting.png` | Email replies drafted in your voice, ready to send |
| Search Files | `google-suite.png` | Find anything across your files in seconds |
| Workflows | `workflows.png` | Custom automations that handle the busywork |
| Meetings | `meetings.png` | Walk into every meeting with prep notes ready |

### Design tokens — onboarding step 1

Pulled via `getComputedStyle()` on the live page. **The onboarding surface uses DM Sans, not Inter.** Different font from the chat surface. Worth noting — Alfred's auth/onboarding can diverge from the app shell's font.

```css
/* Page chrome */
body { background: rgb(12, 12, 12); color: rgb(237, 237, 237); font-family: "DM Sans", ui-sans-serif, system-ui, sans-serif; }

/* "Set up in under a minute" — primary headline */
font: 500 48px/48px "DM Sans"; color: rgb(237, 237, 237);

/* "Link your Google account..." — subtitle */
font: 400 18px/28px "DM Sans"; color: rgba(255, 255, 255, 0.8);

/* "Connect Google Workspace" — primary CTA pill */
font: 500 16px/24px "DM Sans"; color: rgb(0, 0, 0);
background: linear-gradient(rgba(255,255,255,0.8), rgb(238, 238, 238));
padding: 12px 16px; border-radius: 9999px; border: 0.5px solid rgba(0,0,0,0);
box-shadow: rgba(255, 255, 255, 0.106) 0 0 7px 1px inset;  /* subtle inner glow */

/* "Enterprise-grade encryption..." — trust line */
font: 400 14px/20px "DM Sans"; color: rgba(255, 255, 255, 0.8);

/* Tab — active */
font: 500 14px/20px "DM Sans"; color: rgba(0, 0, 0, 0.8);
background: rgb(249, 249, 249); padding: 8px 12px; border-radius: 12px;

/* Tab — inactive */
font: 500 14px/20px "DM Sans"; color: rgba(0, 0, 0, 0.5);
background: rgb(255, 255, 255); padding: 8px 12px; border-radius: 12px;
```

### Step 2 — "Connect your tools" (popular-integrations grid)

After Google OAuth consent, the user lands here. `screenshots/26-onboarding-step-2-connect-tools.png`.

Stacked layout same as step 1, swap content:

1. **`POPULAR INTEGRATIONS`** uppercase eyebrow (rendered as two text nodes — `POPULAR` + ` INTEGRATIONS` — likely styled differently)
2. **8-tile integration grid**: Linear, Notion, Slack, GitHub, Dropbox, Airtable, Granola, PostHog. Each tile = icon + name + one-line description + small "Connect" button.
3. **`Explore all integrations`** link below the grid
4. **`Connect your tools`** — 48px DM Sans 500 headline
5. **`Dimension works across your tools. Connect them so nothing falls through the cracks.`** — 18px subtitle
6. **`Skip`** button — uses the *same white-gradient pill style* as the primary CTA. They treat Skip as a forward action, not a hedged "no thanks." Bold call.
7. **`You're always in control. Critical actions need your approval by default.`** — trust line *changes per step* (encryption line on step 1, approval line here)

**Per-tile Connect button:** small pill, `rgb(237,237,237)` background, `rgb(93,93,93)` text, `6px 12px` padding, `9999px` radius.

**Verbatim integration descriptions:**

| Integration | Description |
| --- | --- |
| Linear | Manage Linear issues and projects |
| Notion | Manage Notion pages and databases |
| Slack | Manage Slack messages and channels |
| GitHub | Manage GitHub repos and workflow |
| Dropbox | Access and manage Dropbox files and folders |
| Airtable | Manage Airtable bases and records |
| Granola | AI meeting notes and transcription |
| PostHog | Product analytics and feature flags |

### Step 3 — "You're all set" (install tiles + finish)

`screenshots/27-onboarding-step-3-youre-all-set.png` and `snapshots/onboarding-step-3-rendered.html`.

Three install tiles (likely white cards on the dark background) + finish CTA. **Tile internals use Geist font, not DM Sans** — first divergence in the type system within the same surface.

Tiles (each = title + tagline + gray illustration + button):

| Tile | Tagline | Button state |
| --- | --- | --- |
| Desktop App | One click from your dock | `Coming Soon` (disabled) |
| iMessage | Chat with Dimension via text | `Connect iMessage` (enabled) |
| Mobile App | Dimension in your pocket | `App Store Coming Soon` (disabled) — has App Store QR code below |

The illustrations are at `/images/onboarding/gray-illustration-{desktop-app,imessage,appstore}.png` + the App Store QR at `/images/onboarding/appstore-qr-code.png`.

**Headline:** `You're all set` (48px DM Sans 500)
**Sub:** `Setup complete. Here are a few more ways to use Dimension.` (18px DM Sans 400 at 80% white)
**Tile title:** 18px **Geist** 500, black
**Tile sub:** 14px **Geist** 400, black at 50% opacity
**Tile button:** small pill, `rgba(0,0,0,0.07)` bg, 10px padding, black text — Connect-style and Coming-Soon look the same except for the `disabled` state.
**Final CTA:** `Start using Dimension` — same white-gradient pill as the step-1 primary CTA.

There's also a small "Getting Started" breadcrumb / stepper somewhere in the wrapper (`text: "Getting StartedYou're all set..."` appeared when I grabbed the container) — likely indicates step position. Worth eyeballing in `screenshots/27-…`.

### Complete flow — three steps, confirmed

| # | Screen | Forward action | Trust line |
| --- | --- | --- | --- |
| 1 | Feature carousel + Google connect | `Connect Google Workspace` → Google OAuth consent | `Enterprise-grade encryption. We never train on your data.` |
| 2 | Popular integrations grid + Skip | `Skip` (or Connect any tile) | `You're always in control. Critical actions need your approval by default.` |
| 3 | "You're all set" + install tiles | `Start using Dimension` → `/chat` | (no trust line) |

The bundle's `Sign in`, `What you'll unlock` carousel, `Profile questionnaire`, and `Trust beat` step-screens are all collapsed into **one** screen in production (step 1). The bundle component (module 4068) supports more screens but production never reaches them. **Three real steps**, not seven.

### Token sweep (all three steps)

- **Font (chrome)**: `DM Sans` — applies to headlines, subtitles, trust lines, primary CTAs.
- **Font (tile internals)**: `Geist` — used inside the white install tiles in step 3, possibly elsewhere.
- **Page background**: `rgb(12, 12, 12)`.
- **Page text default**: `rgb(237, 237, 237)`.
- **Sky-image carousel background**: `/images/sky-background.jpg`.
- **Primary CTA pill** (Connect Google Workspace / Skip / Start using Dimension): `linear-gradient(rgba(255,255,255,0.8), rgb(238,238,238))` bg, black text, `12px 16px` padding, `9999px` radius, `0.5px solid rgba(0,0,0,0)` border, inset glow `rgba(255,255,255,0.106) 0 0 7px 1px inset`. Reuse this 1:1 wherever a primary CTA appears.
- **Headline scale**: 48px / 48px line-height, DM Sans 500, `rgb(237,237,237)`.
- **Subtitle scale**: 18px / 28px, DM Sans 400, `rgba(255,255,255,0.8)`.
- **Trust line scale**: 14px / 20px, DM Sans 400, `rgba(255,255,255,0.8)`.
- **Tab pill (step 1)**: 14/20 DM Sans 500, `12px` radius, `8px 12px` padding. Active = `rgb(249,249,249)` bg with `rgba(0,0,0,0.8)` text. Inactive = `rgb(255,255,255)` bg with `rgba(0,0,0,0.5)` text.
- **Inline "Connect" pill (step 2 grid)**: 14/20 DM Sans 400, `rgb(237,237,237)` bg, `rgb(93,93,93)` text, `6px 12px` padding, `9999px` radius.
- **Tile button (step 3)**: 14/20 DM Sans 500, `rgba(0,0,0,0.07)` bg, black text, `10px` padding, `9999px` radius.

That's enough to rebuild a pixel-faithful clone of all three onboarding screens.

### Post-onboarding "first chat" — onboarding's hidden 4th surface

After hitting `Start using Dimension`, the user lands on `/chat` for the first time and three onboarding-adjacent surfaces appear that aren't part of `/onboarding` itself. `screenshots/28-first-chat-after-onboarding.png`.

#### 1. Pre-filled composer with a personalized first prompt

The composer is NOT empty. It's pre-populated with a sentence Dimension generated from the cold-start research that ran during signup. Mine:

> *"I'm prepping for my interview at Sycamore Labs, pull together a deeper brief on the company, their tech stack, recent activity, and give me a list of sharp questions I should ask them"*

This is the `/sandbox/first-question` component (from the route manifest), wired into production. The user can edit it before sending or send as-is. It's a brilliant unlock: instead of an empty composer with placeholder `"Type and press enter..."`, the user sees an obviously-relevant prompt they didn't think to ask for. **Alfred's cold-start research (m11) is the same shape — it could power this exact surface.** Currently we run cold-start research but don't surface its output as a first-prompt suggestion. We should.

#### 2. "Enable Email Auto-Labeling" promo card

A floating prompt card appears (above the composer or somewhere on screen — see screenshot) with:

- Title: `Enable Email Auto-Labeling` (16px DM Sans 500, white)
- Body: `Dimension can automatically label your emails based on their content.`
- 3 actions: `Learn more` (12px ghost link), `No thanks` (14px subtle pill, white 60%), **`Enable`** (the same white-gradient primary CTA pill, smaller — 8/16 padding instead of 12/16)

This is a *progressive disclosure of features*: rather than asking during onboarding "do you want email auto-labeling?", they default it off, then prompt for it in-context when the user first lands on chat. Reduces onboarding friction, presents the feature when curiosity is highest.

#### 3. Suggestions in the right rail are pulled from live data

The fresh-account right rail showed two suggestions:

- `Address Copilot's schema feedback on alfred PR #7`
- `Fix 2 Devin Review bugs in warden PR #18`

These come from the *signed-up account's actual GitHub notifications*, surfaced within seconds of completing onboarding. So the Suggestions widget isn't curated or templated — it runs over the user's connected accounts and emits one-shot action prompts. The main account's right rail showed a different one-suggestion mode (`Submit FATCA/CRS forms to Nexus Select Trust REIT`); both confirm the suggestion is "pull real work to user," not "show static examples."

#### Why these matter

These three post-onboarding moments do more onboarding work than `/onboarding` itself:

- Pre-filled prompt = "here's what you should ask me"
- Auto-Labeling promo = "here's a feature worth turning on"
- Live suggestions = "here's real work I can take off your plate"

Together they answer the question "what do I do now?" — which a typical first-chat-with-empty-composer landing leaves dangling. For Alfred's UX, replicate at least the first one (pre-filled prompt from cold-start research output).

#### 4. "Learn more" feature-explainer modal

Clicking `Learn more` on the Auto-Labeling promo opens a centered modal. `screenshots/29-email-autolabel-learn-more-modal.png`.

Structure (top to bottom):

- Hero image (`managed-inbox.png` — **same asset as step 1 Labeling tab**, reused)
- H2 title: `Email Auto-Labeling` (20/24 DM Sans 500)
- Body headline: `Keep your inbox organized automatically` (14/20 DM Sans 500)
- Body description: 12/16 DM Sans 400 at 70% white opacity
- Two-button action row: `No thanks` (ghost) + `Enable Auto-Labeling` (white-gradient primary pill)
- Close X (top-right, 28×28 ghost with subtle inset glow)

**Verbatim body copy:**

> *"Dimension analyzes the content of every email and automatically applies relevant labels. From receipts and newsletters to project updates and personal messages, everything gets sorted into the right category without you lifting a finger."*

**Modal panel tokens** — this is the **Dimension modal pattern** (worth lifting as Alfred's default modal):

```css
/* Panel */
background: rgba(16, 16, 16, 0.8);
backdrop-filter: blur(8px);
border-radius: 24px;                 /* chunky */
border: 0.5px solid rgba(0, 0, 0, 0);
box-shadow: rgba(0, 0, 0, 0.1) 0 0 0 0.5px;
max-width: 672px;                    /* Tailwind max-w-2xl */
padding: 22px;

/* Backdrop overlay */
background: rgba(0, 0, 0, 0.7);
backdrop-filter: blur(4px);          /* light blur on top of heavy dim */
```

So the modal pattern is: **semi-transparent panel + 8px blur, sitting on a 70%-black overlay with its own 4px blur**. Double-blur stack — the panel is glassy on the backdrop. Distinctive look.

Image asset reuse is a small but worth-noting pattern: the carousel image, the Settings → Features tile, and the Learn-more modal all use the SAME `managed-inbox.png`. One asset, three surfaces. Reduces the asset library Alfred needs to ship.

## Extraction context

- Bundle deploy ID: `dpl_HfumqwUvw2j9zVXSutQ6y2HiZDC4`, build `2Yg6GmRb0YtGO-YJVw6mf`
- Page entry chunk: `/_next/static/chunks/pages/onboarding-db318cbc9abcbae8.js` (a `next/dynamic` shim with `ssr: false`)
- Real component: webpack module `4068`, lazy-loaded via 20 dependent chunks
- Other key modules: `15557` (welcome), `8363` (questionnaire engine), `64028` (integration grid + pocket tiles)
- Manifest of all 200+ Dimension routes lives in `/_next/static/{buildId}/_buildManifest.js`
