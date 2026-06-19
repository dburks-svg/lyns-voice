/**
 * GLSL for the avatar's neon wireframe material.
 *
 * Vertex deformation (breathing/impulse) is computed on the CPU in
 * `Avatar.deform` so the displacement math stays unit-tested in TypeScript; the
 * shader only handles the look: a fresnel rim glow that mixes the deep blue and
 * neon cyan and scales with a `uGlow` uniform the state machine drives.
 */

export const AVATAR_VERTEX_SHADER = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;

  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-mvPosition.xyz);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

export const AVATAR_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  uniform vec3 uColorA; // neon cyan (rim)
  uniform vec3 uColorB; // deep blue (core)
  uniform float uGlow;  // emissive intensity, driven by avatar state
  uniform float uOpacity;

  varying vec3 vNormal;
  varying vec3 vView;

  void main() {
    float fresnel = pow(1.0 - max(dot(vNormal, vView), 0.0), 2.0);
    vec3 color = mix(uColorB, uColorA, fresnel);
    gl_FragColor = vec4(color * uGlow, uOpacity);
  }
`;
