# Mission established: triage's "user standing" gap

The learner is doing staff-level design, not bug-fixing. The driving defect: triage assigns a *category* but never weighs the user's absolute standing relative to the sender (e.g. a LinkedIn junior job-seeker surfacing as `awaiting_reply` worth attention). The proposed source for the missing signal is the cold-start onboarding research.

Why it steers future sessions: every lesson should converge on the lens "what user-context does triage read?" The key, already-known fact is that triage consumes **sender-side, graph-derived** relationship signal (`observations.senderRelationship`, ADR-0059) but does **not** consume the cold-start brief / bio / facts (see memory `project_user_context_consumption_map.md`). The learner has expert codebase knowledge; teach terminology-forward and dense.

Implications: next sessions should (1) confirm by reading the cold-start brief schema what "standing" fields exist to plug in, then (2) move from as-is flow into design options for wiring that signal into the classifier prompt vs. a deterministic pre-filter.
