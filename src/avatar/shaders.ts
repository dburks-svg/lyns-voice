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

/**
 * Solid glowing head material (the 'head' skin). Unlike the additive wireframe
 * orb, this renders an opaque, depth-writing surface so the head has a real
 * silhouette. The look: an interior fill that brightens toward the camera plus a
 * bright fresnel rim (uColorA), so the head reads as a glowing form that glows
 * hottest at its edges. Shares the uColorA/uColorB/uGlow contract with the orb,
 * so the controller's setColors/setGlow drive both skins identically.
 */
export const HEAD_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  uniform vec3 uColorA; // rim (bright)
  uniform vec3 uColorB; // core (deep)
  uniform float uGlow;  // emissive intensity, driven by avatar state

  varying vec3 vNormal;
  varying vec3 vView;

  void main() {
    float facing = max(dot(vNormal, vView), 0.0);
    float fresnel = pow(1.0 - facing, 2.5);
    // Interior fill leans on the brighter rim color so the head stays visible,
    // and brightens toward the camera for a volumetric feel.
    vec3 interior = mix(uColorB, uColorA, 0.5) * (0.45 + 0.4 * facing);
    vec3 rim = uColorA * fresnel * 1.6;
    gl_FragColor = vec4((interior + rim) * uGlow, 1.0);
  }
`;
