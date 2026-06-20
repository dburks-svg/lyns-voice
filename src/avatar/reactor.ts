/**
 * The `reactor` skin: a glowing arc-reactor / orbital core built procedurally
 * from Three.js primitives (concentric coplanar rings + tilted orbital ellipses
 * + a bright pulsing center). It is a self-contained `THREE.Group` that the
 * `Avatar` attaches as a child of its carrier mesh, so the controller's existing
 * `mesh.rotation`/`mesh.scale` writes transform the whole reactor for free and
 * `setColors`/`setGlow` fan out to its materials. No vertex deformation: the
 * states express through ring rotation, core scale, and emissive intensity, all
 * derived from the `DeformationParams`/glow the controller already feeds.
 */

import * as THREE from 'three';
import type { DeformationParams } from './deformation';
import {
  AVATAR_VERTEX_SHADER,
  REACTOR_CORE_FRAGMENT_SHADER,
  REACTOR_FRAGMENT_SHADER,
} from './shaders';

export interface ReactorOptions {
  /** Base radius in world units (the rings/core scale off this). */
  radius: number;
  /** Neon rim color (hex). */
  colorA: number;
  /** Deep core color (hex). */
  colorB: number;
}

export interface ReactorUpdateOptions {
  reducedMotion: boolean;
}

export interface ReactorHandle {
  readonly group: THREE.Group;
  readonly rings: THREE.Mesh[];
  readonly orbits: THREE.Mesh[];
  readonly core: THREE.Mesh;
  readonly ringMaterial: THREE.ShaderMaterial;
  readonly coreMaterial: THREE.ShaderMaterial;
  setColors(rim: number, core: number): void;
  setGlow(value: number): void;
  update(time: number, params: DeformationParams, glow: number, opts: ReactorUpdateOptions): void;
  dispose(): void;
}

// Concentric coplanar rings (fractions of radius): radius, tube thickness.
const RINGS: ReadonlyArray<readonly [number, number]> = [
  [0.45, 0.04],
  [0.7, 0.035],
  [0.95, 0.03],
];
// Tilted orbital ellipses: [rotX, rotY, rotZ] tilt + vertical squash (Y scale).
const ORBITS: ReadonlyArray<{ tilt: readonly [number, number, number]; squash: number }> = [
  { tilt: [1.15, 0, 0], squash: 0.62 },
  { tilt: [1.15, 2.1, 0], squash: 0.55 },
  { tilt: [-1.0, 0, 0.8], squash: 0.68 },
];
const ORBIT_RADIUS = 1.05;
const ORBIT_TUBE = 0.02;
const CORE_RADIUS = 0.22;
// Gentle the motion (not freeze) when the user prefers reduced motion.
const REDUCED_MOTION_FACTOR = 0.15;

export function buildReactor(opts: ReactorOptions): ReactorHandle {
  const { radius } = opts;
  const group = new THREE.Group();

  const makeMaterial = (fragmentShader: string): THREE.ShaderMaterial =>
    new THREE.ShaderMaterial({
      uniforms: {
        uColorA: { value: new THREE.Color(opts.colorA) },
        uColorB: { value: new THREE.Color(opts.colorB) },
        uGlow: { value: 1.0 },
        uOpacity: { value: 0.9 },
      },
      vertexShader: AVATAR_VERTEX_SHADER,
      fragmentShader,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

  // Rings + orbits share one material; the core is hotter.
  const ringMaterial = makeMaterial(REACTOR_FRAGMENT_SHADER);
  const coreMaterial = makeMaterial(REACTOR_CORE_FRAGMENT_SHADER);

  const rings: THREE.Mesh[] = RINGS.map(([r, tube]) => {
    const geometry = new THREE.TorusGeometry(r * radius, tube * radius, 8, 64);
    const mesh = new THREE.Mesh(geometry, ringMaterial);
    group.add(mesh);
    return mesh;
  });

  const orbits: THREE.Mesh[] = ORBITS.map(({ tilt, squash }) => {
    const geometry = new THREE.TorusGeometry(ORBIT_RADIUS * radius, ORBIT_TUBE * radius, 6, 48);
    const mesh = new THREE.Mesh(geometry, ringMaterial);
    mesh.scale.set(1, squash, 1);
    mesh.rotation.set(tilt[0], tilt[1], tilt[2]);
    group.add(mesh);
    return mesh;
  });

  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(CORE_RADIUS * radius, 1), coreMaterial);
  group.add(core);

  const setColors = (rim: number, coreColor: number): void => {
    (ringMaterial.uniforms.uColorA.value as THREE.Color).set(rim);
    (ringMaterial.uniforms.uColorB.value as THREE.Color).set(coreColor);
    (coreMaterial.uniforms.uColorA.value as THREE.Color).set(rim);
    (coreMaterial.uniforms.uColorB.value as THREE.Color).set(coreColor);
  };

  const setGlow = (value: number): void => {
    ringMaterial.uniforms.uGlow.value = value;
    coreMaterial.uniforms.uGlow.value = value;
  };

  let started = false;
  let lastTime = 0;

  const update = (
    time: number,
    params: DeformationParams,
    glow: number,
    u: ReactorUpdateOptions,
  ): void => {
    // dt-accumulated rotation so a per-state speed change does not jump the angle.
    const dt = started ? Math.max(0, Math.min(0.1, time - lastTime)) : 0;
    started = true;
    lastTime = time;
    const calm = u.reducedMotion ? REDUCED_MOTION_FACTOR : 1;
    const { amplitude, speed } = params;

    // Rings counter-rotate; the rate rises with the state's `speed` (so thinking,
    // with the highest speed, visibly spins).
    const ringRate = speed * 0.5 * calm;
    for (let i = 0; i < rings.length; i += 1) {
      rings[i].rotation.z += dt * ringRate * (i % 2 === 0 ? 1 : -1);
    }
    // Orbits precess about Y, a touch slower.
    const orbitRate = speed * 0.4 * calm;
    for (const orbit of orbits) {
      orbit.rotation.y += dt * orbitRate;
    }
    // The core breathes/pulses/flares with amplitude (the controller drives this
    // up on thinking pulses and speaking impulses).
    const pulse = 1 + amplitude * 0.8 * calm + 0.04 * calm * Math.sin(time * speed * Math.PI);
    core.scale.setScalar(pulse);

    // Emissive follows the controller glow; the core runs a touch hotter.
    ringMaterial.uniforms.uGlow.value = glow;
    coreMaterial.uniforms.uGlow.value = glow * 1.15;
  };

  const dispose = (): void => {
    for (const mesh of rings) {
      mesh.geometry.dispose();
    }
    for (const mesh of orbits) {
      mesh.geometry.dispose();
    }
    core.geometry.dispose();
    ringMaterial.dispose();
    coreMaterial.dispose();
  };

  return {
    group,
    rings,
    orbits,
    core,
    ringMaterial,
    coreMaterial,
    setColors,
    setGlow,
    update,
    dispose,
  };
}
