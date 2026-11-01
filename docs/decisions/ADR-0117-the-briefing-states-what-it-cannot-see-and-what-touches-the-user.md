# ADR-0117 — The briefing states what it cannot see, and what in the world touches the user

**Status.** Proposed. Slices 1 and 2 are built (2026-11-01), with the changes in **Built: slices 1 and 2**. Slices 3 and 4 are not built. Generalizes the connection block of the ADR-0100 amendment of 2026-10-28 to every briefing input. Extends ADR-0048 (content model) and ADR-0064 (quiet morning). Uses the ADR-0100 cause-and-recovery shape.

**Decision.** Every input that the briefing gather reads declares its **provenance**: `live`, `fallback`, `stale`, or `unavailable`, each with a cause and a recovery. One rule puts each non-live input that the user can repair into the fixed block of the ADR-0100 amendment. The composer receives the same list, so its prose cannot claim a source that it did not have. Separately, an official warning whose area contains the user's place, on the day of the briefing, is an at-risk item. A geometry match selects it, not a model.

---

## What happened

These facts are from production on 2026-10-28.

- **The weather was for another city, and nothing said so.** The user has no `location` preference. At that time, `resolveWeatherLocation` (`briefings/gather.ts`) fell back to `weatherFallbackFor(timezone)`, which maps `Asia/Calcutta` to Delhi. `readUserLocation` (`knowledge/location.ts`) replaced it in slice 1. The briefing showed Delhi's weather as if it were the user's own. The user lives in Bhubaneswar, near the coast where a cyclone made landfall that day. The briefing had no line about it.
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

## Built: slices 1 and 2 (2026-11-01)

The code follows decisions 1 to 3, with these changes. Each change is a fact about the build, not a new decision.

### Provenance

- **No `set` recovery yet.** No surface writes the `location` preference: there is no settings field and no chat tool. A recovery that the user cannot do is not a recovery. So the time-zone city is `fallback` with recovery `none`. It reaches the log only. The `fallback`/`set` row of decision 2 waits for a surface that can set the city (owner decision). An issue tracks it. `gatherProvenanceSchema` has no `set` arm until then.
- **The compiler holds the list.** The gather builds its provenance from a table that `satisfies Record<GatherInput, StatedProvenance>`. `StatedProvenance` is a non-empty tuple, so each input states at least one entry. A new member of `GATHER_INPUTS` does not compile until it states its read. The stored field stays optional, so a gather from before this build still parses. Each reader treats an absent list as no statements.
- **One owner decides who reads each entry.** `provenanceAudience` (`briefings/provenance.ts`) gives each entry its block row, its composer fact, and its log line. `blockingProvenance` gets the block rows from it. `@alfred/contracts` keeps only the `BlockingGatherProvenance` shape. Each entry that is not `live` goes to the log.
- **`unavailable` has five causes.** `scope_missing` and `needs_reauth` have recovery `connect`, and each is a block row that stops a quiet morning. `read_failed` has `retry`. `not_connected` and `no_place` have `none`. The schema pins each cause to its recovery.
- **A Google row that is not active is a repair.** When no Google credential selects for an input, the gather reads the integration availability. When a credential row exists but no row passes the connected rule (ADR-0093), the cause is `needs_reauth`. It is a block row with recovery `connect`. Only "no credential row" gives `not_connected`. A fault of the availability read gives `read_failed`. The GitHub merged read does not make this check: its `no_connection` status gives `not_connected`.
- **`not_connected` is a composer fact, not a row.** No credential row is also what a deliberate disconnect leaves (ADR-0100 amendment 2026-10-28, item 3). So `not_connected` makes no block row and does not stop a quiet morning. The composer gets it as a fact (owner decision). The prompt tells the composer to say, in one short clause, that it could not read the source and what the briefing therefore cannot see. The prompt also tells it never to say that the day is clear on that basis.
- **The composer gets the inputs that it reads.** `COMPOSER_READS` (`briefings/agent/agent.ts`) lists email, calendar, the merged work in the day shape, and the loop verdicts. The composer gets a fact for each entry of these inputs that is not `live`. Each fact names the tool, the reason, and what the briefing cannot see. When a connection key names the same source, the prompt tells the composer not to repeat the fact in the body. None of these inputs has a `fallback` or a `stale` state today.
- **Weather and the activity list do not reach the composer as facts.** Weather does not reach the composer. The activity list reaches it only as the count behind `get_day_shape.activityVolume`. So their `fallback`, `stale`, and `read_failed` statements stay in the stored gather and the log.
- **One calendar read.** The gather stores its calendar read in the workflow state. `list_calendar_events` returns that list, so the list and the calendar statement come from one read. A run from before this field reads the calendar again.
- **One row per integration.** An input row and a delivery alert for the same integration share a key. The delivery alert takes the row, because the repair link is the same. The delivery row also carries the input entry. So the model that writes the notice gets both facts, and `BROKEN_CONNECTION_GUIDANCE` does not deny the failed read.
- **The stale rule covers the verified pull only, and only a provider time.** `gatherIntegrationActivity` reads only the receipts of the window. The verified pull can report an old failure. Each pull item carries the clock of its time: `provider_event`, `delivered`, or `observed`. An item is stale only when its time is a `provider_event` time before the window start. A `delivered` or `observed` time is Alfred's clock, so the item stays in the list.
- **A failed verified pull is not `live`.** A pull that faults returns the `failed` outcome and writes a log line. The activity statement is then `read_failed` with `retry`, and it names the provider. The composer gets no fact for it. So a failed deploy-status read can make `activityVolume` too low.
- **The stored list has a bound.** `GATHER_PROVENANCE_MAX` is 22. A gather states at most two entries for each of the six inputs (weather: a failed read and its fallback). It also stores at most `GATHER_STALE_PROVENANCE_MAX` (10) stale entries. The verified pull reads at most five targets for each of its two providers, so ten is also its maximum. `boundProvenance` clips the list at the producer and logs each drop. So a stored list never fails its parse on length.
- **The web reads a bad list as absent.** The synced briefing schema (`packages/sync/src/schemas.ts`) reads `provenance` with `.catch(undefined)`. So an unknown or bad entry does not drop the briefing row on the web. The contract schema stays strict on the server write path. The web does not show provenance yet.
- **The email statement checks the credential only.** The email input reads `email_triage`, not Gmail. A failed `email_triage` read throws on purpose and fails the gather. The row is `failed`, the watermark does not move, and the next run reads the same window. A gather that continued would move the watermark past mail that it did not read. So a stored email statement always follows a completed read. It says only whether a Gmail account selects. A fault of the credential check is `read_failed`.
- **One loop's missing read is not an input fault.** The relevance pass already gives that loop an `unverifiable` verdict, and the composer reads it per loop. Only a fault of the whole pass makes `loop_relevance` `unavailable`.
- **One account in a calendar read.** When one Google account reads and another fails, the calendar is `live`, and the failure is a log line.
- **A missing grant is a row, also when the user chose it.** A Google account without the grant for an input gives `scope_missing` and a block row each morning. The owner grants all scopes, so this does not occur today. A user who declines a scope on purpose sees the row until the user grants it.

### Location

- **The reader and its order.** `readUserLocation` (`knowledge/location.ts`) reads the `location` preference first. Then it reads the confirmed `home_city` fact, checked against `home_country`. Then it reads the confirmed free-text `location` fact ("City / region they're based in"). The time-zone city is last. The `location` fact is after `home_city` because it is free text. The reader uses only the newest confirmed fact that the user stated (`isUserStatedSource`). Step 3 of decision 3 (proposals from evidence) is slice 4.
- **The basis.** The reader returns `preference`, `home_fact`, `location_fact`, `timezone_default`, `none`, or `fault`. It does not throw. `Place` (`@alfred/contracts`) is the one shape for a preference, a geocoded fact, and a time-zone city.
- **A confirmed fact that the geocode does not match.** The reader goes on to the next step. When the time-zone city then wins, the reader names the first such fact (`unplaced`). So the weather statement says that Alfred could not place that fact, not that Alfred knows no place.
- **A fault does not become a default.** A failed fact read or a failed geocode is the `fault` basis. The reader does not go on to the time-zone city, because the fault is temporary. Weather is then `read_failed` with `retry`, and the gather does not fail. One `WEATHER_DEADLINE_MS` covers the geocode and the forecast.
- **A long fact is not a place.** The reader does not use a place fact longer than `PLACE_TEXT_MAX` (100 characters). Such a value is not a place name, and its text goes into a bounded provenance reason.
- **The geocode is kept in the process, not with the fact.** Each geocode gives `placed`, `no_match`, or `fault`. The reader keeps a placed result and a miss in an in-process map. A fault is not kept, so the next read tries again. The owner kept the map in the process: Alfred has one user, a restart costs one request for each fact value, and `user_facts` has no column for a place. A preference row would show on the Preferences page as if the user set it.
- **The geocode matches the country by name or by code.** The reader asks Open-Meteo geocoding for ten candidates. Bhubaneswar also names a place in Bangladesh, so the first candidate alone is not safe. With a `home_country` fact, the first candidate in that country wins. The country matches by name, or by ISO two-letter code through `Intl.DisplayNames`. A three-letter value such as "USA" does not match. For a `location` fact, a part after a comma must name the country or the first-level region. Without a country and without such a part, the first candidate wins.
- **Chat reads the same place.** `read_user_context` reads `currentLocation` through `readUserLocation` and `statedLocationLabel`. So chat and the briefing give one answer, and decision 3 holds for chat. Chat gets the user's own words, and no name for a time-zone city. A read can wait for the geocode, up to `GEOCODE_TIMEOUT_MS`, when a fact value is new to the process.

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
