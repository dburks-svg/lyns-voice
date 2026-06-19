# Vendored third-party assets

These files are committed so the avatar runs 100% locally (no runtime CDN fetch).

## three.min.js, GLTFLoader.js

Three.js r128 (https://threejs.org), MIT License. Copied from the pinned
`three@0.128.0` npm package by `scripts/vendor-three.mjs`:
- `three.min.js` from `three/build/three.min.js` (UMD, global `THREE`).
- `GLTFLoader.js` from `three/examples/js/loaders/GLTFLoader.js` (augments `THREE`).

## head.glb

The default avatar head mesh. Currently the "Lee Perry-Smith" head scan
(`LeePerrySmith.glb`) from the Three.js example assets.

- Author: Lee Perry-Smith / Infinite Realities (https://ir-ltd.net).
- License: Creative Commons Attribution 3.0 (CC-BY 3.0).
- Source: https://github.com/mrdoob/three.js (examples/models/gltf/LeePerrySmith).
- Stats: single mesh, ~9,279 vertices, vertex normals present, no Draco.

This is a realistic head used as a proven default for the loader pipeline. It is
swappable at runtime via the `headUrl` config field, so it can be replaced with a
CC0 / featureless mannequin head, or any uncompressed (non-Draco) GLB whose first
mesh carries POSITION (and ideally NORMAL) attributes, without code changes.
