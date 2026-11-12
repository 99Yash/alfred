# Journal: remember what we talked about, and connect it to what happens later

This page is the theory of the journal. It says what the journal must do, what counts as an error, and the shape of each part. The owner settled its shape on 2026-11-11 and 2026-11-12. Section 9 names what is still open.

Last verified: 2026-11-12.

Read first: [memory.md](./memory.md) (claims and name links) and the principles in [README.md](./README.md#2-the-principles). The journal is not claim memory, and it is not a loop (ADR-0122). Section 6 says how the three meet.

---

## 1. The job

**Alfred remembers what the user talked about with it, and it sees when something that happens later is related.** Then it says so, in a short remark or a question.

Two examples from the owner:

- **The MacBook (Muse, 2026-11-02).** The user asks Alfred to compare a MacBook Air and a Mac mini. Days later, Apple says that iCloud signed in on a MacBook Air, and Wise says that a card was added to Apple Pay on it. Alfred asks: "iCloud signed in on a MacBook Air, and a card went into Apple Pay on it. Was that you? If it was, it looks like you chose the Air."
- **The fashion college.** The user asks for the top fashion technology colleges and gives no reason. Months later, a mail says that a family member got a place at NIFT. Alfred asks: "Was the college search in November for this?"

**These are small things, but the user remembers them.** A personal assistant that recalls a past talk and connects it to a new event feels like it knows the user.

**The link exists only when both pieces are in front of one mind.** At the time of the chat, nothing says "this is for a family member". The later mail does not share a name with the chat. Thus no structure that Alfred extracts at write time can make the link. The model makes it when it reads both pieces. The design question is how to put both pieces in front of the model at the same time, and what code must check when Alfred speaks.

**The worst errors**, in order:

1. Alfred states a wrong link as a fact. The worst form makes a security notice look safe: "you chose the Air" for a sign-in that was not the user.
2. Alfred invents a past talk that did not occur.
3. Alfred misses a matter that the user asked it to watch. This is a broken promise, not a lost delight.
4. Alfred speaks too often, and the remarks become noise.
5. Alfred misses a link that it would have found by itself. This is the cheapest error, because the user loses only a small delight.

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
- **The lookout** (optional): what would move the matter forward, in the model's words. Example: "a refund, a reply from Acme support, a chargeback notice from the bank, a ticket status change". An entry about a matter that is not open has no lookout.
- **Asked or noticed.** The entry records whether the user asked Alfred to watch the matter ("keep an eye on this"), or whether the model noticed it. This changes the rules for its lookout (section 6).
- **Links to the chat turns** that the entry comes from. At least one link is to a user turn. No entry exists without them.
- **The life of the lookout:** 90 days from the last time that the user mentioned the matter, or from the last hit (owner decision, 2026-11-11). After that, the lookout is not matched, but the entry stays for recall. An asked lookout does not end in silence: before its end, Alfred asks the user if it must keep watching.

**The entry stores no exact keys.** The pass that reads it is a Code Mode program (section 5). It reads the linked user turns, so it can search for an address, a domain, or a URL that the user's words name. Code does not copy those words into separate fields.

**A journal entry is a pointer to where to look. It is never evidence** (principle 5). A remark cites the chat turn, not the entry. A claim comes only from the user's own words.

**The journal is internal.** The user does not see it and does not manage it, because the job is that Alfred does the work. The owner reviews it in the database (section 8). The user can still say "forget that" in chat.

**Notes about other people have no extra limits** (owner decision, 2026-11-11). Alfred has one user, and the people in the user's life are part of what the user talks about.

## 4. Write: who writes an entry

- **Chat capture, after a response, with a debounce.** This is the capture pass of [memory.md](./memory.md#5-capture-how-claims-and-names-are-written). The same pass writes claims, name links, and journal entries. The model decides what is worth an entry.
- **The chat agent, during a turn.** The agent can write an entry with a tool, as Claude Code writes its memory. It uses the tool when the user asks ("keep an eye on this"), or when the intent is clear. When the user asks, the agent says in the same turn what it will watch for, so that the user knows the promise.
- **One rule for both writers:** code checks that each linked chat turn exists, and that at least one is a user turn.
- **A new mention renews the entry.** When the user talks about the same matter again, the writer updates the note and the lookout, links the new turns, and the life of the lookout starts again.

## 5. Read: two nets that catch a link

**Why the lookout exists.** A search of each new item against all past chats is the wrong direction: items are many, most are machine noise, and a threshold becomes a tuning rule. The lookout reverses the direction. The model writes, one time, what the future should look like, while the full talk is in front of it. People do the same (prospective memory): you remember to tell a friend something when you see the friend, not because you check each person you meet against everything you know. Open lookouts are few, perhaps 20 to 60 for one user. A lookout such as "a refund from Acme" is also much nearer to a refund mail than the chat about the dispute is.

1. **The pre-briefing pass.** A step of the briefing workflow that runs before the gather of each briefing, while the user is usually not active. It is a read-only Code Mode program (ADR-0124). It reads all that came in since the last pass, from every integration: mail, the activity record (ADR-0118), and changes of the state of things. For one user this is about 100 to 300 activity rows and 50 to 150 mails each day. The activity record holds acts and changes of state, not each delivery: forty CI webhooks on one branch are one change.
   - **Lookouts.** It matches the items against the open lookouts.
   - **Notes.** For each item, it searches the notes of all entries, including entries with no lookout or an ended lookout, and reads the nearest few. This catches the links that no lookout foresaw, as in the fashion-college example. The back-test sets how many it reads.
   - **Turns.** For each candidate, it reads the linked chat turns, and it can search the item for the words that the user used.
   - **Upkeep.** It merges entries about one matter, and it ends the lookouts whose life is over.
   - **Output.** It stays silent, or it writes remarks. The briefing carries them.
2. **Chat time.** At the start of a turn, the user's message is searched against the journal and the past chats. Then Alfred can say "you asked about this in November".

**No net runs within minutes of an item.** Remarks go to the briefing and to the next chat, so a faster match gives the user nothing. A fast net comes back when Alfred can send a message outside a turn (section 9).

## 6. Speak, and what happens after

**A remark.** A short sentence or a question, never an action. It quotes the past chat turn and the new item. Code checks that both quotes occur in the stored text.

**A remark on a security notice asks, and it never makes the notice look safe.** Triage owns the security label (ADR-0121). A remark does not change that label, and it does not move the item out of the place where the briefing shows security notices. The model gets the triage label with the item. The wording rule is an eval case, not a code check.

**Where.** In the briefing that the pass runs for, and in the next chat. Each remark is a stored record. The next chat reads the open remarks, so a reply in chat binds to its remark, also when the user saw the remark in the briefing. A remark counts as content, so a quiet morning with a remark still gets its briefing. A message that Alfred sends outside a turn is open (section 9).

**How often.** Silence is the default. At most 3 remarks each day (owner decision, 2026-11-11). When more links qualify, the pass sends the strongest. An asked lookout goes before a noticed one. The others wait for the next pass, and the model judges them again.

**The user's reply.**

- **Yes.** Chat capture writes a claim, for example "a family member of the user got a place at NIFT", and a name link if one is new. A "yes" does not state the claim in the user's words, so the claim is agent-concluded, and it cites the new item, the remark, and the reply ([memory.md](./memory.md#5-capture-how-claims-and-names-are-written)). The writer then ends the lookout, or it rewrites the lookout when the matter is still open.
- **No.** The entry records that the link is wrong, and Alfred does not make that link again.
- **"Forget that".** Alfred removes the entry, and recall no longer uses the turns that it links.

**A hand-off to the loops.** A recall can find the key of a thing, for example the URL of the Acme ticket in a mail. Then the recall writes a pointer to that thing (ADR-0122 decision 3c), and a loop verifies it from its own source. The journal joins by meaning when no key exists. The loops join by key, with a stronger proof.

## 7. What the model owns, and what code owns

| Question | Owner |
| --- | --- |
| Is this talk worth an entry? What would move it forward? | Model |
| Is this new item related to an entry? | Model |
| The words of the remark, and which links are the strongest | Model |
| Each entry links to a stored user turn | Code |
| Each remark quotes a stored chat turn and a stored new item | Code |
| At most 3 remarks each day, with asked lookouts first | Code |
| The life of a lookout (90 days), and a question before an asked lookout ends | Code |
| A remark never acts, and it never changes a triage label | Code |
| A claim from a "yes" is agent-concluded and cites the reply | Code |

## 8. How we know that it works

The owner reads the journal and the remark records in the database. A script prints a weekly report, as for memory ([memory.md](./memory.md#7-observability-how-memory-quality-is-measured-over-time)).

- **A back-test on the owner's history.** Embed the past chats, write entries and lookouts for them, and replay months of mail and activity through the pre-briefing pass. Count the links that it catches, and set how many notes it reads for each item.
- **A recall miss.** When the user names a link that Alfred did not make ("by the way, the Acme refund came"), that is a recall miss. Each one becomes an eval case, as `capture_miss` does for claims (principle 1). A miss on an asked lookout is the most important case.
- **The user's replies.** "Yes" and "no" are labels for each remark. A "no" is a false link.
- **A record of each remark:** the net that made it, the entry, the cited items, the reply, and whether the cap held it back.
- **Asked lookouts that ended with no hit.** The report lists them, so that the owner can see the promises that Alfred did not keep.

## 9. Not settled

- **Alfred speaks first, outside a turn.** It needs a push surface. Until it exists, remarks go to the briefing and to the next chat, and no fast net runs.
- **Other writers.** The user's own sent mail and acts can also open a matter ("I will send the documents next week"). Today only chat writes an entry.
- **How many notes the pre-briefing pass reads for each item.** The back-test sets it.

## 10. Theory state and code state

| Part | Theory | Code | The gap today |
| --- | --- | --- | --- |
| Past chats are searchable | Settled | Not built | Chat messages have no embeddings, and context search does not read them. |
| Journal entries with links and lookouts | Settled | Not built | No store exists. |
| Write from capture and from a chat tool | Settled | Not built | Chat capture discards its output (memory.md section 8). |
| Pre-briefing pass | Settled | Not built | No step runs before the gather. It needs Code Mode (ADR-0124, #535). |
| Chat-time recall | Settled | Not built | Depends on searchable chats. |
| Remark records, in the briefing and the next chat, and the handling of the reply | Settled | Not built | Chat cannot read briefings today. |
| Back-test, the recall-miss signal, and the weekly report | Settled | Not built | |

## 11. Order of work

1. Make past chats searchable, and add chat-time recall. This helps alone.
2. Journal entries, written by chat capture and by the chat tool.
3. The back-test on the owner's history.
4. The pre-briefing pass.
5. Remark records in the briefing and the next chat, and the handling of the reply.
