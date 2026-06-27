---
name: handoff
description: Write a chronological handoff doc to .handoff/ capturing findings, evidence, current state and next steps so work can continue in a fresh context window — then distill any durable lessons into .lessons/. Use at session end or when the user says /handoff.
user-invokable: true
args:
  - name: focus
    description: Optional focus / what the handoff is about. If omitted, infer from the session.
    required: false
---

Produce a handoff doc so a fresh context window can resume this work, then distill the durable lessons so the next session doesn't relearn them.

The handoff is **raw ore** (verbose, chronological, ephemeral). The lessons are the **refined metal** (terse, durable, indexed). Both come out of this command.

## Part 1 — Write the handoff doc

1. **Recover prior context first — the chronological progression must span context windows, not just the current one.** This window may be a continuation: the real findings and evidence may live in an earlier handoff or a compacted/earlier session.
   - Check `.handoff/` for the most recent handoff(s) (`ls -t .handoff/`). If one covers the same thread of work, read it and **carry its progression forward** — the new doc should continue the chronological story, not restart it. Either append a new dated entry that explicitly references and builds on the prior one, or, if the prior handoff is very recent and on the same topic, write to (extend) that file rather than fragmenting the context across many stubs.
   - If the current window has little or no visible discussion (e.g. context was compacted, or you were just invoked), reconstruct the progression from past sessions: `sessions recent` and `sessions search "<keywords>"` (and `codex-sessions` for Codex work). Pull the findings and evidence from there so nothing is lost across the boundary.
   - Goal: one continuous, evidence-backed narrative a fresh window can resume from — no gaps where context silently dropped between windows.

2. Get the timestamp: run `date -u +%Y-%m-%dT%H%M%SZ`.

3. Write `.handoff/<timestamp>.md` (or extend the prior handoff per step 1) capturing the **full chronological progression** — including everything carried forward from prior handoffs/sessions, not only what happened in this window — with these sections:
   - **Goal** — what we set out to do.
   - **Progression** — what was tried, in order, with the evidence: commands run, errors hit, what worked and what didn't. This is the part that prevents the next window from re-walking dead ends — keep the evidence (stack traces, key output, file:line refs).
   - **Current state** — what's true right now: what's done, what's in flight, what's broken, branch/uncommitted changes.
   - **Next steps** — the concrete next actions to resume.
   - **Open questions** — anything unresolved or needing a decision.

   Verbose is fine here — this file is disposable and is NOT loaded into future sessions automatically. To resume, the user `@`-mentions or pastes it into the new window.

## Part 2 — Distill the lessons (the part that compounds)

This is the reliable capture trigger: the cost was just paid and the evidence is all above.

4. Review the progression and ask: **what 1–3 things, had we known them at the start, would have saved this session?**

5. For each that clears the `/learn` bar (non-obvious AND costly AND repeatable), capture it following the **`/learn` capture format** — dedup against `.lessons/INDEX.md` first (update an existing lesson rather than duplicating), write `.lessons/<slug>.md`, and add its one-line hook to the index. Do not let verbose handoff content leak into a lesson or the index — distill it down.

   If nothing clears the bar, say so — not every session yields a durable lesson.

6. Report: the handoff path, and which lessons were written/updated (or that none qualified).
