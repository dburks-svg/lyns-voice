# Gating spikes

Two upgrade items carry real technical risk. The build is designed so the SAFE
default ships regardless, and each spike only decides whether an opt-in
enhancement is turned on. This keeps every phase shippable without a browser.

## Spike A - bloom vs transparent canvas (gates the Phase 6 bloom option)

Question: at Three.js r128, does an EffectComposer + UnrealBloomPass chain
preserve the overlay's transparent clear (`setClearColor(0x000000, 0)`) so the
host page still shows through?

- **Outcome: FAILED (resolved 2026-06-19), halo shell shipped instead.** Tested in
  real headless Chromium (Playwright element screenshots of the canvas over a
  magenta backdrop, using the alpha-safe pass chain: `RenderPass.clearAlpha=0`,
  `UnrealBloomPass.renderToScreen=false`, final `ShaderPass(CopyShader)` to screen).
  With bloom ON the canvas turned OPAQUE BLACK (the backdrop stopped showing
  through); with bloom OFF the backdrop showed through cleanly. r128's
  postprocessing assumes an opaque screen clear, so EffectComposer bloom cannot be
  the transparent-overlay glow. The bloom experiment was reverted.
- **Shipped instead: the halo shell.** A slightly enlarged BackSide additive
  fresnel shell around the head (`HALO_FRAGMENT_SHADER` + `Avatar.syncHalo`) gives a
  soft volumetric rim glow and, being ordinary geometry, preserves transparency
  (verified: head glows, magenta backdrop still shows through). Combined with the
  existing fresnel + CSS drop-shadow it matches the reference look.

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
