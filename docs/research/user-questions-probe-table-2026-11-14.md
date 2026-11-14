# Probe table: what each case must know about the user

Status: input for a grilling session. Nothing here is settled. Date: 2026-11-14.

**The question.** Features need foundations, and foundations come from features. This page breaks the loop. It does not derive a foundation from a whole feature. It takes real cases (probes), lists what Alfred had to know about the user to get each case right, and groups those questions. A question that recurs across two or more features is a foundation. A question that occurs once stays inside its feature.

---

## 1. The probes

Each probe is a real case from production or from the owner. "Feature" is where the case surfaced, not where its answer lives.

| # | Probe | Feature | Source |
| - | ----- | ------- | ------ |
| P1 | Nine sign-in and OTP echoes went `urgent` while the A56 order, setup, and delivery sat quiet | Triage, journal, briefing | Prod 2026-11-12/13; `triage.md` echoes |
| P2 | The MacBook Air vs mini chat, then an iCloud sign-in and an Apple Pay card on an Air | Journal | Muse 2026-11-02; `journal.md` §1 |
| P3 | A fashion college search, then a family member gets a place at NIFT months later | Journal | Owner; `journal.md` §1 |
| P4 | "alfred's issues" started a document search, while Alfred held 94 PRs on `99Yash/alfred` | Chat, memory | Prod 2026-11-08; `memory.md` §1 |
| P5 | CI failures on Yash's own repos are `fyi`, because he ships many PRs a day and sees each failure in the PR | Triage | Owner 2026-11-07; plan slice 0 |
| P6 | "Stock mail is not urgent" became about 13 sender addresses and missed the registries | Triage instructions | Prod; ADR-0121 |
| P7 | Six payment failures got `payment`, not `action` | Triage | Prod 2026-11-06 |
| P8 | The chess.com streak mail got four labels with no new evidence | Triage | Prod; ADR-0121 |
| P9 | Vendor webinars got `meeting` | Triage | Prod; ADR-0121, #1750 |
| P10 | Cold outbound and AI-patterned mail vs a real person who waits for Yash | Triage | Plan slice 0 |
| P11 | Two evening briefings led with the echoes | Briefing | Prod 2026-11-12/13 |
| P12 | An edit or a dismissal of a todo is evidence of a preference | Todos, memory | `memory.md` §5 |
| P13 | "I am a junior engineer", then a promotion mail | Memory | `memory.md` §6 |
| P14 | A reply draft must sound like Yash | Reply drafts | `memory.md` §5 |
| P15 | Dimension proposed three workflows from inbox patterns at onboarding | Cold start | `product-direction.md` |

## 2. The questions each probe asks

| # | What Alfred had to know about the user |
| - | -------------------------------------- |
| P1 | Did he do this? Is this hour, device, and account normal for him? What is going on in his life now (a new phone)? What did he buy recently? |
| P2 | What did he say he was deciding? Did he do this? Which device is "the Air"? |
| P3 | What did he ask about before? Who is in his family? |
| P4 | Which thing does he mean by "alfred"? What does he act on most? |
| P5 | How does he work: how many PRs a day, and where does he see failures? Did he already act on this? |
| P6 | What did he say, in his own words? Which senders are "investment" to him? |
| P7 | Does he use this service? Does it cost him something if he ignores it? |
| P8 | Does he ever open or act on this sender's mail? |
| P9 | Does he attend events like this? Who arranged it with him? |
| P10 | Who matters to him? Does he reply to this sender? |
| P11 | What does he care about this morning? What did he already handle? |
| P12 | How does he want things done? |
| P13 | What is true about him now, and since when? |
| P14 | How does he write, and to whom? |
| P15 | What does he do again and again? |

## 3. The questions, grouped

| Group | The question | Probes | Features that ask it |
| ----- | ------------ | ------ | -------------------- |
| **Q-A** | Did the user do this? Did he already act on it? | P1, P2, P5, P11 | Triage, journal, briefing, loop closing |
| **Q-B** | Is this normal for him? (hours, devices, accounts, cadence, the services he uses, the senders he acts on) | P1, P5, P7, P8, P9, P10, P15 | Triage, cold start, briefing |
| **Q-C** | What is live in his life now? | P1, P2, P3, P11 | Journal, triage profile, briefing |
| **Q-D** | Which thing or person does he mean, or does this item name? | P2, P4, P6, P10 | Chat, triage instructions, journal |
| **Q-E** | What did he say before, in his own words? | P2, P3, P6, P13 | Journal, chat, triage, memory |
| **Q-F** | How does he want things done? (style, preferences) | P12, P14 | Todos, reply drafts, briefing |
| **Q-G** | What matters to him? (importance) | P1, P3, P10, P11 | Every feature |

Every group except Q-F recurs across three or more features. Q-F recurs across two.

## 4. From the groups to foundations

| Group | Foundation that answers it | Theory | Code today |
| ----- | -------------------------- | ------ | ---------- |
| Q-A | **What the user did.** One time-ordered record of the user's own acts across every integration, each act marked with its actor. | Partly. ADR-0118 has the record; the research page proposes the actor mark ([agent-memory-foundations](./agent-memory-foundations-2026-11-11.md#42-answer-to-b-learn-only-from-the-users-acts)). | Partly. Every delivery is in `event_receipts`. GitHub acts are in `observations`. Sent mail is in `documents`. Chat turns are in `chat_messages`. Sign-ins and purchases exist only as the mails that report them. No row marks its actor, and nothing joins the stores. |
| Q-B | **How the user usually acts.** Patterns that the model writes from the acts of Q-A. | **Open. No page.** | Not built. `sender_priors` counts Alfred's own labels, which principle 5 forbids. |
| Q-C | **What is live now.** Journal matters, and the profile's now section. | Settled (`journal.md`, `triage.md`). | Not built. |
| Q-D | **What things are, and their names.** The context graph, and name links. | Settled (`context-graph.md`, `memory.md`). | Partly. |
| Q-E | **What the user said.** Searchable chats, and claims with evidence. | Settled (`journal.md` step 1, `memory.md`). | Not built. |
| Q-F | **How the user wants things done.** | Not separate. Edits are evidence for claims (`memory.md` §5). | Partly. |
| Q-G | **Importance.** | Not a store. It is a model judgment over Q-A to Q-E (principle 4). | n/a |

**The dependency order that this shows.**

```text
Q-A  what the user did     (root: only the user's acts are evidence)
 ├── Q-B  how he usually acts   (derived from Q-A only)
 ├── Q-D  things and names      (salience from Q-A)
 └── Q-C  what is live now      (from Q-E chats and Q-A items)
Q-E  what the user said    (root: the user's own words)
Q-G  importance            (a judgment over all of them, never a store)
```

The real roots are two: **what the user did** and **what the user said**. Each is a raw record of the user's own evidence (principle 5). Everything else is a projection of them or a judgment over them. Thus "usual hours" is not a feature of triage. It is one projection of Q-B, and Q-B is one projection of Q-A.

## 5. A candidate for Q-B, to grill (superseded in part by section 6)

Do not design a new store before you check the old ones (principle 3). A candidate that reuses memory:

- **A pattern is a claim.** Its author is "agent-concluded". Its evidence links are act rows from Q-A. It has a validity window. Example: "Yash is active from 10:00 to 02:00 on workdays", citing a sample of acts.
- **The check job keeps it current.** New acts are new evidence for the same claim. A pattern that the acts no longer show retires, as any claim does (`memory.md` §6).
- **The Q6 use rule already bounds it.** An unconfirmed claim is weak evidence. It never closes a loop, and it never lowers a security label. A stale "he is up at 01:00" thus cannot make a real takeover look routine.
- **The profile reads it.** The durable part of the triage profile is a short summary of the strongest pattern claims.

Questions for the owner:

1. Is a pattern a claim, or a different kind of thing? A claim is true or false. A pattern is a rate or a habit. Does the check job's "keep, correct, retire" fit a habit?
2. Which acts count first? Each integration needs an actor mark before its acts can feed a pattern. Which ones matter most: sent mail, GitHub, calendar, chat, or the sign-ins and purchases that mail reports?
3. What is the worst error of a pattern? The candidate: a stale or wrong pattern makes a real event look routine.
4. Does the user see his patterns? The profile is visible. The journal is internal.
5. Where do proposals come from (P15)? A pattern that recurs, such as "he files every invoice", could become an offer of a workflow. Is that in scope now, or later?

## 6. Owner direction (2026-11-14, first pass)

The owner answered part of section 5. This is direction, not a settled theory page.

- **A pattern is not a structure.** No fixed series of steps finds a habit or says that a matter is closed. A habit is how often something happens against when it is expected to happen, and the case decides what is relevant. The model comprehends this from the evidence. Thus the candidate of section 5 (a pattern as a stored claim) is not chosen. It stays open as a cache, at most.
- **The foundation is that the model knows what it can find out.** With Code Mode the model can already count, order, and compare acts in the raw record. The hard part is that it knows this is possible, and knows where the evidence is. This links to the parked self-awareness item of [memory.md §9](../theory/memory.md#9-not-settled).
- **The reach of each source is part of that knowledge.** Integration activity starts when the user connects. Mail is the exception: Gmail holds the user's mail from long before sign-in, so a pattern in mail can reach back years. These edges must be stated where the model reads them, in the prompt or in the Code Mode surface, unless the model finds them by itself.
- **A habit can be chosen or imposed.** Some habits are what the user wants to do. Others happen outside his control, for example a bank that sends an OTP at each login. The model weighs which kind a habit is.
- **The user does not see his patterns.** Alfred tells the user only when something is pressing or strange, and the model judges that. *(The owner's sentence on this point was cut off. Confirm the rest.)*
- **The raw record exists.** The owner's view: every integration already records its deliveries in `event_receipts`. Checked against the code on 2026-11-14:
  - True for each webhook source and each Gmail push. Raw kinds are kept too (ADR-0097).
  - A Gmail receipt holds no body. The mail itself is in `documents`.
  - A webhook body is released after 90 days (`RECEIPT_PAYLOAD_RETENTION_MS`). The dedup key and the delivery time stay.
  - No row marks its actor. Thus "did the user do this" (Q-A) is a model judgment over the raw record today, not a column.

**What this changes in section 4.** Q-B is not a store to build. It is a capability: the model reads the raw record at the time of a judgment, through the gather. The foundation to settle is the **evidence map**. It says which stores exist, how far back each reaches, and what each can answer. Each feature that gathers reads the same map.

Open for the next grill:

1. Where does the evidence map live: in each prompt that gathers, in the Code Mode type declarations, or in both?
2. Is a stable pattern worth a cache in the durable profile, so the cheap first call can read it? Or does the first call do without it?
3. What makes something "strange" enough to tell the user, and which surface carries it before a push surface exists?

## 7. How to use this table

- A new probe either fits a group, or it shows a missing group. Add each new production fault here as a row before you design a fix.
- Settle a foundation when two or more features need it. Build it through one probe end to end. For Q-A and Q-B the first probe is P1, the A56 case.
- A question that only one feature asks stays in that feature's page.
