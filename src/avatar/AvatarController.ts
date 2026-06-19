import { IDLE_PARAMS } from './Avatar';
import type { DeformationParams } from './deformation';

export type AvatarState = 'idle' | 'listening' | 'thinking' | 'speaking';

/**
 * Minimal surface the controller drives. The real `Avatar` satisfies this
 * structurally, and tests pass a lightweight fake so the state logic can be
 * verified without WebGL.
 */
export interface ControllableAvatar {
  setParams(next: Partial<DeformationParams>): void;
  setGlow(value: number): void;
  setColors(rim: number, core: number): void;
  idleRotationSpeed: number;
  readonly mesh: {
    rotation: { x: number; y: number; z: number };
    scale: { set(x: number, y: number, z: number): void };
  };
}

export interface AvatarControllerOptions {
  avatar: ControllableAvatar;
  onStateChange?: (state: AvatarState) => void;
}

// Time for a speaking impulse to decay back to rest (seconds).
const IMPULSE_DECAY_SECONDS = 0.32;
// Thinking pulse rate (radians/sec) for the rapid processing throb.
const THINKING_PULSE_RATE = 7.5;

// Per-state color palette (rim, core). Idle trends to the spec's "dark
// navy/slate blue spectrum"; active states brighten to neon cyan/blue.
const COLORS = {
  idleRim: 0x3a5f8f,
  idleCore: 0x0a1530,
  neonRim: 0x00f0ff,
  listeningCore: 0x0077ff,
  thinkingRim: 0x33e0ff,
  thinkingCore: 0x0088ff,
  speakingCore: 0x00a0ff,
} as const;

/**
 * Translates the four behavioural states (AVATAR_SPEC section 4) into live
 * avatar parameters every frame:
 *
 *  - idle:      slow ambient breathing + rotation, baseline glow
 *  - listening: amplitude/compression driven by live mic level
 *  - thinking:  rapid pulsing + fast orbital rotation
 *  - speaking:  word-boundary impulses + intense bright-blue glow
 */
export class AvatarController {
  private readonly avatar: ControllableAvatar;
  private readonly onStateChange?: (state: AvatarState) => void;

  private state: AvatarState = 'idle';
  private micLevel = 0;
  private impulse = 0;
  private lastTime: number | null = null;

  constructor(options: AvatarControllerOptions) {
    this.avatar = options.avatar;
    this.onStateChange = options.onStateChange;
  }

  get current(): AvatarState {
    return this.state;
  }

  setState(state: AvatarState): void {
    if (state === this.state) {
      return;
    }
    this.state = state;
    if (state !== 'speaking') {
      this.impulse = 0;
    }
    this.onStateChange?.(state);
  }

  /** Live microphone level in [0, 1], fed by the mic analyser. */
  setMicLevel(level: number): void {
    this.micLevel = clamp01(level);
  }

  /** Register a speech word-boundary impulse (or synthetic envelope tick). */
  pulse(strength = 1): void {
    this.impulse = Math.min(1, this.impulse + clamp01(strength));
  }

  /** Per-frame update; `time` is elapsed seconds. */
  tick(time: number): void {
    const dt = this.lastTime === null ? 0 : Math.max(0, time - this.lastTime);
    this.lastTime = time;
    this.impulse = Math.max(0, this.impulse - dt / IMPULSE_DECAY_SECONDS);

    switch (this.state) {
      case 'idle':
        this.applyIdle();
        break;
      case 'listening':
        this.applyListening();
        break;
      case 'thinking':
        this.applyThinking(time);
        break;
      case 'speaking':
        this.applySpeaking();
        break;
    }
  }

  private applyIdle(): void {
    this.avatar.setParams(IDLE_PARAMS);
    this.avatar.setGlow(1.0);
    this.avatar.setColors(COLORS.idleRim, COLORS.idleCore);
    this.avatar.idleRotationSpeed = 0.15;
    this.avatar.mesh.rotation.x = 0;
    this.avatar.mesh.scale.set(1, 1, 1);
  }

  private applyListening(): void {
    const level = this.micLevel;
    this.avatar.setParams({ amplitude: 0.05 + level * 0.5, frequency: 1.4, speed: 0.9 });
    this.avatar.setGlow(1.2 + level * 0.8);
    this.avatar.setColors(COLORS.neonRim, COLORS.listeningCore);
    this.avatar.idleRotationSpeed = 0.1;
    this.avatar.mesh.rotation.x = 0;
    // Vertical compression conveys live audio feedback (spec: "compresses vertically").
    this.avatar.mesh.scale.set(1, 1 - level * 0.35, 1);
  }

  private applyThinking(time: number): void {
    const pulse = 0.5 + 0.5 * Math.sin(time * THINKING_PULSE_RATE);
    this.avatar.setParams({ amplitude: 0.1 + pulse * 0.25, frequency: 2.0, speed: 2.5 });
    this.avatar.setGlow(1.3 + pulse * 0.6);
    this.avatar.setColors(COLORS.thinkingRim, COLORS.thinkingCore);
    this.avatar.idleRotationSpeed = 0.6;
    // Orbital wobble around X for the "circular pattern".
    this.avatar.mesh.rotation.x = Math.sin(time * 1.5) * 0.4;
    this.avatar.mesh.scale.set(1, 1, 1);
  }

  private applySpeaking(): void {
    const impulse = this.impulse;
    this.avatar.setParams({ amplitude: 0.12 + impulse * 0.6, frequency: 1.7, speed: 1.2 });
    // Intense bright-blue glow that spikes on each word.
    this.avatar.setGlow(1.8 + impulse * 1.2);
    this.avatar.setColors(COLORS.neonRim, COLORS.speakingCore);
    this.avatar.idleRotationSpeed = 0.2;
    this.avatar.mesh.rotation.x = 0;
    const pop = 1 + impulse * 0.1;
    this.avatar.mesh.scale.set(pop, pop, pop);
  }
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}
