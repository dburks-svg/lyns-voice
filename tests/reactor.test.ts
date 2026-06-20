import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { buildReactor } from '../src/avatar/reactor';
import { Avatar } from '../src/avatar/Avatar';

/** Mock renderer (happy-dom has no WebGL); everything else runs on real Three.js. */
function mockRendererFactory() {
  const render = vi.fn();
  const factory = (canvas: HTMLCanvasElement): THREE.WebGLRenderer =>
    ({
      domElement: canvas,
      render,
      setSize: vi.fn(),
      setPixelRatio: vi.fn(),
      setClearColor: vi.fn(),
      dispose: vi.fn(),
    }) as unknown as THREE.WebGLRenderer;
  return { factory, render };
}

describe('buildReactor', () => {
  it('builds a group of rings + orbits + core + a particle field', () => {
    const r = buildReactor({ radius: 1.2, colorA: 0x00f0ff, colorB: 0x0077ff });
    expect(r.group).toBeInstanceOf(THREE.Group);
    expect(r.rings).toHaveLength(3);
    expect(r.orbits).toHaveLength(3);
    expect(r.core).toBeInstanceOf(THREE.Mesh);
    expect(r.particles).toBeInstanceOf(THREE.Points);
    expect(r.group.children).toHaveLength(8); // 3 rings + 3 orbits + core + particles
    r.dispose();
  });

  it('orders the concentric rings by ascending radius', () => {
    const r = buildReactor({ radius: 1.2, colorA: 0, colorB: 0 });
    const radii = r.rings.map((m) => (m.geometry as THREE.TorusGeometry).parameters.radius);
    expect(radii[0]).toBeLessThan(radii[1]);
    expect(radii[1]).toBeLessThan(radii[2]);
    r.dispose();
  });

  it('materials carry the shared uniform contract and blend additively', () => {
    const r = buildReactor({ radius: 1, colorA: 0, colorB: 0 });
    for (const mat of [r.ringMaterial, r.coreMaterial]) {
      expect(mat.uniforms.uColorA.value).toBeInstanceOf(THREE.Color);
      expect(mat.uniforms.uColorB.value).toBeInstanceOf(THREE.Color);
      expect(mat.uniforms.uGlow).toBeDefined();
      expect(mat.uniforms.uOpacity).toBeDefined();
      expect(mat.blending).toBe(THREE.AdditiveBlending);
      expect(mat.depthWrite).toBe(false);
    }
    r.dispose();
  });

  it('setColors fans out to both materials', () => {
    const r = buildReactor({ radius: 1, colorA: 0, colorB: 0 });
    r.setColors(0xff0000, 0x00ff00);
    expect((r.ringMaterial.uniforms.uColorA.value as THREE.Color).getHex()).toBe(0xff0000);
    expect((r.ringMaterial.uniforms.uColorB.value as THREE.Color).getHex()).toBe(0x00ff00);
    expect((r.coreMaterial.uniforms.uColorA.value as THREE.Color).getHex()).toBe(0xff0000);
    r.dispose();
  });

  it('setGlow fans out to both materials', () => {
    const r = buildReactor({ radius: 1, colorA: 0, colorB: 0 });
    r.setGlow(2.5);
    expect(r.ringMaterial.uniforms.uGlow.value).toBe(2.5);
    expect(r.coreMaterial.uniforms.uGlow.value).toBe(2.5);
    r.dispose();
  });

  it('update pulses the core with amplitude and advances ring rotation', () => {
    const r = buildReactor({ radius: 1, colorA: 0, colorB: 0 });
    const params = { amplitude: 0.5, frequency: 2, speed: 2.5 };
    r.update(0, params, 1.5, { reducedMotion: false }); // first call seeds dt
    expect(r.core.scale.x).toBeGreaterThan(1.3); // core flares with amplitude
    r.update(0.1, params, 1.5, { reducedMotion: false }); // dt > 0 -> spin advances
    expect(r.rings[0].rotation.z).not.toBe(0);
    expect(r.coreMaterial.uniforms.uGlow.value).toBeGreaterThan(1.5); // core runs hotter
    r.dispose();
  });

  it('update drives the audio-reactive uniforms from amplitude', () => {
    const r = buildReactor({ radius: 1, colorA: 0, colorB: 0 });
    r.update(0, { amplitude: 0.7, frequency: 1, speed: 1 }, 1.0, { reducedMotion: false });
    expect(r.ringMaterial.uniforms.uAudio.value).toBeCloseTo(0.7);
    expect(r.coreMaterial.uniforms.uAudio.value).toBeCloseTo(0.7);
    expect(r.particleMaterial.uniforms.uAudio.value).toBeCloseTo(0.7);
    r.dispose();
  });

  it('reduced motion gentles the core pulse', () => {
    const r = buildReactor({ radius: 1, colorA: 0, colorB: 0 });
    r.update(0, { amplitude: 0.5, frequency: 2, speed: 2.5 }, 1.5, { reducedMotion: true });
    expect(r.core.scale.x).toBeLessThan(1.1); // vs > 1.3 at full motion
    r.dispose();
  });

  it('dispose releases every geometry and material', () => {
    const r = buildReactor({ radius: 1, colorA: 0, colorB: 0 });
    const geoSpies = [...r.rings, ...r.orbits, r.core, r.particles].map((m) =>
      vi.spyOn(m.geometry, 'dispose'),
    );
    const ringMat = vi.spyOn(r.ringMaterial, 'dispose');
    const coreMat = vi.spyOn(r.coreMaterial, 'dispose');
    const partMat = vi.spyOn(r.particleMaterial, 'dispose');
    r.dispose();
    for (const spy of geoSpies) {
      expect(spy).toHaveBeenCalledTimes(1);
    }
    expect(ringMat).toHaveBeenCalledTimes(1);
    expect(coreMat).toHaveBeenCalledTimes(1);
    expect(partMat).toHaveBeenCalledTimes(1);
  });
});

describe('Avatar reactor skin', () => {
  it('attaches the reactor group under an invisible carrier and skips deform', () => {
    const { factory } = mockRendererFactory();
    const avatar = new Avatar({ rendererFactory: factory, skin: 'reactor' });
    expect(avatar.material.visible).toBe(false); // carrier renders nothing
    const group = avatar.mesh.children.find((c) => c instanceof THREE.Group);
    expect(group).toBeInstanceOf(THREE.Group);

    // deform() is a no-op for the reactor: the carrier geometry stays at rest.
    const pos = avatar.geometry.attributes.position.array as Float32Array;
    const before = Float32Array.from(pos);
    avatar.setParams({ amplitude: 1 });
    avatar.deform(1.0);
    expect(Array.from(pos)).toEqual(Array.from(before));
    avatar.dispose();
  });

  it('renders once per update without throwing', () => {
    const { factory, render } = mockRendererFactory();
    const avatar = new Avatar({ rendererFactory: factory, skin: 'reactor' });
    expect(() => avatar.update(0.5)).not.toThrow();
    expect(render).toHaveBeenCalledTimes(1);
    avatar.dispose();
  });

  it('switching reactor -> orb removes the group and restores a visible orb', async () => {
    const { factory } = mockRendererFactory();
    const avatar = new Avatar({ rendererFactory: factory, skin: 'reactor' });
    await avatar.setSkin('orb');
    expect(avatar.skin).toBe('orb');
    expect(avatar.material.visible).toBe(true);
    expect(avatar.material.wireframe).toBe(true);
    expect(avatar.mesh.children.some((c) => c instanceof THREE.Group)).toBe(false);
    avatar.dispose();
  });
});
