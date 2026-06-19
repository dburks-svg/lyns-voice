import * as THREE from 'three';
import { DEFAULT_CONFIG, type Skin } from '../config/config';
import { displacement, type DeformationParams } from './deformation';
import { loadHeadGeometry, type GLTFLoaderFactory } from './gltf';
import { AVATAR_FRAGMENT_SHADER, AVATAR_VERTEX_SHADER, HEAD_FRAGMENT_SHADER } from './shaders';

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
  /** 'orb' (default) renders the wireframe icosahedron; 'head' loads `headUrl`. */
  skin?: Skin;
  /** Relative URL of the head GLB (used when `skin` is 'head'). */
  headUrl?: string;
  /**
   * Injects the GLTF loader: the UMD global `THREE.GLTFLoader` in the bundle, the
   * ESM loader in the demo, a fake in tests. Without it, 'head' stays on the orb.
   */
  gltfLoaderFactory?: GLTFLoaderFactory;
  /** Scales deformation magnitude; head meshes use < 1 so they pulse, not melt. */
  amplitudeScale?: number;
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

/** Head meshes breathe at a fraction of the orb amplitude so they pulse, not melt. */
const HEAD_AMPLITUDE_SCALE = 0.3;

function defaultAmplitudeScale(skin: Skin): number {
  return skin === 'head' ? HEAD_AMPLITUDE_SCALE : DEFAULT_CONFIG.amplitudeScale;
}

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
  /** Widened to BufferGeometry so the head mesh can replace the orb at runtime. */
  geometry: THREE.BufferGeometry;
  /** Rebuilt on skin change: orb is wireframe+additive, head is solid+fresnel. */
  material: THREE.ShaderMaterial;
  readonly mesh: THREE.Mesh;
  /** The currently rendered skin ('orb' wireframe or 'head' solid). */
  skin: Skin;

  /** Live deformation parameters; mutated by the state machine in Phase 3. */
  readonly params: DeformationParams = { ...IDLE_PARAMS };

  idleRotationSpeed = DEFAULTS.rotationSpeed;

  /** Multiplier on deformation magnitude (head meshes scale this down). */
  amplitudeScale: number;

  /**
   * Resolves when the requested skin is ready: immediately for the orb, or after
   * the head GLB has loaded and been adopted. A head-load failure still resolves
   * (the orb is kept), so awaiting `ready` never rejects.
   */
  readonly ready: Promise<void>;

  /**
   * Optional per-frame hook invoked at the start of `update`, before deform and
   * render. The state controller plugs in here so there is a single render loop.
   */
  beforeRender: ((time: number) => void) | null = null;

  private readonly canvas: HTMLCanvasElement;
  private restPositions: Float32Array;
  private restNormals: Float32Array;
  private readonly clock = new THREE.Clock();
  private rafId = 0;
  private container: HTMLElement | null = null;
  private readonly radius: number;
  private readonly detail: number;
  private readonly colorA: number;
  private readonly colorB: number;
  private readonly headUrl: string;
  private readonly gltfLoaderFactory: GLTFLoaderFactory | undefined;

  constructor(options: AvatarOptions = {}) {
    this.radius = options.radius ?? DEFAULTS.radius;
    this.detail = options.detail ?? DEFAULTS.detail;
    this.colorA = options.colorA ?? DEFAULTS.colorA;
    this.colorB = options.colorB ?? DEFAULTS.colorB;
    this.headUrl = options.headUrl ?? DEFAULT_CONFIG.headUrl;
    this.gltfLoaderFactory = options.gltfLoaderFactory;
    this.skin = options.skin ?? DEFAULT_CONFIG.skin;
    this.amplitudeScale = options.amplitudeScale ?? defaultAmplitudeScale(this.skin);

    this.canvas = document.createElement('canvas');
    this.renderer = (options.rendererFactory ?? defaultRendererFactory)(this.canvas);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    this.camera.position.z = 4;

    // The orb geometry is the instant fallback for both skins; a 'head' skin
    // swaps in the loaded GLB when ready.
    this.geometry = new THREE.IcosahedronGeometry(this.radius, this.detail);
    this.restPositions = Float32Array.from(this.geometry.attributes.position.array);
    this.restNormals = Float32Array.from(this.geometry.attributes.normal.array);

    this.material = this.buildMaterial(this.skin);
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.scene.add(this.mesh);

    // A 'head' skin loads its GLB and atomically adopts it when ready. A load
    // failure keeps the fallback geometry (graceful), so `ready` never rejects.
    if (this.skin === 'head' && this.gltfLoaderFactory) {
      this.ready = this.loadHead().catch((err: unknown) => {
        console.warn('[avatar] head model failed to load; keeping orb', err);
      });
    } else {
      this.ready = Promise.resolve();
    }
  }

  /** Build the ShaderMaterial for a skin (orb: wireframe additive; head: solid). */
  private buildMaterial(skin: Skin): THREE.ShaderMaterial {
    const uniforms = {
      uColorA: { value: new THREE.Color(this.colorA) },
      uColorB: { value: new THREE.Color(this.colorB) },
      uGlow: { value: 1.0 },
      uOpacity: { value: 0.9 },
    };
    if (skin === 'head') {
      return new THREE.ShaderMaterial({
        uniforms,
        vertexShader: AVATAR_VERTEX_SHADER,
        fragmentShader: HEAD_FRAGMENT_SHADER,
        wireframe: false,
        transparent: false,
        depthWrite: true,
        side: THREE.FrontSide,
      });
    }
    return new THREE.ShaderMaterial({
      uniforms,
      vertexShader: AVATAR_VERTEX_SHADER,
      fragmentShader: AVATAR_FRAGMENT_SHADER,
      wireframe: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
  }

  private loadHead(): Promise<void> {
    if (!this.gltfLoaderFactory) {
      return Promise.resolve();
    }
    return loadHeadGeometry({
      url: this.headUrl,
      loaderFactory: this.gltfLoaderFactory,
      targetRadius: this.radius,
    }).then((geometry) => this.adoptGeometry(geometry));
  }

  /**
   * Switch skins at runtime (used by the demo toggle). Rebuilds the material and
   * swaps geometry: 'orb' rebuilds the icosahedron; 'head' reloads the GLB.
   * Resolves when the new skin is ready.
   */
  setSkin(next: Skin): Promise<void> {
    if (next === this.skin) {
      return Promise.resolve();
    }
    this.skin = next;
    const previousMaterial = this.material;
    this.material = this.buildMaterial(next);
    this.mesh.material = this.material;
    previousMaterial.dispose();
    this.amplitudeScale = defaultAmplitudeScale(next);
    if (next === 'head') {
      return this.loadHead().catch((err: unknown) => {
        console.warn('[avatar] head model failed to load; keeping current geometry', err);
      });
    }
    this.adoptGeometry(new THREE.IcosahedronGeometry(this.radius, this.detail));
    return Promise.resolve();
  }

  /**
   * Atomically replace the rendered geometry and its captured rest shape. Invoked
   * from the head-load promise (a microtask, outside `update`/`deform`), so it
   * never interleaves with a deform pass. Disposes the geometry it replaces.
   */
  private adoptGeometry(next: THREE.BufferGeometry): void {
    if (!next.getAttribute('normal')) {
      next.computeVertexNormals();
    }
    const previous = this.geometry;
    const position = next.getAttribute('position');
    const normal = next.getAttribute('normal');
    this.restPositions = Float32Array.from(position.array as Float32Array);
    this.restNormals = Float32Array.from(normal.array as Float32Array);
    this.geometry = next;
    this.mesh.geometry = next;
    if (previous !== next) {
      previous.dispose();
    }
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
      const d = displacement(rx, ry, rz, time, this.params) * this.amplitudeScale;
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
