# Journal: remember what we talked about, and connect it to what happens later

This page is the theory of the journal. It says what the journal must do, what counts as an error, and the shape of each part. The owner settled its shape on 2026-11-11. Section 9 names what is still open.

Last verified: 2026-11-11.

Read first: [memory.md](./memory.md) (claims and name links) and the principles in [README.md](./README.md#2-the-principles). The journal is not claim memory, and it is not a loop (ADR-0122). Section 6 says how the three meet.

---

## 1. The job

**Alfred remembers what the user talked about with it, and it sees when something that happens later is related.** Then it says so, in a short remark or a question.

Two examples from the owner:

- **The MacBook (Muse, 2026-11-02).** The user asks Alfred to compare a MacBook Air and a Mac mini. Days later, Apple says that iCloud signed in on a MacBook Air, and Wise says that a card was added to Apple Pay on it. Alfred says: "Looks like you went with the Air. Was that you?"
- **The fashion college.** The user asks for the top fashion technology colleges and gives no reason. Months later, a mail says that a family member got a place at NIFT. Alfred says: "Was the college search in November for this? Congratulations to her."

**These are small things, but the user remembers them.** A personal assistant that recalls a past talk and connects it to a new event feels like it knows the user.

**The link exists only when both pieces are in front of one mind.** At the time of the chat, nothing says "this is for a family member". The later mail does not share a name with the chat. Thus no structure that Alfred extracts at write time can make the link. The model makes it when it reads both pieces. The design question is how to put both pieces in front of the model at the same time, and what code must check when Alfred speaks.

**The worst errors**, in order:

1. Alfred states a wrong link as a fact.
2. Alfred invents a past talk that did not occur.
3. Alfred speaks too often, and the remarks become noise.
4. Alfred misses a link. This is the cheapest error, because the user loses only a small delight.

## 2. Why this is not claim memory and not a loop

| | Claim memory ([memory.md](./memory.md)) | Journal |
| --- | --- | --- |
| Holds | Statements that are true or false: "the user's GitHub login is 99Yash" | What the user and Alfred went through: "Yash looked at fashion colleges in November" |
| Used for | Acting on the right thing | Recall, and connecting the dots |
| Worst error | Alfred acts on the wrong thing | A wrong remark |
| Shape | Strict rows, checked each day | Prose that the model writes; code checks only what Alfred says |

A loop (ADR-0122) needs a thing with a source that owns it, for example a PR or a ticket. A matter from chat has no such source. Thus a matter from chat is a journal entry, not a loop. ADR-0122 decision 3d removes the condition target of a pointer for this reason.

## 3. The parts

**Past chats are searchable.** Each chat exchange (the user's message and Alfred's reply) is embedded and searchable. Today chat messages are stored, but they have no embeddings, and context search does not read them. Thus Alfred cannot recall a past talk outside its thread.

**A journal entry.** Prose that the model writes about something that the user talked about. It has no schema for its content. An entry holds:

- **The note:** what the talk was about, in the model's words. Example: "Yash is disputing a ₹4,200 charge with Acme."
- **The cue** (optional): what would move the matter forward, in the model's words. Example: "a refund, a reply from Acme support, a chargeback notice from the bank, a ticket status change". An entry about a matter that is not open has no cue.
- **Links to the chat turns** that the entry comes from. At least one link is to a user turn. No entry exists without them.
- **The life of the cue:** 90 days from the last time that the user mentioned the matter, or from the last hit (owner decision, 2026-11-11). After that, the entry stays for chat-time recall, but its cue is not matched.

**A journal entry is a pointer to where to look. It is never evidence** (principle 5). A remark cites the chat turn, not the entry. A claim comes only from the user's own words.

**Notes about other people have no extra limits** (owner decision, 2026-11-11). Alfred has one user, and the people in the user's life are part of what the user talks about.

## 4. Write: who writes an entry

- **Chat capture, after a response, with a debounce.** This is the capture pass of [memory.md](./memory.md#5-capture-how-claims-and-names-are-written). The same pass writes claims, name links, and journal entries. The model decides what is worth an entry.
- **The chat agent, during a turn.** The agent can write an entry with a tool, as Claude Code writes its memory. It uses the tool when the user asks ("keep an eye on this"), or when the intent is clear.
- **One rule for both writers:** code checks that each linked chat turn exists, and that at least one is a user turn.
- **A new mention renews the entry.** When the user talks about the same matter again, the writer updates the note and the cue, links the new turns, and the life of the cue starts again.

## 5. Read: three nets that catch a link

**Why the cue exists.** A search of each new event against all past chats is the wrong direction: events are many, most are machine noise, and a threshold becomes a tuning rule. The cue reverses the direction. The model writes, one time, what the future should look like, while the full talk is in front of it. People do the same (prospective memory): you remember to tell a friend something when you see the friend, not because you check each person you meet against everything you know. Open cues are few, perhaps 20 to 60 for one user. A cue such as "a refund from Acme" is also much nearer to a refund mail than the chat about the dispute is.

1. **The fast net (minutes).** Each new item is compared with the open cues: a mail, a row of the activity record (ADR-0118), or a change of the state of a thing. Mail is embedded at ingest already (`indexDocument`). An activity row gets a one-line text and an embedding. A comparison with a few dozen cue vectors costs no model call. Only a hit above the threshold calls a cheap model. The model reads the item, the entry, and the linked chat turns, and it stays silent or writes one remark.
2. **The slow net (daily).** The daily reflection pass reads the open entries and a digest of the day, one line for each item. It catches the links that no cue foresaw, as in the fashion-college example. The same pass merges entries about one matter, and it ends the cues whose life is over.
3. **Chat time.** At the start of a turn, the user's message is searched against the journal and the past chats. Then Alfred can say "you asked about this in November".

**The stream is smaller than the deliveries.** The activity record of ADR-0118 holds acts and changes of state, not each delivery. Forty CI webhooks on one branch are one change. For one user this is about 100 to 300 rows and 50 to 150 mails each day.

## 6. Speak, and what happens after

**A remark.** A short sentence or a question, never an action. It quotes the past chat turn and the new item. Code checks that both quotes occur in the stored text.

**Where.** First in the briefing and in the next chat. A message that Alfred sends outside a turn is open (section 9).

**How often.** Silence is the default. At most 3 remarks each day, across the three nets (owner decision, 2026-11-11).

**The user's reply.**

- **Yes.** Chat capture writes a claim from the user's words, for example "the user's cousin studies at NIFT", and a name link if one is new. The claim cites the user's reply.
- **No.** The entry records that the link is wrong, and Alfred does not make that link again.
- **"Forget that".** Alfred removes the entry, and recall no longer uses the turns that it links.

**A hand-off to the loops.** A recall can find the key of a thing, for example the URL of the Acme ticket in a mail. Then the recall writes a pointer to that thing (ADR-0122 decision 3c), and a loop verifies it from its own source. The journal joins by meaning when no key exists. The loops join by key, with a stronger proof.

## 7. What the model owns, and what code owns

| Question | Owner |
| --- | --- |
| Is this talk worth an entry? What would move it forward? | Model |
| Is this new item related to an entry? | Model |
| The words of the remark | Model |
| Each entry links to a stored user turn | Code |
| Each remark quotes a stored chat turn and a stored new item | Code |
| At most 3 remarks each day | Code |
| The life of a cue (90 days) | Code |
| A remark never acts | Code |
| A claim comes only from the user's own words | Code |

## 8. How we know that it works

- **A back-test on the owner's history.** Embed the past chats, write entries and cues for them, and replay months of mail and activity. Count the links that each net catches, and set the threshold of the fast net from the result.
- **A recall miss.** When the user names a link that Alfred did not make ("by the way, the Acme refund came"), that is a recall miss. Each one becomes an eval case, as `capture_miss` does for claims (principle 1).
- **The user's replies.** "Yes" and "no" are labels for each remark. A "no" is a false link.
- **A record of each remark:** the net that made it, the entry, the cited items, and the reply.

## 9. Not settled

- **Alfred speaks first, outside a turn.** It needs a push surface. The briefing and the next chat come first.
- **Other writers.** The user's own sent mail and acts can also open a matter ("I will send the documents next week"). Today only chat writes an entry.
- **The threshold of the fast net.** The back-test sets it.

## 10. Theory state and code state

| Part | Theory | Code | The gap today |
| --- | --- | --- | --- |
| Past chats are searchable | Settled | Not built | Chat messages have no embeddings, and context search does not read them. |
| Journal entries with links and cues | Settled | Not built | No store exists. |
| Write from capture and from a chat tool | Settled | Not built | Chat capture discards its output (memory.md section 8). |
| Fast net | Settled | Not built | Mail is embedded at ingest. Activity rows are not. |
| Slow net | Settled | Not built | No daily reflection pass exists. |
| Chat-time recall | Settled | Not built | Depends on searchable chats. |
| Remarks in the briefing and the next chat | Settled | Not built | |
| Back-test and the recall-miss signal | Settled | Not built | |

## 11. Order of work

1. Make past chats searchable, and add chat-time recall. This helps alone.
2. Journal entries, written by chat capture and by the chat tool.
3. The back-test on the owner's history. It sets the threshold.
4. The fast net.
5. The slow net.
6. Remarks in the briefing and the next chat, and the handling of the reply.
