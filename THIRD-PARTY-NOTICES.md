# Third-Party Notices

Q is distributed under the [MIT License](LICENSE). It builds on, bundles, and (at first run)
downloads third-party software and assets that remain under their own licenses. This file
aggregates those notices and attributions.

Every third-party component used by Q is under a permissive, MIT-compatible license
(MIT, Apache-2.0, BSD, ISC, Zlib, Unicode-3.0, CC0, the Unlicense, CC-BY-3.0, or MPL-2.0).
No GPL, LGPL-only, or AGPL code is included. Where a license requires that attribution or a
notice be preserved (CC-BY-3.0, Apache-2.0, MPL-2.0), the relevant entry below carries it.

This is a curated summary maintained by hand. For an exhaustive, machine-generated bill of
materials of every transitive dependency, see "Regenerating this list" at the end.

---

## 1. Bundled source and assets

These are committed in this repository and ship inside the app.

### Holographic orb (Three.js renderer) - MIT
- Component: `jarvis-ai-orb-web-animation`, vendored under `src/avatar/jarvisOrb/`
  (its renderer ported to Three.js r128).
- Author: cyber1443 (https://github.com/cyber1443/jarvis-ai-orb-web-animation)
- License: MIT. Full text: `src/avatar/jarvisOrb/LICENSE`
  (Copyright (c) 2026 cyber1443).

### Default head mesh, `head.glb` - CC-BY 3.0
- Component: `vendor/head.glb`, the default avatar head used by the legacy/demo renderers
  (swappable at runtime via the `headUrl` config field).
- Author: Lee Perry-Smith / Infinite Realities (https://ir-ltd.net)
- License: Creative Commons Attribution 3.0 (CC-BY 3.0),
  https://creativecommons.org/licenses/by/3.0/
- Source: the Three.js example assets
  (https://github.com/mrdoob/three.js, `examples/models/gltf/LeePerrySmith`).
- See also `vendor/NOTICE.md`. CC-BY 3.0 requires that this attribution be preserved in
  any redistribution.

---

## 2. Speech models and runtime fetched at first run

These are not committed to the repository. Q downloads them once on first use (over HTTPS,
size-capped, with SHA-256 verification where noted) into the app data directory. The exact
URLs and pinned checksums live in `src-tauri/src/stt.rs` and `src-tauri/src/kokoro.rs`.

### Whisper STT model (`ggml-base.en`) - MIT
- Speech-to-text model weights, downloaded from Hugging Face (`ggerganov/whisper.cpp`).
- Underlying model: OpenAI Whisper (MIT); GGML conversion by the whisper.cpp project (MIT).
- Verified by a pinned SHA-256 before use (see `stt.rs`).

### Kokoro-82M TTS model and voices - Apache-2.0
- Neural TTS model `model_fp16.onnx`, downloaded from
  `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX`.
- Vocabulary/config from `https://huggingface.co/hexgrad/Kokoro-82M`.
- Voice style packs (`voices/*.bin`) from the same `onnx-community` repository.
- Authors: hexgrad and the onnx-community contributors.
- License: Apache-2.0, https://www.apache.org/licenses/LICENSE-2.0
- The model file is verified by a pinned SHA-256 before use (see `kokoro.rs`).

### ONNX Runtime (prebuilt binary) - MIT
- The `ort` crate's `download-binaries` feature fetches a prebuilt ONNX Runtime at build
  time, which is linked into the app to run the Kokoro model.
- Component: ONNX Runtime by Microsoft (https://github.com/microsoft/onnxruntime), MIT.

---

## 3. Frontend dependencies (npm)

Runtime dependencies bundled into the webview by Vite:

| Package | License |
| --- | --- |
| `three` (0.128.0) | MIT |
| `@tauri-apps/api` | Apache-2.0 OR MIT |
| `@tauri-apps/plugin-dialog` | MIT OR Apache-2.0 |
| `@tauri-apps/plugin-notification` | MIT OR Apache-2.0 |
| `@xterm/xterm` | MIT |
| `@xterm/addon-fit` | MIT |

Build-time only (not redistributed in the installed app): `vite` (MIT), `vitest` (MIT),
`@playwright/test` (Apache-2.0), `eslint` (MIT), `typescript` (Apache-2.0),
`typescript-eslint` (MIT), `happy-dom` (MIT), and their transitive dependencies, all under
MIT or Apache-2.0.

---

## 4. Backend dependencies (Rust crates)

Direct dependencies (from `src-tauri/Cargo.toml`):

| Crate | License |
| --- | --- |
| `tauri`, `tauri-build`, `tauri-plugin-dialog`, `tauri-plugin-notification`, `tauri-plugin-log` | Apache-2.0 OR MIT |
| `serde`, `serde_json` | MIT OR Apache-2.0 |
| `tokio` | MIT |
| `reqwest` | MIT OR Apache-2.0 |
| `sha2` | MIT OR Apache-2.0 |
| `log` | MIT OR Apache-2.0 |
| `ort` (ONNX Runtime bindings) | MIT OR Apache-2.0 |
| `misaki-rs` (grapheme-to-phoneme; `espeak` feature off) | MIT |
| `whisper-rs`, `whisper-rs-sys` | Unlicense (public domain) |
| `webrtc-vad` | MIT |
| `portable-pty` | MIT |
| `windows` (SAPI, Windows target) | MIT OR Apache-2.0 |

`misaki-rs` is built with `default-features = false` so its optional `espeak` (GPL) backend
is **not** compiled in; out-of-vocabulary words fall back to letter spelling. Keep this
feature off to preserve Q's permissive-only dependency tree.

### Transitive dependencies and license families

The full Rust dependency graph spans roughly 537 crates (across all target platforms; the
Windows build compiles a subset). Every one is under a permissive license. The distribution
is, by SPDX family: predominantly `MIT` and `Apache-2.0` (most dual-licensed), with smaller
numbers under `BSD-2-Clause` / `BSD-3-Clause`, `ISC`, `Zlib`, `Unicode-3.0`, `CC0-1.0`,
`BSL-1.0`, `CDLA-Permissive-2.0`, and `Unlicense`.

Components worth an explicit note:

- **MPL-2.0** (weak, file-level copyleft): `cssparser`, `cssparser-macros`, `dtoa-short`,
  `selectors`, `option-ext`. These are unmodified upstream crates pulled in transitively
  (the Servo CSS components via the webview, and `option-ext` via `dirs`). MPL-2.0 is
  compatible with distributing a larger MIT-licensed work; its only obligation is that the
  source of those specific files remain available under MPL-2.0 (it is, upstream) and that
  this notice is preserved. Full text: https://www.mozilla.org/MPL/2.0/
- **`r-efi`** is tri-licensed (`MIT OR Apache-2.0 OR LGPL-2.1-or-later`); Q uses it under
  MIT/Apache-2.0, not the LGPL option.
- **`whisper-rs` / `whisper-rs-sys`** are released into the public domain (Unlicense).

---

## 5. License texts

Full texts of the license families referenced above:

- MIT: this repository's `LICENSE`, or https://opensource.org/license/mit
- Apache-2.0: https://www.apache.org/licenses/LICENSE-2.0
- CC-BY-3.0: https://creativecommons.org/licenses/by/3.0/legalcode
- MPL-2.0: https://www.mozilla.org/MPL/2.0/
- BSD-2-Clause / BSD-3-Clause, ISC, Zlib, Unicode-3.0, CC0-1.0, BSL-1.0, Unlicense,
  CDLA-Permissive-2.0: see the corresponding SPDX identifier at https://spdx.org/licenses/

---

## 6. Regenerating this list

This file is a curated summary. To produce an exhaustive, per-package bill of materials for a
release artifact:

- Rust: `cargo install cargo-about` then `cargo about generate` (or `cargo install
  cargo-license` then `cargo license`) from `src-tauri/`.
- npm: `npx license-checker --production --summary` (and `--out` for the full table) from the
  repository root.

If dependencies change, regenerate and reconcile this file before tagging a release.
