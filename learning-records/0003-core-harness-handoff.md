# Core harness handoff is understood

The learner can now narrate the happy path as queue notification → worker lease → one model inference → successful durable commit, and understands that the harness completes only after inspecting the model outcome. Future lessons can assume this backbone and focus on prompt assembly, with one correction retained: `chat-turn` uses a roughly four-minute stale window rather than the default one minute.

**Evidence:** Reconstructed the Case 1 execution path in their own words and correctly located prompt-cache decoration before inference.
