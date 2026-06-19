import * as THREE from 'three';
import { DEFAULT_CONFIG } from '../config/config';
import { displacement, type DeformationParams } from './deformation';
import { AVATAR_FRAGMENT_SHADER, AVATAR_VERTEX_SHADER } from './shaders';

export type RendererFactory = (canvas: HTMLCanvasElement) => THREE.WebGLRenderer;

export interface AvatarOptions {
  /** Mesh radius in world units. */
  radius?: number;
  /** Icosahedron subdivision level (higher = smoother, more vertices). */
  detail?: number;
  /** Neon rim color (hex). */
  colorA?: number;
  /** Deep core color (hex). */
  colorB?: number;
  /**
   * Inject the WebGL renderer. Tests pass a mock so no real GL context is
   * created; production uses the default factory.
   */
  rendererFactory?: RendererFactory;
}

/** Baseline idle breathing: gentle, slow, living-but-calm. Sourced from config. */
export const IDLE_PARAMS: DeformationParams = { ...DEFAULT_CONFIG.idle };

const DEFAULTS = {
  radius: DEFAULT_CONFIG.mesh.radius,
  detail: DEFAULT_CONFIG.mesh.detail,
  colorA: DEFAULT_CONFIG.palette.neonRim,
  colorB: DEFAULT_CONFIG.palette.listeningCore,
  rotationSpeed: DEFAULT_CONFIG.rotation.idle,
};

function defaultRendererFactory(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setClearColor(0x000000, 0);
  return renderer;
}

/**
 * The 3D avatar: a neon wireframe icosahedron that breathes via per-frame,
 * noise-driven vertex displacement. Rendering side effects (renderer, rAF) are
 * isolated so the geometry/deformation behaviour can be unit-tested with a
 * mocked renderer.
 */
export class Avatar {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly geometry: THREE.IcosahedronGeometry;
  readonly material: THREE.ShaderMaterial;
  readonly mesh: THREE.Mesh;

  /** Live deformation parameters; mutated by the state machine in Phase 3. */
  readonly params: DeformationParams = { ...IDLE_PARAMS };

  idleRotationSpeed = DEFAULTS.rotationSpeed;

  /**
   * Optional per-frame hook invoked at the start of `update`, before deform and
   * render. The state controller plugs in here so there is a single render loop.
   */
  beforeRender: ((time: number) => void) | null = null;

  private readonly canvas: HTMLCanvasElement;
  private readonly restPositions: Float32Array;
  private readonly restNormals: Float32Array;
  private readonly clock = new THREE.Clock();
  private rafId = 0;
  private container: HTMLElement | null = null;

  constructor(options: AvatarOptions = {}) {
    const radius = options.radius ?? DEFAULTS.radius;
    const detail = options.detail ?? DEFAULTS.detail;
    const colorA = options.colorA ?? DEFAULTS.colorA;
    const colorB = options.colorB ?? DEFAULTS.colorB;

    this.canvas = document.createElement('canvas');
    this.renderer = (options.rendererFactory ?? defaultRendererFactory)(this.canvas);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    this.camera.position.z = 4;

    this.geometry = new THREE.IcosahedronGeometry(radius, detail);
    this.restPositions = Float32Array.from(this.geometry.attributes.position.array);
    this.restNormals = Float32Array.from(this.geometry.attributes.normal.array);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uColorA: { value: new THREE.Color(colorA) },
        uColorB: { value: new THREE.Color(colorB) },
        uGlow: { value: 1.0 },
        uOpacity: { value: 0.9 },
      },
      vertexShader: AVATAR_VERTEX_SHADER,
      fragmentShader: AVATAR_FRAGMENT_SHADER,
      wireframe: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.scene.add(this.mesh);
  }

  /** Attach the canvas to the page and size it to the container. */
  mount(container: HTMLElement): void {
    this.container = container;
    container.appendChild(this.renderer.domElement);
    this.resize(container.clientWidth || 1, container.clientHeight || 1);
  }

  resize(width: number, height: number): void {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  /** Merge in new deformation parameters (state-driven). */
  setParams(next: Partial<DeformationParams>): void {
    Object.assign(this.params, next);
  }

  /** Set emissive glow intensity (state-driven). */
  setGlow(value: number): void {
    this.material.uniforms.uGlow.value = value;
  }

  /** Set the rim and core colors (state-driven tint; hex numbers). */
  setColors(rim: number, core: number): void {
    (this.material.uniforms.uColorA.value as THREE.Color).set(rim);
    (this.material.uniforms.uColorB.value as THREE.Color).set(core);
  }

  /**
   * Displace every vertex along its rest normal by the noise field at `time`.
   * With `params.amplitude === 0` the mesh returns to its exact rest shape.
   */
  deform(time: number): void {
    const attribute = this.geometry.attributes.position as THREE.BufferAttribute;
    const arr = attribute.array as Float32Array;
    const rest = this.restPositions;
    const norm = this.restNormals;
    for (let i = 0; i < arr.length; i += 3) {
      const rx = rest[i];
      const ry = rest[i + 1];
      const rz = rest[i + 2];
      const d = displacement(rx, ry, rz, time, this.params);
      arr[i] = rx + norm[i] * d;
      arr[i + 1] = ry + norm[i + 1] * d;
      arr[i + 2] = rz + norm[i + 2] * d;
    }
    attribute.needsUpdate = true;
  }

  /** Advance one frame: deform, rotate, render. */
  update(time: number): void {
    this.beforeRender?.(time);
    this.deform(time);
    this.mesh.rotation.y = time * this.idleRotationSpeed;
    this.renderer.render(this.scene, this.camera);
  }

  /** Begin the render loop (browser only). */
  start(): void {
    if (this.rafId !== 0) {
      return;
    }
    const loop = (): void => {
      this.rafId = requestAnimationFrame(loop);
      this.update(this.clock.getElapsedTime());
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  /** Release GPU resources and detach the canvas. */
  dispose(): void {
    this.stop();
    this.scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
    this.renderer.dispose();
    if (this.container && this.renderer.domElement.parentNode === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
    this.container = null;
  }
}
