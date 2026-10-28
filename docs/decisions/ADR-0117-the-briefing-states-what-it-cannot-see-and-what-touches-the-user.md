# ADR-0117 — The briefing states what it cannot see, and what in the world touches the user

**Status.** Proposed; not built. Generalizes the connection block of the ADR-0100 amendment of 2026-10-28 to every briefing input. Extends ADR-0048 (content model) and ADR-0064 (quiet morning). Uses the ADR-0100 cause-and-recovery shape.

**Decision.** Every input that the briefing gather reads declares its **provenance**: `live`, `fallback`, `stale`, or `unavailable`, each with a cause and a recovery. One rule puts each non-live input that the user can repair into the fixed block of the ADR-0100 amendment. The composer receives the same list, so its prose cannot claim a source that it did not have. Separately, an official warning whose area contains the user's place, on the day of the briefing, is an at-risk item. A geometry match selects it, not a model.

---

## What happened

These facts are from production on 2026-10-28.

- **The weather was for another city, and nothing said so.** The user has no `location` preference. `resolveWeatherLocation` (`briefings/gather.ts`) falls back to `weatherFallbackFor(timezone)`, which maps `Asia/Calcutta` to Delhi. The briefing showed Delhi's weather as if it were the user's own. The user lives in Bhubaneswar, near the coast where a cyclone made landfall that day. The briefing had no line about it.
- **Alfred already knew the city, in three places.** `user_facts` holds `home_city = "Bhubaneswar"` and `home_country = "India"`, both `confirmed`, and `bio_summary` says "based in Bhubaneswar". The app rail shows weather from browser geolocation (`apps/web/src/lib/weather`), and it keeps that location only in `localStorage`. The briefing reads none of them. Each consumer reads its own copy of one fact, and the server consumer reads the one copy that is empty.
- **The weather source has no warnings.** The gather calls the Open-Meteo forecast. A forecast code is not a warning. A government agency issues the warning.
- **A missing input has no cause.** The gather's one signal for a blind input is a NULL ("A NULL inside it means one source is missing", `schema/briefings.ts`). A NULL carries no cause and no repair. A fallback value carries no mark at all.
- **Old items read as news.** `integration_activity` carried Vercel "failed" deploys from 2025-04-08 and 2025-09-27 in a 24-hour window.
- **The owner cannot list the cases.** "I can't come up with these cases one by one." A design that depends on a hand list of cases fails on the next case.

## Decisions

1. **Each gather input declares its provenance, and the compiler holds the list.** Each contribution returns its value together with one of four states:

   | State | Meaning | Example |
   | --- | --- | --- |
   | `live` | Alfred read the real source for this user, in this window. | Calendar events read from the connected account |
   | `fallback` | Alfred used a default in place of a user fact. It names what it replaced. | Delhi weather in place of the user's city |
   | `stale` | The value is real but older than the window. It names its date. | A deploy failure from 2025-04-08 |
   | `unavailable` | Alfred could not read the source. It names the cause. | GitHub App credential missing |

   Each state except `live` carries a recovery from the ADR-0100 set: `connect <integration>`, `set <preference key>`, `retry`, or `none`. The gather type requires the field, so a new input cannot ship without a statement of its blind state. This is the answer to "I can't list the cases": each new source must answer the question when it is written, and `check-types` refuses it until it does.

2. **One rule chooses what the user sees.**
   - `unavailable` with recovery `connect`: a row in the block. It also stops a quiet morning, because the user lost a source (ADR-0100 amendment, item 2).
   - `fallback` with recovery `set`: a row in a briefing that sends for other reasons. It does not send a morning by itself, because the user did not lose anything. The row states the default and the one action, for example "Weather is for Delhi, the default for your time zone. Set your city."
   - `stale`: the item leaves the news list. It can appear only as an open loop under the ADR-0048 rules.
   - `retry` and `none`: the log only.

   The composer gets the full provenance list as a fact. It must not write "nothing needs your attention" about a source whose state is not `live`.

3. **Location is one fact with one reader, and a default never wins over a confirmed fact.** Location gets one owner reader, as the time zone has `settings({ userId }).timezone()`. Every server consumer (briefing weather, warnings, chat date grounding) reads through it. The time-zone city stays as the last default, but it is marked `fallback`. The order:
   1. The user's stated `location` preference.
   2. The confirmed `home_city` and `home_country` facts (ADR-0080), geocoded one time and kept with the fact.
   3. A city that Alfred proposes from evidence the user owns, and that the user confirms. Candidate evidence: the browser location that the rail already reads, the locations of calendar events, and the sign-in region from `session.ip_address`. Alfred never adopts a proposed city silently. A VPN or a trip makes a wrong silent location worse than a declared default. When the evidence disagrees with step 1 or 2 for several days, Alfred asks whether the user moved.
   4. For one day, an upcoming calendar event in another city is a second place for that day.

   The general rule: **before a consumer uses a default, it reads the confirmed fact that the default stands in for.** A default that wins over a confirmed fact is a defect, and its provenance is `fallback` with recovery `none`, so it reaches the operator log, not the user.

4. **An official warning at the user's place is an at-risk item.** The gather reads official warnings for each place from decision 3, for the briefing day. A warning is selected when its area contains the place, or when the place is inside a fixed distance from the area. That test is geometry, and no model makes it. A selected warning ranks first, under "something is wrong or at risk" in the briefing prompt. The source must be official and public. The candidates must be checked before the build: a global hazard feed for large events (for example GDACS for tropical cyclones, floods, and earthquakes), and a national CAP feed where one exists (for example NDMA Sachet in India, NWS in the United States, and MeteoAlarm in Europe). When the feed fails, the provenance is `unavailable` with `retry`. When the place is a `fallback`, the block row says that Alfred checked warnings for the default city.

5. **The same match covers other official events later.** The rule is "an official event whose place and time touch the user". Weather hazards are the first producer. A later producer, for example a transit strike or a public holiday in the locale of a meeting, uses the same match and needs its own official source. This ADR does not add them.

## Rejected alternatives

- **A list of cases in the prompt.** The owner cannot list them, and a prompt does not make the model apply a rule (ADR-0110 measured a cheap model that ignored a matched instruction for a month).
- **The composer decides what is missing.** On 2026-10-28 the composer dropped an open item because a rule told it to drop rows it could not check. A rendered row cannot be dropped.
- **A silent location from the sign-in IP.** See decision 3.
- **Forecast codes as warnings.** A heavy-rain code is not an agency warning. It has no area, no severity scale, and no issuer.

## Preserved behavior

The ADR-0048 content model, the composer's voice rules, and the weather row format do not change. The ADR-0064 quiet-morning rule changes only by the input from the ADR-0100 amendment. A `fallback` does not send a morning. A user with a `location` preference sees no change in the weather row.

## Residual risk

- Feed coverage differs by country. A country with no CAP feed gets only the large global events.
- A cyclone's area is a forecast track, not a fixed shape. The distance value needs a decision when the feed is chosen.
- A user with no preference and no evidence still gets the time-zone city. The difference is that the briefing now says so.

## Implementation slices

1. The one location reader, with the confirmed `home_city` fact before the time-zone default. This alone fixes the 2026-10-28 weather row.
2. The provenance type on the current contributions: email, calendar, weather, integration activity, the GitHub merged read, and loop relevance. The only visible change is the block rows and the removal of stale activity items.
3. The warnings feed and the geometry match, after a probe of the candidate feeds.
4. The location evidence proposal (rail geolocation, calendar, sign-in region) and its confirmation.
