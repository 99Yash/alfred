# Home / chat-landing fidelity gaps — 2026-05-18

Side-by-side recon of `dimension.dev/chat` vs Alfred `localhost:3000/`, at 1440×900, dark mode, both authenticated. Use this with [`final-live-ui-recon-2026-05-18.md`](./final-live-ui-recon-2026-05-18.md) and [`alfred-frost-surface-map-2026-05-18.md`](./alfred-frost-surface-map-2026-05-18.md).

All computed values below were pulled live from Dimension via DevTools `getComputedStyle`. Numbers are exact, not eyeballed.

## Summary verdict

Structurally Alfred is close. The remaining gap is in **material specificity** of three regions:

1. Composer body and its three pill controls (`Auto`, model picker, send) — Alfred is close, send button is the biggest visual miss.
2. Right quick rail — Alfred has gradient backdrop, Dimension uses live video and slightly different typographic + tab proportions.
3. Setup nudge banner — Alfred's banner stacks above the composer (we put it below), Dimension's `Upgrade your Plan` banner is **absolutely positioned at the bottom of the main column** and shares the same video as the rail.

Lower-priority gaps: sidebar profile chip, `Refer and earn` style yellow banner, recent threads list, model picker dropdown content, "+" two-item menu.

## Composer

| Detail | Dimension live | Alfred current | Gap |
|---|---|---|---|
| Editor width | `652px`, `min-h 50px`, `max-h 320px`, `text-sm 14/20` | `min-h 64`, `max-h 320`, text-sm | Editor min-height should be `50px`, not `64`. |
| `Auto` button | `72.4 × 32`, `rounded-[10px]`, `bg-gradient-to-b from-[#0f0f0f] to-[#1e1e1e]`, `backdrop-blur-sm` (4px), data-state-on flips both stops to `#141414/100% → #141414/50%`, **green dot indicator next to the label** | Same dimensions, gradient, emerald shadow shell. **No green dot on the label.** | Add the trailing radio-dot indicator inside the pill (a 10px disk, emerald-400 with inner shadow when on, muted gray when off). Drop the emerald shadow + colored border in the off state — Dimension's off state is fully neutral. |
| Model picker | `108 × 30`, `rounded-lg 8px`, `bg-gradient-to-b from-[#0C0C0C] to-[#151515]`, `backdrop-blur-sm`, `inset 0 0 4px rgba(0,0,0,0.4)`, **small Mario-ish avatar dot** on the left, `Dimension` label, no chevron | `96 × 32`, similar gradient, no left avatar, no chevron, label "Alfred" | Tighten to `108 × 30`, add small (16px) circle on the left side. Use simple monochrome glyph in Alfred's tone, not a brand mascot. |
| Send button (active) | `32 × 32`, `rounded-full`, `bg-gradient-to-b from-[#a5a5a5] from-46% to-[#e3e3e3]`, with full multi-layer shadow `inset hairline + 18/8/2px ambient` | `36 × 36`, vertical white gradient + `shadow-soft` | Resize to 32, brighten gradient from gray→white (not white→white/80), add hairline inset + ambient stack. Disabled state should fall to 50% opacity rather than the muted-bg used today. |
| Mic | dark icon button between model and send, no chrome | dark icon button | Visually OK. |
| Wrapper | `rounded-2xl` (16), `bg-gray-25/75` over the whole composer body, ProseMirror inside; mask gradient at top/bottom of the editor for soft fade | `rounded-[24px]`, `bg-[#080808]/95`, no fade mask | Two changes: outer radius is **16px not 24px**; add a top/bottom CSS mask on the textarea so long text fades into the chrome. The 24px lives on Connect-Tools row corners and rail. |
| Connect Your Tools row | Attached row: `656 × 46`, `rounded-b-2xl`, `-mt-1`, `px-4 pt-3.5 pb-3`, 11 provider icons at 16px each, 4px gap, no `connected` checkmark badges in this view, the label is left-aligned, no chevron and no `N connected` chip | Attached row, looks similar but: 4 icons (overlapped `-space-x-1.5`), trailing `3 connected` chip and chevron | Show ~10 provider glyphs in their **brand colors**, no overlap, 4–6px spacing, no checkmarks (status is implied by inclusion). Drop the trailing chevron and "N connected" chip on the home composer — it's noise. Reserve those for `/integrations`. |
| Placeholder | `"Type and press enter to start chatting..."` | matches | OK. |
| Top fade mask | yes, on editor only | none | Add `mask: linear-gradient(...)` to the textarea wrapper to mimic the soft fade in/out of long input. |

## Greeting + date block

| Detail | Dimension | Alfred | Gap |
|---|---|---|---|
| Greeting | `Good Morning, Yash Gourav` — `36px/40px`, weight 400 (normal), `bg-clip-text` gradient from `white` to `white/60` top-to-bottom | `Good morning, yashgouravkar` (lowercased name), 36/40 sans, name is muted in a separate span | Use the gradient text treatment instead of dimming the name. Capitalize each word in greeting. Use first name (`Yash`), title-cased — pull from `session.user.name` not the email local-part. |
| Date | `Monday, May 18th` `18/28`, `text-white/50`, **18px** larger than ours, no tabular | `Monday, May 18` `12px`, muted tabular | Increase to `text-lg`, drop tabular, add ordinal (`18th`) so the date breathes. Day-of-month formatting needs `Intl.PluralRules`. |
| Vertical position | Greeting + date + composer **vertically centered** in the main column | ours is also centered, but the bottom upgrade-nudge is currently underneath the composer, pushing it up | Move `SetupNudge` out of the central stack and into a `bottom-8 absolute` overlay anchored to the main column (see below). |

## Right quick rail

| Detail | Dimension | Alfred | Gap |
|---|---|---|---|
| Outer | `rounded-3xl 24px`, full-bleed `partly_cloudy.mp4` `<video>` covering the whole panel | `rounded-[24px]`, multi-stop static gradient | Replace gradient with media. Two options: own a short looping mp4/webm, OR animate a SVG/canvas cloud loop. **Minimum**: animate the existing gradient (slow `background-position` drift, ~30s) so it doesn't read as a static png. |
| Header | `Bhubaneswar 35°` (location + temperature, no map-pin icon, no extra label like "Local weather"), then `To Do` heading `24px/32 500` white | `Local weather 29°` + map-pin icon + date below | Drop the `Local weather` label; keep just `City Temp°`. Replace icon with nothing (Dimension has no pin). Move date below the rail header? No — Dimension hides date from the rail entirely; the date already lives over the composer. Move date out of the rail. |
| Mode tab group | `bg-black/20 rounded-2xl`, 3 tabs each `56 × 36`, `rounded-[14px]`, inactive `text-white/50`, active `text-white`, no border, slides background behind active | tab buttons `36 × 36` square w/ background pill behind active | Increase tab width to ~56px, soften the active pill (subtle white/10 backplate rather than `bg-white/20`). Use the three icons: checkmark-in-box (todo), envelope (email), video-camera (meeting). Currently we use ClipboardCheck, Inbox, CalendarDays — swap to match Dimension's pictograms (a small box-check icon, envelope, video). |
| Below the header | a divider line at `border-white/20`, then `All` tab + pencil edit | matches | OK. The `All` filter uses `mix-blend-plus-lighter` — keep this trick if we can, it's why the white reads cleanly over both bright sky and dark cloud. |
| Add new to do | `Add new to do` placeholder, a left **checkbox** glyph (not a `Plus`), white/50 placeholder | `Plus` icon + `Add new to do` | Replace plus with an unchecked-box icon to match. |
| Suggestions section | uppercase `SUGGESTIONS` label aligned **left**, with a small clipboard-with-spark icon prefix, then below: clipboard icon + `No Suggestions` + helper copy, all left-aligned (not centered) | label centered, icon and copy centered | Left-align label and copy; move icon left. |
| Empty state (Emails/Meetings) | centered "All done!" with sparkles-burst icon (`size-10 text-white/80 mix-blend-plus-lighter`) and one-line subtext | centered empty state with `Mail` or `CalendarDays` icon | Swap icon to a sparkles/party-popper for the **resolved** feeling. Copy: `All done!` / `No pending email drafts.` / `You have no meetings scheduled for today.` |
| Status dot | small dot showing API health | n/a in Dimension | Keep; move it next to the temperature so it doesn't compete with the weather icon. Or drop on the home rail entirely — health belongs in a debug surface, not the daily widget. |

## Upgrade / setup banner

Dimension's `Upgrade your Plan` lives at `absolute inset-x-0 bottom-8` inside the **main center column**, width `654 × 73`, radius `24px`, with a cropped `partly_cloudy.mp4` running behind it and a **bright white pill** CTA with arrow icon.

Alfred today places `SetupNudge` *below* the composer, in normal flow. That changes the vertical rhythm: greeting + composer get pushed up.

Recommendations:

1. Make `SetupNudge` an absolutely-positioned overlay anchored to the bottom of the main column (`absolute inset-x-0 bottom-6` inside the main scroll container).
2. Use a **smaller height** (~74px), same gradient (already close), and a bright white pill CTA with right arrow.
3. Keep `Open Integrations` copy but place the arrow icon to mirror the affordance.
4. Once we own a video asset, swap the gradient for it. Until then the gradient is acceptable.

## Sidebar

| Detail | Dimension | Alfred | Gap |
|---|---|---|---|
| Profile chip at top | small avatar circle + collapse toggle + pause/break toggle | avatar + email + collapse caret | Trim email subtext; replace with a quiet hover state showing email. Mobile-equivalent already collapses correctly. |
| New chat / Search | both 40px rows, shortcut chips on the right (`⇧O`, `⌘K`) | `⌘N` and `⌘K` chips | Switch our `New chat` shortcut to `⇧O`? No — `⌘N` is more native, keep. The shortcuts visual styling already matches. |
| Refer banner | `bg-yellow-500/10 ring-yellow-700` block between nav and recent threads | n/a | Out of scope for Alfred (no referrals product). Skip. |
| Recent threads | flat list of chat title rows with kebab affordance | "Agent surfaces" promo card | When chat threads land (m13) this becomes a `RecentThreads` component. Until then the `Agent surfaces` card is fine. Suggestion: drop the card; it doesn't help. |
| Settings | pinned at bottom | not yet routed | Add a `Settings` link at sidebar bottom; route to a placeholder `/settings`. Low effort, big "feel like a product" win. |
| Personal section | n/a (Dimension keeps everything in one block, no second header) | `Personal` separator + Memory + Notes | Keep — these are Alfred-specific. Visual treatment is fine. |

## `+` / context menu

Dimension's `+` opens a small frosted 2-row popover:

1. `Add photos & files` (paperclip)
2. `Mention` (`@` icon)

Alfred's `+` opens the mention picker directly. Recommendation: keep current behavior. We don't ship file attach yet; an intermediate 1-row menu would be wasted clicks. Revisit when attachment lands.

## Model picker dropdown

Dimension's model dropdown shows two semantic tiers:

| Row | Avatar | Title | Subtitle |
|---|---|---|---|
| 1 | 16px circle | `Dimension` | `Great for almost everything.` |
| 2 | 16px circle | `Dimension Pro` | `Our flagship agent for complex tasks.` + red `Please upgrade to a premium plan` |

Frosted popover, white-on-dark, ~280px wide. The selected row has a check on the right.

Alfred analog: when we enable the picker (m13), render the same structure:

| Row | Avatar | Title | Subtitle |
|---|---|---|---|
| 1 | 16px circle | `Alfred` | `Great for almost everything.` |
| 2 | 16px circle | `Alfred Pro` | `Best for complex multi-step tasks.` |

Single-user product → no upgrade row. Use `.frost-popover`.

## Connect Your Tools — provider icons

Dimension uses 11 brand SVGs inline (Gmail, Calendar, Drive, Notion, Linear, Slack, Dropbox, GitHub, Figma, ...). Each is 16×16, no chip, no border. The row reads as a "your tools are here" signal.

Alfred today shows 4 with `-space-x-1.5` overlap and a chevron + "3 connected" chip + `IntegrationIcon` with check badges. That treatment belongs on `/integrations`, not on the composer.

For the composer row, use the bare 16px glyphs **side-by-side**, no chip, no badges, no chevron — closer to a stamp than a control. Keep the row as a `<Link>` to `/integrations`.

## Copy

| Surface | Dimension | Alfred | Suggested |
|---|---|---|---|
| Composer placeholder | `Type and press enter to start chatting...` | matches | keep |
| Greeting | `Good Morning, {Name}` (title case) | `Good morning, yashgouravkar` | `Good {part of day}, {first name title-cased}` |
| Date | `Monday, May 18th` | `Monday, May 18` | add ordinal suffix |
| Rail header | `Bhubaneswar 35°` | `Local weather 29°` | drop label, just `{City} {temp}°` |
| Empty Emails | `All done!` / `No pending email drafts.` | n/a | match |
| Empty Meetings | `All done!` / `You have no meetings scheduled for today.` | n/a | match |
| Empty Tasks suggestions | `No Suggestions` / `New suggestions will appear here when available.` | `No Suggestions` / `Alfred will place time-sensitive actions here.` | small wording tweak: replace with Dimension's neutral copy |
| Upgrade nudge | `Upgrade your Plan` / `Get access to all features and more credits!` / `Upgrade Plan →` | `Connect tools for live context` / `Bring Gmail, Calendar, Drive, and code sources into Alfred.` / `Open Integrations` | keep our copy (it's Alfred-truthful) but match the **structure**: 2-line text + bright pill with arrow, absolute-bottom |

## Implementation order if we proceed

1. **Composer pills** — Auto pill green dot, model-picker avatar + label dims, send button gradient + shadow stack, editor min-h 50px, outer radius 16. Single file: `apps/web/src/routes/index.tsx` + light tokens.
2. **Greeting** — gradient text, ordinal date, capitalized first name. Same file.
3. **Connect Your Tools row** — switch to 10 bare brand glyphs, drop chevron and connected chip. Reuse `IntegrationGlyph` from `integration-icons.tsx`.
4. **Right rail** — drop `Local weather` label, swap empty-state icons, left-align Suggestions block, change rail tab proportions and add box-check / envelope / video icons. Add `mix-blend-plus-lighter` to `All` filter. Replace static gradient with an animated gradient drift (no video yet).
5. **Setup nudge** — move to `absolute bottom-6 inset-x-6` overlay inside main column, height ~74px, bright pill CTA with arrow.
6. **Sidebar** — drop the `Agent surfaces` card. Add a `Settings` row at the bottom pointing to a stub `/settings` route (or leave it as a disabled affordance until m11.5).
7. **`+` menu** — defer until file attach lands.
8. **Model picker dropdown** — defer until m13 enables the picker.

Steps 1–5 are home-route only and can ship in one pass. Step 6 lightly touches `app-shell.tsx` and needs a new route. Steps 7–8 are deferred.

## Risks

- Trying to mirror the video background without a real asset will fail; the animated-gradient fallback should be measured before committing time to it.
- `mix-blend-plus-lighter` doesn't compose well over arbitrary backgrounds — only safe over the rail's known colors. Scope carefully.
- The bright send-button gradient must stay legible over Alfred's `bg-[#080808]` — verify after applying.
