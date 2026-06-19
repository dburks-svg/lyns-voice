# Gating spikes

Two upgrade items carry real technical risk. The build is designed so the SAFE
default ships regardless, and each spike only decides whether an opt-in
enhancement is turned on. This keeps every phase shippable without a browser.

## Spike A - bloom vs transparent canvas (gates the Phase 6 bloom option)

Question: at Three.js r128, does an EffectComposer + UnrealBloomPass chain
preserve the overlay's transparent clear (`setClearColor(0x000000, 0)`) so the
host page still shows through?

- Safe default (shipped now): glow comes from the in-shader fresnel rim plus the
  CSS drop-shadow on the canvas, with an optional scaled "halo" shell. Bloom is
  OFF.
- Confirmation: run in the real browser (Playwright + Chromium, or the live host)
  during Phase 6 / Phase 10, where a real WebGL context exists. happy-dom has no
  WebGL, so this cannot be confirmed in unit tests.
- Outcome: PENDING (defaulting to no-bloom until confirmed).

## Spike B - mood-tag reliability (gates the Phase 5 primary mood source)

Question: does the Claude Code session reliably emit a leading `<<mood:NAME>>` in
its spoken (`speak` tool) text, and does the `SpeechReactor` wrapper see and strip
it before TTS speaks it?

- Mechanism (unit-tested in Phase 5): `SpeechReactor` already receives
  `utterance.text` before calling the original `speak`, so a `transformText` hook
  can strip the tag on every browser-voice utterance. The parser is tolerant (tag
  anywhere in the first ~40 chars, case-insensitive, length-capped) and ALWAYS
  strips, so a stray tag is silent rather than spoken.
- Safe default: with zero tags the avatar stays `neutral` and nothing breaks
  (zero regression).
- Confirmation: a real voice session during Phase 10. Behavioral reliability of
  Claude emitting the tag is validated live; if unreliable, keep best-effort +
  neutral default and consider the deferred standalone `set_avatar_mood` helper
  (Phase 9), which is structurally reliable and needs no host fork.
- Outcome: PENDING (best-effort tag path is the shipped default).
