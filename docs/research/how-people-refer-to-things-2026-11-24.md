# How people refer to things when they talk to an assistant

Status: Research, 2026-11-24. No runtime change. It is an input for the resolution theory of [memory.md §4](../theory/memory.md#4-resolve-a-name-at-the-start-of-a-turn) and the plan [memory-name-links-v1](../plans/memory-name-links-v1.md). It decides nothing.

The question: how do people refer to things, people, events, and periods of their own life when they ask a personal assistant? The goal is a list of reference kinds that comes from evidence, not from a few examples.

All quotes were checked against the source text on 2026-11-24. One exception: the Conway paper. A direct download was blocked, so its quote was checked against two indexed copies of the paper text (the author's upload and a mirror), not the publisher PDF. Each numbered finding says which source supports it. Points that no source states are marked "our inference".

Limits of the evidence. No source studies one person and an LLM assistant over years, which is Alfred's case. The email studies are about search boxes, not chat. LoCoMo, LongMemEval, and TimelineQA use synthetic people and model-written text. LSC uses one real lifelogger. The numbers show a direction, not a size for Alfred.

## Sources

| Title                                                                                                                   | Date                 | URL                                                                       |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------- |
| ReALM: Reference Resolution As Language Modeling (Apple)                                                                | 2024-03 (v2 2024-08) | https://arxiv.org/abs/2403.20329                                          |
| Contextual Slot Carryover for Disparate Schemas (Amazon Alexa)                                                          | 2018-06              | https://arxiv.org/abs/1806.01773                                          |
| Improving Long Distance Slot Carryover in Spoken Dialogue Systems (Amazon)                                              | 2019-06              | https://arxiv.org/abs/1906.01149                                          |
| CREAD: Combined Resolution of Ellipses and Anaphora in Dialogues (Apple)                                                | 2021-05              | https://arxiv.org/abs/2105.09914                                          |
| Stuff I've Seen: A System for Personal Information Retrieval and Re-Use (Dumais et al., SIGIR)                          | 2003-07              | http://susandumais.com/siscore-sigir2003-final.pdf                        |
| Exploring Memory in Email Re-finding (Elsweiler, Baillie, Ruthven, ACM TOIS 26(4))                                      | 2008-10              | https://epub.uni-regensburg.de/22682/1/Tois2008_exploring_email.pdf       |
| Characterizing Email Search using Large-scale Behavioral Logs and Surveys (Ai, Dumais, Craswell, Liebling, WWW)         | 2017-04              | https://archives.iw3c2.org/www2017/proceedings/proceedings/p1511.pdf      |
| Understanding the Long-Term Use of Smart Speaker Assistants (Bentley et al., IMWUT 2(3))                                | 2018-09              | https://frankbentley.com/wp-content/uploads/2021/12/ghome-imwut-final.pdf |
| Calendar.help: Designing a Workflow-Based Scheduling Agent with Humans in the Loop (Cranshaw et al., CHI)               | 2017-05              | https://arxiv.org/abs/1703.08428                                          |
| TimelineQA: A Benchmark for Question Answering over Timelines (Meta)                                                    | 2023-06              | https://arxiv.org/abs/2306.01069                                          |
| Comparing Approaches to Interactive Lifelog Search at the Lifelog Search Challenge (LSC2018) (ITE Trans. 7(2))          | 2019-04              | https://doras.dcu.ie/23096/1/ITE_TMTA_LSC2018%20%2810%29.pdf              |
| LSC'26 official tasks                                                                                                   | 2026                 | https://lifelogsearch.org/lsc/tasks                                       |
| Evaluating Very Long-Term Conversational Memory of LLM Agents (LoCoMo)                                                  | 2024-02              | https://arxiv.org/abs/2402.17753                                          |
| LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory (ICLR 2025)                                   | 2024-10              | https://arxiv.org/abs/2410.10813                                          |
| TimeML Annotation Guidelines Version 1.2.1                                                                              | 2006-01              | https://timeml.github.io/site/publications/timeMLdocs/annguide_1.2.1.pdf  |
| The Construction of Autobiographical Memories in the Self-Memory System (Conway, Pleydell-Pearce, Psych. Review 107(2)) | 2000-04              | https://doi.org/10.1037/0033-295X.107.2.261                               |

Not used: the NTCIR Lifelog overview papers. The LSC sources cover the same query style with first-party task text. The Bentley smart-speaker study is used only as a contrast (section 1.10).

## 1. The reference kinds that the evidence supports

### 1.1 Name

**Definition.** A proper name or a label that the user gives a thing: a person, a company, a product, a place, a project.

**Phrasings.** "Call Mom." (ReALM; "Mom" is the label of a contact). Email search queries "james", "gym", "toyota" (Ai 2017). "find when I was in a Norwegian furniture store" (LSC2018). "How many times did I visit the 'Waggy Tail Tea Rooms'?" (LSC'26).

**How common.** "25% of the queries involved people's names suggesting that people are a powerful memory cue for personal content" (Stuff I've Seen, 234 users, six weeks). In Outlook email logs, "18% of queries contain advanced syntax with from: occurring in 13.6% and to: occurring in 2.7% of queries" (Ai 2017). Email queries had "1.59 words on average" (Ai 2017), so a name is often the whole query.

**What resolution needs.**

- A name is not one thing for all time. "Even when people issue the same name query, they appear to want information from a different message or thread at different points in time" (Ai 2017).
- A name can be ambiguous across the world: "since “San Jose” in Rewrite turn 3 can be either San Jose in Costa Rica or San Jose in California, it is likely that the system ends up with an incorrect response" (CREAD).
- A relation word can be used as a name. "Mom" is a contact label in ReALM. Thus name and relation are not separate in the user's words.

### 1.2 Type (class) reference to one thing

**Definition.** The user names only the kind of thing, and the kind picks one item from a small set.

**Phrasings.** "if the user says “play this”, we know that they are referring to an entity like a song or a movie, as opposed to a phone number or an address; “call him” likewise refers to a contact or possibly a phone number, as opposed to an alarm" (ReALM, "type-based" references).

**What resolution needs.** Each candidate needs a kind. The verb ("play", "call") carries the kind. ReALM also allows a set answer: "for the query “play it”, “it” can be resolved to all entities of both the types “music” and “video”".

### 1.3 Class reference to a set (quantified)

**Definition.** The user means all members of a class, often to count, compare, or list them.

**Phrasings.** "How many musical instruments do I currently own?" (LongMemEval, multi-session). "How many times did I visit the dentist this year?" and "How much did I spend on pet care last year?" (TimelineQA). "How many intercontinental flights did I take in 2019 (a flight must cross a continental boundary to be counted)?" (LSC'26).

**How common.** TimelineQA names aggregate queries as one of its three classes of question. LongMemEval names multi-session reasoning ("aggregation and comparison") as one of five core abilities. LoCoMo: 14.6% of questions are multi-hop.

**What resolution needs.** Complete coverage of the class, or a plain statement of the gap. The LSC'26 task must define the class inside the question ("must cross a continental boundary"). Thus the class boundary is often the user's own, not a source field. TimelineQA: "the user may ask how much they spent on utilities last month, while the lifelog has individual utility bills, but the system may not be aware of which bills are considered utility bills."

### 1.4 Relation

**Definition.** The user names a thing by its link to the user or to another thing.

**Phrasings.** "When did my mom have a knee operation?", "What's the name of the company that repaired my A/C?", "What's the name of my daughter's first-grade teacher?" (TimelineQA, atomic questions). "When was the last time I took my dad for his annual checkup?" (TimelineQA Table 8).

**What resolution needs.** A link from an anchor (usually the user) to the thing, and often a second hop ("my daughter's first-grade teacher" is two hops). TimelineQA notes that episodes "can either be done by the owner of the lifelog or by someone in their family or circle of acquaintances, e.g., mom moving to Seattle". So a relation can point to another person's event, not only to a person.

### 1.5 Description by property

**Definition.** The user picks the thing by a property: a place, a feature, a content detail.

**Phrasings.** "Call the one on Rainbow Rd." (ReALM). "Descriptive references, in contrast, tend to use a property of the entity to uniquely identify it: “The one in Times Square”" (ReALM). "I was looking for an email from a church member that contained an excel spreadsheet that included job assignments/role and responsibilities for a church event" (Ai 2017; the query the person typed was "james").

**What resolution needs.** A search over content and fields, not a name lookup. The description is much richer than the query: "People's descriptions of what they were looking for were quite rich, although the queries they used were much simpler" (Ai 2017). In chat, the user can say the rich description, so the system gets more cues than a search box gets (our inference).

Kinds combine: "references might rely on both types and descriptions to unambiguously refer to a single object: consider the examples “play the one from Abbey Road” vs “directions to the one on Abbey Road”" (ReALM).

### 1.6 Description by topic or purpose

**Definition.** The user picks the thing by what it was about, or why it existed. This is "the laptop thing".

**How common.** This is the strongest cue in the email data. In Elsweiler 2008, people remembered "the topic of the email, which was remembered in 85.1% of tasks. This was followed by the reason the email was sent (80.9%), the sender of the email (77.1%), and temporal information (57.5%)". In Ai 2017, "62.9% of people recalled something about the content of the emails they were looking for".

**What resolution needs.** Semantic search over the raw record and over past chats. The user's word for the topic is often not in the record. TimelineQA: "a user might ask when they had a drink with a particular friend, while the lifelog may say that they went to a bar before dinner."

### 1.7 Back-reference in the conversation (anaphora)

**Definition.** A pronoun or a short noun phrase that points to something said earlier in the same talk.

**Phrasings.** "if the user says “Text her”, the reference “her” needs to be resolved to the contact for “Mom” that was brought up in the previous turn" (ReALM). "“the capital” in user turn 3" (CREAD).

**How common.** In MuDoCo (six assistant domains), "Out of all examples that are not the first turn, 64.2% of them contain coreference links and 43.7% of them require query rewrite" (CREAD).

**What resolution needs.** The recent turns, including the assistant's own turns. Distance matters. Models that decide each slot alone show "poor performance over longer context dialogues" (Amazon 2019).

### 1.8 Ellipsis (no referring word at all)

**Definition.** The user leaves the referent out. The system must carry it from context.

**Phrasings.** "ellipsis happens in user turn 2 where the user is asking for the capital of “Costa Rica” without explicitly mentioning the country again" (CREAD). In the Alexa example, the user says "thanks, send directions to my phone" and the system must carry "la taqueria" and "san francisco" from earlier turns in other domains (Amazon 2018). The paper defines the problem as a case "where a user utterance can refer back to a set of slots implicitly or explicitly" (Amazon 2018).

**What resolution needs.** A carried state of the talk, across topics. The draft taxonomy has no slot for a reference with no words. A name lookup on the message finds nothing, because nothing is written (our inference).

### 1.9 Reference to what the assistant showed or said

**Definition.** The user points at an item in the assistant's own output: a list, a draft, a recommendation.

**Phrasings.** "Call the bottom one." after a list of pharmacies (ReALM). "Can you remind me of the romantic restaurant in Rome you recommended for dinner?" (LongMemEval, single-session-assistant). In Calendar.help, invitees pick from offered times "directly by referring to any option using its attributes (e.g. “Monday at 2pm works for me”) or indirectly using different language constructs (e.g. “any time after 4pm.”)".

**What resolution needs.** The assistant's outputs must stay readable as referents, with their order. ReALM treats the items of a shown list as "conversational entities".

### 1.10 Ambient (deictic) reference

**Definition.** The thing is in front of the user but not in the talk: on the screen, or a process that runs now.

**Phrasings.** "Call this number (present onscreen)" (ReALM). ReALM's background entities: "an alarm that starts ringing or music that is playing in the background".

**What resolution needs.** The system must know what the user sees now. For Alfred this is the open page: a mail, a briefing item, a todo (our inference).

**Contrast.** Smart speaker logs show short commands about the home: "The median command to the Google Home device was four words long", and "Automation is about “turn”ing on and off devices in the “kitchen” on the “table” or in a “room.”" (Bentley 2018, 65,499 commands, 88 homes). These are mostly place-and-type references to devices. The logs do not show references to the past life of the user. Personal history appears in the email, lifelog, and memory sources, not in voice command logs.

### 1.11 Selector: first, last, most recent, the Nth

**Definition.** An ordinal or a recency word that picks one item from a set of events or things.

**Phrasings.** "I was trying to find out when my last oil change was." (Ai 2017). "Where did I go on my most recent family trip?" (LongMemEval, knowledge-update). "When was the first time I met Avery?", "When was my first job interview?" (TimelineQA Table 8). "Saturday morning Coffee in Costa Coffee with a friend, the first in September" (LSC2018, topic N01). "It was the first leg of my journey." (LSC'26).

**What resolution needs.** The full set, in order by the time it happened. TimelineQA: "If a user asks when was the first time she traveled to Tokyo, the system needs to find all instances of the user's travel to Tokyo and then return the first one."

### 1.12 Episode or period

**Definition.** A past activity, event, or stretch of life that no single record holds. See sections 2 and 3.

**Phrasings.** "What places did I visit when my mom came to visit Seattle?" (TimelineQA). "How long was my break between leaving my last job and starting my current job?" (TimelineQA). "I was involved in a salon business. Beside the salon was a pharmacy. What was the name of the pharmacy?" (LSC'26). "It was my favourite restaurant while it was open." (LSC'26). "Lifetime periods, such as when I was at school, when I was at University, working for company X, when the children were little, when I lived with Y" (Conway 2000).

**What resolution needs.** The system builds the episode at question time from many records, with fuzzy ends. Section 3 gives the detail.

### 1.13 A referent that does not exist (false premise)

**Definition.** The user refers to a thing that the record does not hold, or that never existed.

**Phrasings.** "How many fish are there in my 30-gallon tank?", when the user only mentioned a 10-gallon and a 20-gallon tank. The expected answer starts "You did not mention that you have a 30-" (LongMemEval, abstention).

**What resolution needs.** A "none" outcome that the system says aloud. ReALM builds it into the task: "the answer could also be "None of these", in which case the model needs to predict “0”."

## 2. Time references and memory cues

### 2.1 Kinds of time cue

| Kind                                 | Examples from the sources                                                                                                | Source                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| Absolute                             | "in 2019", "Christmas Eve 2019", "in March and April"                                                                    | LSC'26; LongMemEval                               |
| Relative to now                      | "last week", "late last night", "last month"                                                                             | TimeML (`temporalFunction` examples); LongMemEval |
| Underspecified or fuzzy span         | "in recent months" (`value="PXM"`); a `mod` of `APPROX`, `START`, `MID`, `END`                                           | TimeML 1.2.1                                      |
| Part of a period                     | "early morning on a Friday"; "sometime next week, preferably later in the week"                                          | LSC'26 KIS; Calendar.help                         |
| Anchored to another event            | "after flying to Norway"; "How many days before the 'Rack Fest' did I participate in the 'Turbocharged Tuesdays' event?" | LSC2018 N05; LongMemEval                          |
| Anchored to a state or a life period | "when I'm back on EST"; "while it was open"; "prior to 2010" for a home; "when I lived with Y"                           | Calendar.help; LSC'26; Conway                     |
| Selector in time                     | "my last oil change"; "the first in September"; "my last two rides"                                                      | Ai 2017; LSC2018; TimelineQA                      |
| Duration between events              | "How long was my break between leaving my last job and starting my current job?"                                         | TimelineQA                                        |

TimeML gives the mechanics for the event-anchored kinds. A time expression with missing parts gets `temporalFunction="true"` and an `anchorTimeID` to the time that completes it. A link between two events is a TLINK, with relations such as "One before the other", "One including the other", and "One holds during the other". An anchor in TimeML is a time or an event in the same text. A personal life period ("before I moved") has no place in the scheme unless an event for it exists (our inference).

TimeML is for news text. It does not model a user's personal periods.

### 2.2 What cues people remember

| Cue                           | Evidence                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Topic, content                | 85.1% of tasks (Elsweiler 2008). 62.9% of survey answers for email (Ai 2017).                                                         |
| Reason or purpose             | 80.9% of tasks (Elsweiler 2008).                                                                                                      |
| Person (sender, other people) | Sender 77.1%, other recipients 46.8% (Elsweiler 2008). Sender 52.1% (Ai 2017). 25% of queries hold a person's name (Stuff I've Seen). |
| Time                          | 57.5% of tasks, roughly (Elsweiler 2008). "20.3% remembered roughly when the email was sent or received" (Ai 2017).                   |
| Place                         | Central in lifelog topics ("in a Norwegian furniture store", "the DCU coffee shop"). No email study measures it.                      |
| Action or activity            | Lifelog topics are written as activities: "I was building a computer", "I was reading a paper onboard an airplane" (LSC'26).          |

Three patterns matter more than the single numbers:

1. **Time is a weak cue, but people use it as a filter.** "Date is a reasonable alternative for searching over personal content since people often remember roughly when something happened" (Stuff I've Seen). The same paper reports that a date range was the second most common filter. But Elsweiler concludes: "focusing support on temporal memories is probably unwise for email re-finding." In Ai 2017, "Date is seldom specified explicitly". So a time cue is usually rough or missing. A system must not need one.
2. **Cues decay at different rates.** The sender was remembered in 95.6% of "hot" tasks, 71.1% of "warm" tasks, and 56.7% of "cold" tasks (Elsweiler 2008). Topic stayed high (80.0% for cold tasks). Old episodes are found by topic more than by person.
3. **For a set of items, people remember the person and not the time.** In multi-item tasks, the sender was remembered in 90.5% of tasks, and time in only 34.9% (Elsweiler 2008). An episode spans many items at many times, so no one date fits.

People also recall in steps. The LSC topics were "constructed to provide additional contextual information (i.e., get easier) every thirty seconds (e.g. ‘I was looking at chairs’, ‘It was a Monday afternoon’)" (LSC2018). Stuff I've Seen users valued the tool "when they could only remember one or two vague things about an item, e.g, a general time frame or a rough topic."

Most re-found items are recent, but the tail is long: of items opened from Stuff I've Seen, "6.6% of the items opened were first seen that day, 21.9% within the last week, 45.9% within the last month, and 89.4% during the last year."

## 3. Episodes: a past activity that no single record holds

**The sources agree that an episode is built, not stored.**

- TimelineQA: "Some raw data already describes episodes (e.g., purchase or content consumption episodes). Other episodes are then inferred by analyzing and fusing multiple pieces of raw data (e.g., a trip, or a meal with friends). Of course, the inference step is a best-effort one, which means that some questions may still be impossible to answer". Also: "Note that episodes can be nested within other episodes."
- Conway 2000: lifetime periods "name distinct periods of time with identifiable beginnings and endings, although these may be fuzzy rather than discrete." Periods overlap: "when I lived with Y may overlap in time with when I worked at X but the thematic knowledge of the two time periods may index different parts of the autobiographical knowledge base". Citing Barsalou (1988), the paper says that general events "encompassed both repeated events (e.g., evening hikes to meadows) and single events (e.g., my trip to Paris)".
- Ai 2017 shows a user who rebuilds an event through a proxy. To learn when the last oil change was, the user searched "toyota", because "The dealer emails me info once I have an appointment". The event is in no record. A related sender holds the trace.

**Three shapes of episode** (from Conway's levels, applied here as our inference):

1. A single bounded event: "my trip to Paris", "the job application", "the A56 setup".
2. A repeated event: "evening hikes", "my dentist visits", "my deploys".
3. A lifetime period: "when I was applying to jobs", "when I lived in X", "while it was open". It has fuzzy ends, and it can overlap other periods.

An episode is both a referent and a time anchor. "Before I moved" uses the episode "the move" to bound another search (our inference, consistent with TimeML anchors and Conway's periods).

**How the benchmarks test episodes.**

| Benchmark   | What it tests                                                                                                                | Note                                                                                                                                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TimelineQA  | Atomic, multi-hop, and aggregate questions over episodes; temporal questions                                                 | Episodes are given. The paper tests QA "after the inference of episodes has been done". So the hard part for Alfred, building the episode, is not tested.                                                                           |
| LoCoMo      | Five question kinds; an event summarization task that asks the agent "to summarize the events within a designated timeframe" | Question mix: single-hop 36%, multi-hop 14.6%, temporal 20.6%, open-domain 3.9%, adversarial 24.9%. The talks are between two LLM agents, not a user and an assistant.                                                              |
| LongMemEval | Five abilities: information extraction, multi-session reasoning, temporal reasoning, knowledge updates, abstention           | Evidence is hidden: "instead of stating “I bought a new car last month,” it might instead ask for help about car insurance and reveal the information incidentally." Most questions need evidence from several sessions, up to six. |
| LSC         | Known-item search with hints over time; QA over months of lifelog                                                            | Topics come from the real lifelogger's own memorable events.                                                                                                                                                                        |

The LongMemEval design is the closest match to Alfred's "back when I was applying to jobs": the facts of the episode come out on the side of other tasks, across sessions, and no session states the episode.

## 4. Failure modes that the sources report

| Failure                           | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Wrong referent**                | The "San Jose" rewrite picks the wrong city (CREAD). The same name query wants a different message at a different time (Ai 2017). In event summaries, an "Event is attributed to the wrong speaker" (LoCoMo, Table 7).                                                                                                                                                                                                                                                                                                                                                                                    |
| **Invented details**              | Event summaries contain "Non-existent details or details from a different event are padded onto an event" (LoCoMo).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Stale fact (knowledge update)** | LongMemEval names it as an ability: "Ability to recognize the changes in the user's personal information and update the knowledge of the user dynamically over time." Its retrieval errors are "mostly of the question type knowledge-update", where the retriever found the new value but not the old one.                                                                                                                                                                                                                                                                                               |
| **Weak time reasoning**           | LLMs lag humans "especially in temporal reasoning, (by 73%)" (LoCoMo). "Naive time-agnostic memory designs perform poorly on temporal reasoning questions" (LongMemEval). A time-aware query expansion improves recall "by an average of 11.3% when using rounds as the value and by 6.8% when using sessions as the value" (LongMemEval). Heuristic time extraction in real scheduling mail reached "39% accuracy in predicting the meeting time", because a thread can hold "multiple valid time expressions within the thread, not all of which are relevant for scheduling purposes" (Calendar.help). |
| **Partial coverage**              | TimelineQA says episode inference is "best-effort" and some questions "may still be impossible to answer". LoCoMo summaries miss events "because the model fails to make temporal and/or causal connections over a lengthy conversation". No source measures the act of stating a partial answer as complete. The link to Alfred's evidence map is our inference.                                                                                                                                                                                                                                         |
| **No abstention**                 | With long context, "gpt-3.5-turbo-16k ... performance on adversarial questions drops to a mere 2.1%" (LoCoMo). LongMemEval tests "false premise" questions where the right answer is "I don't know". Commercial assistants (ChatGPT, Coze) lose accuracy as history grows; the abstract reports "a 30% accuracy drop on memorizing information across sustained interactions" (LongMemEval).                                                                                                                                                                                                              |
| **Vocabulary gap**                | "drink with a particular friend" vs "went to a bar before dinner"; "utilities" vs individual bills (TimelineQA).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Long-distance carryover**       | Per-slot models do badly "over longer context dialogues" (Amazon 2019).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Over-asking**                   | No source in this set measures it. Calendar.help reports that its automatic follow-ups to invitees could be "a little too pushy", but that is follow-up mail, not a clarifying question. The LSC hint design shows that people add detail in steps, which supports one targeted question over a list of options (our inference).                                                                                                                                                                                                                                                                          |

## 5. What this means for Alfred

### 5.1 Where the draft taxonomy holds

- **Name** holds. It maps to the name link of [memory.md §3](../theory/memory.md#3-the-parts). Supported by Stuff I've Seen and Ai 2017: names are the most frequent explicit cue, and a short name is often the whole query.
- **Relation** holds. Supported by TimelineQA (one-hop and two-hop relations). In the [context graph](../theory/context-graph.md#the-words), a relation needs a **link**, and "No table today" holds links. "alfred's deploys" and "my daughter's teacher" are both link hops. Our inference: relation references are a second reader that needs the link table, after the "Priya works at X" writer that context-graph.md names.
- **Description** holds, but it is two kinds (section 5.2).
- **Back-reference** holds for pronouns. Supported by ReALM and CREAD.
- **Episode/period** holds and is the strongest new kind. Supported by TimelineQA, Conway, LSC, LongMemEval.

### 5.2 Where it breaks

1. **"Class" is two kinds.** A type that picks one thing ("call him", ReALM) is different from a set ("all my deployments", "how many instruments", LongMemEval, TimelineQA). The set kind needs complete coverage or a stated gap. The single kind needs a kind on each candidate. [context-graph.md](../theory/context-graph.md#where-alfred-is-confused-today) item 5 says "A node has no kind" and "No reader needs it yet". Our inference: both class kinds are such a reader. "status across all my deployments" needs to know which things are deploys, and from which providers.
2. **"Description" is two kinds.** A property description ("the one on Rainbow Rd") is different from a topic or purpose ("the laptop thing"). Topic and reason are the two strongest cues in Elsweiler 2008 (85.1% and 80.9%). memory.md §4 step 4 already sends a loose description to `system.search_context`. That holds, but the search must read past chats and mail, and the user's word is often not the record's word (TimelineQA). Our inference.
3. **"Back-reference" misses ellipsis.** A reference with no words (CREAD, Amazon 2018) gives the turn-start lookup nothing to match. The lookup of memory.md §4 matches "the words of the user's message". An elided referent must come from the thread state, not from the lookup. Our inference.
4. **Name and relation blur.** "Mom" is a contact name in ReALM. The name-links plan lists "love of my life" as a name of the person. Our inference: a relation phrase anchored on the user ("my wife") can be stored as a name link, but it has validity (it can change) and it composes ("my wife's sister"). Store the relation as a claim or link, and let the name link carry only the words.
5. **Time is not a kind.** It is a cue that modifies every kind (section 2). An episode can also be the time anchor for another reference.

### 5.3 Kinds that are missing from the draft

| Missing kind                                                                                 | Source                                                     | Where it touches Alfred                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ellipsis                                                                                     | CREAD; Amazon 2018                                         | The thread state, not the name lookup                                                                                                                                                                                                                                                                              |
| The assistant's own output ("the second one", "the draft you wrote", "what you recommended") | ReALM; LongMemEval single-session-assistant; Calendar.help | Principle 5 says an output is never **evidence**. It can still be a **referent**. Briefings, remarks, and drafts must stay addressable. [journal.md §6](../theory/journal.md#6-speak-and-what-happens-after) already binds a reply to its remark record. Our inference: the same rule applies to every shown item. |
| Ambient ("this mail", the item on screen)                                                    | ReALM on-screen and background entities                    | The web UI must pass the open item into the turn. Our inference.                                                                                                                                                                                                                                                   |
| Selector (first, last, most recent, Nth)                                                     | TimelineQA; LongMemEval; Ai 2017; LSC                      | Needs the happened time of [stores.md §3](../theory/stores.md#3-time), not the received time. A selector over received time gives a wrong "last" for a backfilled thread. Our inference.                                                                                                                           |
| False premise (no referent)                                                                  | LongMemEval abstention; ReALM "None of these"              | memory.md §4 logs a miss as `none`. The user must also hear "I have no record of X". Our inference.                                                                                                                                                                                                                |
| Self-reference ("Alfred", "you")                                                             | No source in this set                                      | Our inference. memory.md §3 already treats Alfred as a thing. "you" in chat is the same thing as "Alfred".                                                                                                                                                                                                         |

### 5.4 Mapping to the theory pages

- **[memory.md §1](../theory/memory.md#1-the-job), the worst errors.** Error 1 ("acts on the wrong thing and does not say so") is the "San Jose" and same-name failures. Supported by CREAD and Ai 2017. Error 4 ("searches for a thing that it already knows") applies to names only. For an episode, a search at question time is the correct method, not a fault (TimelineQA builds episodes from raw data). Our inference.
- **[memory.md §4](../theory/memory.md#4-resolve-a-name-at-the-start-of-a-turn), the name lookup.** It covers names (1.1) and part of relations. It does not cover ellipsis, ambient, the assistant's output, selectors, sets, or episodes. The resolution log has outcomes hit, none, and ambiguous. Our inference: it also needs to record "resolved by search" and "built from many records", so a weekly report can see how often each kind occurs. This gives Alfred its own frequency numbers, which no source gives for Alfred's case.
- **[journal.md §3](../theory/journal.md#3-the-parts), entries and searchable past chats.** Supported by LongMemEval: facts come out "incidentally" inside other tasks, so past chats must be searchable to answer "what did I tell you about the job search". A journal entry is written from the time Alfred exists. An episode from before then ("back when I was applying to jobs", if it was before the connect) has no entry. It must be built from mail, which [evidence-map.md §3](../theory/evidence-map.md#3-the-reach-facts-known-today) says reaches "Years back". Our inference: a journal entry is a pointer that helps build an episode. It is not the episode record, and it is never evidence (journal.md §3 already says so).
- **[context-graph.md](../theory/context-graph.md#the-words), thing, identity, name, link.** Names: supported. Links: needed by relation hops and by "alfred's deploys" (TimelineQA multi-hop). Kinds on nodes: needed by class references (ReALM type-based; our inference for sets). An episode is not a thing with an identity. It is a judgment over events (`observations`) and mail (our inference, consistent with TimelineQA's "inferred" episodes and stores.md's rule that a statement has no fixed shape).
- **[evidence-map.md](../theory/evidence-map.md), the reach of each store.** Set queries and episodes fail silently when a store does not reach far enough. "Activity record ... From the integration connect" means "all my deploys since March" is complete only after the connect date. Our inference: an answer to a set or episode question must state the reach it used. This is the "partial coverage stated as complete" failure, and evidence-map worst error 1 ("a wrong conclusion looks grounded") is its root.
- **[stores.md §3](../theory/stores.md#3-time), the two times.** Every time cue and every selector resolves against the happened time. Supported by LongMemEval: time-aware indexing on event dates improves recall. A fuzzy time ("last spring") is a range, not a point. memory.md §3 already says "An unknown start stays unknown". TimeML's `APPROX` and underspecified `PXM` are the formal form of the same rule. Our inference: store and compare fuzzy times as ranges, and never fill a missing year from the write time.

### 5.5 What to decide next (inputs, not decisions)

1. Whether the resolution theory lists kinds at all, or lists only the **outcomes** (one thing, a set, a built episode, the assistant's own item, none). The sources support kinds that combine freely (ReALM: "references might rely on both types and descriptions"). A fixed kind per reference will not hold. Our inference.
2. Where an elided referent and an ambient referent come from: the thread state and the UI. Neither is memory.
3. How an answer about a set or an episode states its reach.

## 6. Test references for an eval set

Tags: **N** name, **T** type (one thing), **S** set (class), **R** relation, **D** property description, **P** topic/purpose description, **B** back-reference (pronoun), **E** ellipsis, **O** the assistant's own output, **A** ambient, **SEL** selector, **EP** episode/period, **TM** time cue, **FP** false premise, **SELF** self-reference. "Breaks" marks a case built to break the draft taxonomy.

| #   | Reference                                                     | Kinds      | Why it is here                                                                           |
| --- | ------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------- |
| 1   | "what's the status on Alfred"                                 | N, SELF    | Owner case. One name, three candidate things (the assistant, the repository, a person).  |
| 2   | "status across all my deployments"                            | S          | Owner case. Set across providers; coverage must be stated.                               |
| 3   | "alfred's deploys"                                            | N, R, S    | Owner case. A name, then a link hop to a set.                                            |
| 4   | "Rosie"                                                       | N          | Owner case. A nickname that is not in any identity.                                      |
| 5   | "my wife"                                                     | R          | Owner case. A relation anchored on the user.                                             |
| 6   | "the laptop thing"                                            | P          | Owner case. Topic only, no name.                                                         |
| 7   | "that job application"                                        | P, EP      | Owner case. Could be one mail thread or a whole episode.                                 |
| 8   | "back when I was applying to jobs"                            | EP, TM     | Owner case. A lifetime period with fuzzy ends.                                           |
| 9   | "did it go through?" (after a talk about a refund)            | B          | Owner case ("it"). Pronoun to an earlier turn.                                           |
| 10  | "that one" (after Alfred lists three PRs)                     | B, O       | Owner case. Points at Alfred's own list.                                                 |
| 11  | "and on Vercel?" (after "any failed deploys on Railway?")     | E, S       | Breaks: no referring word for "failed deploys".                                          |
| 12  | "the second one" (after a briefing)                           | O, SEL     | Breaks: a referent that is an Alfred output.                                             |
| 13  | "send the draft you wrote yesterday"                          | O, TM      | Breaks: Alfred output, anchored in time.                                                 |
| 14  | "reply to this" (with a mail open in the web UI)              | A          | Breaks: the referent is on screen, not in the talk.                                      |
| 15  | "Rosie's sister"                                              | N, R       | Two hops from a nickname.                                                                |
| 16  | "my mom's flight next week"                                   | R, TM      | Relation to another person's event in the future.                                        |
| 17  | "the company that fixed the AC"                               | D, R       | Description by role in an event (TimelineQA form).                                       |
| 18  | "the guy from the gym whose name I saved in a note to myself" | D, P       | Ai 2017 form; the answer is in a mail to self.                                           |
| 19  | "when was my last oil change?"                                | SEL, EP    | Ai 2017 form; the event is only traced through a dealer's mail.                          |
| 20  | "my most recent trip"                                         | SEL, EP    | Knowledge-update form: the answer changes over time.                                     |
| 21  | "the first time I met Priya"                                  | N, SEL, EP | Needs the full set of meetings in happened-time order.                                   |
| 22  | "how many times did I reschedule with the dentist this year?" | S, EP, TM  | Aggregate; the class boundary ("reschedule") is the user's.                              |
| 23  | "how much did I spend on utilities last month?"               | S, TM      | Breaks: "utilities" is the user's class, not a source field (TimelineQA).                |
| 24  | "before I moved"                                              | EP, TM     | An episode used as a time anchor.                                                        |
| 25  | "around the time of the wedding"                              | EP, TM     | Event-anchored fuzzy time (TimeML `APPROX` form).                                        |
| 26  | "last spring"                                                 | TM         | Fuzzy span; the season boundary depends on the user's place.                             |
| 27  | "the week the A56 arrived"                                    | EP, TM     | Anchored to an event that Alfred has in mail.                                            |
| 28  | "the restaurant we liked, while it was open"                  | P, EP      | LSC'26 form: a referent defined by a period of its own life.                             |
| 29  | "while I was at my last job"                                  | R, EP      | Lifetime period; "last job" itself needs a selector.                                     |
| 30  | "the thing I asked you to watch in November"                  | O, P, TM   | Points at a journal lookout that Alfred holds.                                           |
| 31  | "what did you tell me about Vanta?"                           | N, O       | The referent is the assistant's past answer (LongMemEval single-session-assistant form). |
| 32  | "my 2019 tax refund" (no such mail exists)                    | FP, TM     | Breaks: no referent; Alfred must say so (LongMemEval abstention form).                   |
| 33  | "the PR Priya reviewed" (Priya reviewed three)                | N, R, D    | Ambiguous after the relation hop; Alfred must ask.                                       |
| 34  | "the meeting where we decided to drop Redis"                  | P, EP      | Topic plus an event; the decision may be in notes, not the invite.                       |
| 35  | "everything from when the server kept crashing"               | EP, S      | Breaks: a set bounded by an episode, not by a date.                                      |
| 36  | "you" ("can you check your own deploy?")                      | SELF, R    | Self-reference with a link hop to the repository.                                        |
| 37  | "my repo" (the user owns several)                             | R, T       | A relation that names a type, with more than one candidate.                              |
| 38  | "the Acme thing" (a company and a dispute share the name)     | N, P       | A name used as a topic label for a matter.                                               |
