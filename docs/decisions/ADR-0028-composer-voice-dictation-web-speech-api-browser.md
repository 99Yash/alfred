# ADR-0028 — Composer voice dictation: Web Speech API, browser-native, no server round-trip


**Decision.** When the composer mic button activates (post-m13), it uses the browser's `SpeechRecognition` API to stream interim transcripts directly into the textarea. No server-side STT, no audio bytes leave the device. Falls back to a disabled state with a tooltip on browsers without support (mainly Firefox desktop today).

**Why.**

- **Zero new infra.** No Whisper API call, no audio upload pipeline, no per-minute STT cost line in the cost-metering table. The browser does the recognition; we only see text.
- **Privacy posture stays consistent with single-user scope (ADR-0001).** Audio never traverses our server. The dictated text enters the existing composer path and is treated identically to typed input.
- **Distinct from ADR-0004's "no voice mode."** ADR-0004 rules out audio-in audio-out conversational voice (LiveKit-class infra). Dictation is a keyboard alternative — speech → text inserted into a text field the user can edit before sending. The two are unrelated capabilities; ADR-0004 doesn't preclude this.
- **Good-enough quality for personal use.** Chromium and Safari ship usable English STT for free; the user is the only target audience, so we don't need to engineer around accent/edge-case coverage.
- **Reversible.** If browser STT proves too lossy, swap the activation handler to call a `/api/stt` endpoint backed by Whisper/Deepgram — same UX, different transport. The composer doesn't care.

**Implementation sketch (when m13 lands the live chat surface).**

- `useSpeechRecognition()` hook in `apps/web/src/lib/` wrapping `window.SpeechRecognition || webkitSpeechRecognition`, surfacing `{ supported, listening, transcript, interim, start, stop, error }`.
- Mic button toggles `listening`. Interim results stream into the textarea as the user speaks; final segments commit on pause. User can edit before sending.
- Mobile: same API works on iOS Safari and Android Chrome. The `--keyboard-height` token from dimension's recon (ADR-0003 era) gives a hint about how to keep the composer above the IME, but no special handling needed for STT itself.
- Disabled state today (m12): the mic button renders with `disabled` + tooltip "Voice input — lands with m13". Keeps the chrome honest about what's wired.

**Alternatives.**

- (a) Whisper API on the server (rejected for v1 — adds STT cost line, audio upload, retry semantics; saves us nothing the browser can't do at single-user scale).
- (b) Local Whisper.cpp via WASM (rejected — ~50MB model download, cold-start cost; browser STT is faster and free).
- (c) No dictation at all (rejected — the composer mic icon is one of dimension's lifted patterns, and dictation is genuinely useful for longer-form prompts on mobile).

**Caveats.** Firefox desktop has no `SpeechRecognition` (Mozilla parked the spec). The fallback is "button disabled with tooltip" — acceptable for a personal tool where the user picks the browser. Chromium's STT also has a soft cap on session length (~60s) before it auto-stops; the hook should auto-restart on `end` if `listening` is still true.
