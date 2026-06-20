/**
 * Adapter: drives the vendored MIT Jarvis orb (src/avatar/jarvisOrb, a
 * self-contained Three.js renderer) through our `ControllableAvatar` seam, so the
 * four-state machine, mood, and the entire voice loop drive it with ZERO changes.
 * It is a drop-in for the `avatarFactory` in `tauriAdapter` (same surface the SVG
 * `HoloOrb` exposed).
 *
 * The orb is STATE-target driven (it eases toward a `JarvisStateTarget`) and
 * exposes a live `setIntensityOverride` (energy) + `pulse`. Our `AvatarController`
 * pushes continuous scalars (`params.amplitude` / `params.speed`, glow). We bridge
 * them: `params.speed` is constant per state (idle 0.5 / listening 0.9 / speaking
 * 1.2 / thinking 2.5), so we map it to the matching orb state target (set only on
 * change, to avoid the renderer's per-call pulse), and feed `params.amplitude`
 * (which already folds in the mic level and word-boundary impulses) as the live
 * energy override every frame. Result: the core swells with the voice, thinking
 * spins up, speaking flares -- all from the existing controller output.
 */

import { createRenderer, type Renderer } from './jarvisOrb/renderer';
import { SIZE_PRESETS, type JarvisStateTarget, type JarvisSizePreset } from './jarvisOrb/states';
import type { AvatarOptions } from './Avatar';
import type { DeformationParams } from './deformation';

type Activity = 'idle' | 'listening' | 'thinking' | 'speaking';

/**
 * Orb state targets for our four activity states (energy is overridden live).
 * Tuned BOLDER than the library defaults for full-window use: higher `bloom`
 * (drives halo size/opacity + ring brightness + inner-core glow), bigger
 * `coreScale`, fuller `ringSpread`, brighter `filamentOpacity`.
 */
const ORB_STATES: Record<Activity, JarvisStateTarget> = {
  idle: {
    energy: 0.9,
    rotationSpeed: 0.5,
    particleSpeed: 0.62,
    shellRadius: 1.0,
    ringSpread: 0.98,
    filamentOpacity: 0.52,
    coreScale: 1.06,
    bloom: 0.9,
  },
  listening: {
    energy: 1.2,
    rotationSpeed: 0.78,
    particleSpeed: 1.36,
    shellRadius: 1.08,
    ringSpread: 1.08,
    filamentOpacity: 0.74,
    coreScale: 1.18,
    bloom: 1.12,
  },
  thinking: {
    energy: 1.25,
    rotationSpeed: 1.42,
    particleSpeed: 1.32,
    shellRadius: 1.08,
    ringSpread: 1.1,
    filamentOpacity: 0.72,
    coreScale: 1.16,
    bloom: 1.12,
  },
  speaking: {
    energy: 1.35,
    rotationSpeed: 0.98,
    particleSpeed: 1.26,
    shellRadius: 1.12,
    ringSpread: 1.2,
    filamentOpacity: 0.82,
    coreScale: 1.28,
    bloom: 1.32,
  },
};

/** Full-window immersive preset: fill the frame, dense particles/filaments. */
const IMMERSIVE_PRESET: JarvisSizePreset = {
  ...SIZE_PRESETS.hero,
  sceneScale: 1.05,
  particleCount: 1000,
  filamentCount: 120,
  ringSegments: 200,
  dpr: 2,
  minDpr: 1.25,
};

/** params.speed (constant per state) -> activity. Thresholds sit between the values. */
function activityFromSpeed(speed: number): Activity {
  if (speed < 0.7) return 'idle';
  if (speed < 1.05) return 'listening';
  if (speed < 1.6) return 'speaking';
  return 'thinking';
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export class JarvisOrbAvatar {
  beforeRender: ((time: number) => void) | null = null;
  reducedMotion = false;
  readonly params: DeformationParams = { amplitude: 0.12, frequency: 1.1, speed: 0.5 };
  idleRotationSpeed = 0.15;

  /** Recorder the controller writes; the orb self-animates, so these are unused. */
  readonly mesh = {
    rotation: { x: 0, y: 0, z: 0 },
    scale: {
      x: 1,
      y: 1,
      z: 1,
      set(x: number, y: number, z: number): void {
        this.x = x;
        this.y = y;
        this.z = z;
      },
    },
  };

  readonly ready: Promise<void> = Promise.resolve();

  private readonly canvas: HTMLCanvasElement;
  private orb: Renderer | null = null;
  private container: HTMLElement | null = null;
  private rafId = 0;
  private startTimeMs: number | null = null;
  private activity: Activity | null = null;
  private disposed = false;

  constructor(_options: AvatarOptions = {}) {
    this.canvas = document.createElement('canvas');
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.display = 'block';
  }

  // --- ControllableAvatar -------------------------------------------------

  setParams(next: Partial<DeformationParams>): void {
    if (next.amplitude !== undefined) this.params.amplitude = next.amplitude;
    if (next.frequency !== undefined) this.params.frequency = next.frequency;
    if (next.speed !== undefined) this.params.speed = next.speed;
  }

  /** Glow is expressed through the orb's per-state bloom; kept for interface parity. */
  setGlow(_value: number): void {
    /* no-op: bloom comes from the orb state target */
  }

  /** Mood tinting (rim/core) is deferred; the orb keeps its cyan palette for now. */
  setColors(_rim: number, _core: number): void {
    /* no-op v1: cyan palette matches the target */
  }

  // --- Avatar lifecycle (used by attachTauri) -----------------------------

  mount(container: HTMLElement): void {
    this.container = container;
    container.appendChild(this.canvas);
    const dpr = clamp(window.devicePixelRatio || 1, IMMERSIVE_PRESET.minDpr, IMMERSIVE_PRESET.dpr);
    this.orb = createRenderer({
      canvas: this.canvas,
      preset: IMMERSIVE_PRESET,
      dpr,
      initialState: ORB_STATES.idle,
      initialPalette: 'cyan',
    });
    this.activity = 'idle';
  }

  resize(_width: number, _height: number): void {
    // The orb reads its canvas's own client size, which CSS sizes to the window.
    this.orb?.resize();
  }

  start(): void {
    if (this.rafId !== 0 || this.disposed) return;
    const loop = (nowMs: number): void => {
      this.rafId = requestAnimationFrame(loop);
      if (this.startTimeMs === null) this.startTimeMs = nowMs;
      // The controller's tick expects SECONDS; rAF hands us ms.
      this.beforeRender?.((nowMs - this.startTimeMs) / 1000);
      this.applyToOrb();
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.orb?.setPaused(true);
  }

  dispose(): void {
    this.disposed = true;
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.orb?.dispose();
    this.orb = null;
    if (this.container && this.canvas.parentNode === this.container) {
      this.container.removeChild(this.canvas);
    }
    this.container = null;
  }

  // --- Bridge -------------------------------------------------------------

  /** Push the controller's current scalars onto the orb (called after each tick). */
  private applyToOrb(): void {
    if (!this.orb) return;
    const next = activityFromSpeed(this.params.speed);
    if (next !== this.activity) {
      this.activity = next;
      this.orb.setState(this.calmed(ORB_STATES[next]));
    }
    // amplitude already folds in mic level (listening) + word impulses (speaking).
    const calm = this.reducedMotion ? 0.55 : 1;
    this.orb.setIntensityOverride(clamp(0.9 + this.params.amplitude * 1.2 * calm, 0.65, 2.0));
  }

  /** Gentle the rotation/particle motion when the user prefers reduced motion. */
  private calmed(target: JarvisStateTarget): JarvisStateTarget {
    if (!this.reducedMotion) return target;
    return {
      ...target,
      rotationSpeed: target.rotationSpeed * 0.4,
      particleSpeed: target.particleSpeed * 0.5,
      bloom: target.bloom * 0.85,
    };
  }
}
