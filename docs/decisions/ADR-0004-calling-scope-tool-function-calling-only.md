# ADR-0004 — "Calling" scope: tool/function calling only


**Decision.** No voice mode, no phone calls. Just LLM tool/function calling via AI SDK.

**Why.** Voice and phone agents add real-time-audio infra (LiveKit/Pipecat/Vapi/Twilio) that's out of scope for V1 and not on the critical path for the dimension-style assistant pattern.

**Alternatives.** Voice mode (deferred — LiveKit Agents would be the path if revisited). Phone calling (deferred).
