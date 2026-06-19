import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { Avatar } from '../src/avatar/Avatar';
import type { GLTFLoaderLike, GLTFResultLike } from '../src/avatar/gltf';

function mockRendererFactory() {
  const factory = (canvas: HTMLCanvasElement): THREE.WebGLRenderer =>
    ({
      domElement: canvas,
      render: vi.fn(),
      setSize: vi.fn(),
      setPixelRatio: vi.fn(),
      setClearColor: vi.fn(),
      dispose: vi.fn(),
    }) as unknown as THREE.WebGLRenderer;
  return { factory };
}

/** Loader factory whose load() resolves with a scene wrapping `geometry`. */
function headLoaderFactory(geometry: THREE.BufferGeometry) {
  return (): GLTFLoaderLike => ({
    load: (_url, onLoad) => {
      const scene = new THREE.Group();
      scene.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()));
      onLoad({ scene } as GLTFResultLike);
    },
  });
}

/** Loader factory whose load() reports an error. */
function failingLoaderFactory() {
  return (): GLTFLoaderLike => ({
    load: (_url, _onLoad, _onProgress, onError) => onError?.(new Error('boom')),
  });
}

describe('Avatar geometry lifecycle', () => {
  it('orb skin: ready resolves immediately and keeps the icosahedron', async () => {
    const { factory } = mockRendererFactory();
    const avatar = new Avatar({ rendererFactory: factory, skin: 'orb' });
    expect(avatar.geometry).toBeInstanceOf(THREE.IcosahedronGeometry);
    await expect(avatar.ready).resolves.toBeUndefined();
    expect(avatar.geometry).toBeInstanceOf(THREE.IcosahedronGeometry);
  });

  it('head skin: shows the orb first, then atomically adopts the loaded head', async () => {
    const { factory } = mockRendererFactory();
    const head = new THREE.BoxGeometry(2, 3, 2); // 24 verts, distinct from the orb
    const avatar = new Avatar({
      rendererFactory: factory,
      skin: 'head',
      headUrl: 'head.glb',
      gltfLoaderFactory: headLoaderFactory(head),
    });

    // Synchronous fallback: still the orb until the load microtask runs.
    expect(avatar.geometry).toBeInstanceOf(THREE.IcosahedronGeometry);

    await avatar.ready;

    expect(avatar.geometry).toBe(head);
    expect(avatar.mesh.geometry).toBe(head);
    // Rest shape was recaptured from the head, so deform displaces it.
    const pos = avatar.geometry.getAttribute('position').array as Float32Array;
    const rest = Float32Array.from(pos);
    avatar.deform(1.0);
    expect(Array.from(pos).some((v, i) => Math.abs(v - rest[i]) > 1e-6)).toBe(true);
  });

  it('amplitudeScale 0 freezes the mesh even with a nonzero amplitude', () => {
    const { factory } = mockRendererFactory();
    const avatar = new Avatar({ rendererFactory: factory, amplitudeScale: 0 });
    avatar.setParams({ amplitude: 0.5 });
    const pos = avatar.geometry.getAttribute('position').array as Float32Array;
    const rest = Float32Array.from(pos);
    avatar.deform(1.0);
    for (let i = 0; i < pos.length; i += 1) {
      expect(pos[i]).toBeCloseTo(rest[i], 6);
    }
  });

  it('uses a skin-appropriate default amplitudeScale (orb 1, head 0.3)', () => {
    const { factory } = mockRendererFactory();
    expect(new Avatar({ rendererFactory: factory, skin: 'orb' }).amplitudeScale).toBe(1);
    expect(new Avatar({ rendererFactory: factory, skin: 'head' }).amplitudeScale).toBeCloseTo(0.3);
  });

  it('setSkin switches material and geometry both ways', async () => {
    const { factory } = mockRendererFactory();
    const head = new THREE.BoxGeometry(2, 3, 2);
    const avatar = new Avatar({
      rendererFactory: factory,
      skin: 'orb',
      gltfLoaderFactory: headLoaderFactory(head),
    });
    expect(avatar.material.wireframe).toBe(true);

    await avatar.setSkin('head');
    expect(avatar.skin).toBe('head');
    expect(avatar.material.wireframe).toBe(false);
    expect(avatar.geometry).toBe(head);
    expect(avatar.amplitudeScale).toBeCloseTo(0.3);

    await avatar.setSkin('orb');
    expect(avatar.skin).toBe('orb');
    expect(avatar.material.wireframe).toBe(true);
    expect(avatar.geometry).toBeInstanceOf(THREE.IcosahedronGeometry);
    expect(avatar.amplitudeScale).toBe(1);
  });

  it('head sways within a bounded yaw; orb spins freely', () => {
    const { factory } = mockRendererFactory();
    const head = new Avatar({ rendererFactory: factory, skin: 'head' });
    for (const t of [1, 5, 13, 47, 100]) {
      head.update(t);
      expect(Math.abs(head.mesh.rotation.y)).toBeLessThanOrEqual(0.35 + 1e-6);
    }

    const orb = new Avatar({ rendererFactory: factory, skin: 'orb' });
    orb.update(10);
    expect(orb.mesh.rotation.y).toBeCloseTo(10 * orb.idleRotationSpeed);
    expect(Math.abs(orb.mesh.rotation.y)).toBeGreaterThan(0.35); // unbounded spin
  });

  it('reducedMotion gentles breathing and disables rotation (a11y)', () => {
    const { factory } = mockRendererFactory();
    const maxDelta = (a: Avatar): number => {
      const pos = a.geometry.getAttribute('position').array as Float32Array;
      const rest = Float32Array.from(pos);
      a.update(3);
      let m = 0;
      for (let i = 0; i < pos.length; i += 1) {
        m = Math.max(m, Math.abs(pos[i] - rest[i]));
      }
      return m;
    };

    const full = new Avatar({ rendererFactory: factory, skin: 'orb' });
    full.setParams({ amplitude: 0.5 });
    const reduced = new Avatar({ rendererFactory: factory, skin: 'orb' });
    reduced.reducedMotion = true;
    reduced.setParams({ amplitude: 0.5 });

    const reducedDelta = maxDelta(reduced);
    const fullDelta = maxDelta(full);
    expect(reducedDelta).toBeGreaterThan(0); // calm, not frozen
    expect(reducedDelta).toBeLessThan(fullDelta);
    expect(reduced.mesh.rotation.y).toBe(0);
    expect(full.mesh.rotation.y).not.toBe(0);
  });

  it('head skin adds an additive backside glow shell sharing the head geometry', () => {
    const { factory } = mockRendererFactory();
    const head = new Avatar({ rendererFactory: factory, skin: 'head' });
    const halo = head.mesh.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh | undefined;
    expect(halo).toBeDefined();
    if (!halo) return;
    const mat = halo.material as THREE.ShaderMaterial;
    expect(mat.blending).toBe(THREE.AdditiveBlending);
    expect(mat.side).toBe(THREE.BackSide);
    expect(mat.depthWrite).toBe(false);
    expect(halo.geometry).toBe(head.geometry); // shares the head geometry

    const orb = new Avatar({ rendererFactory: factory, skin: 'orb' });
    expect(orb.mesh.children.some((c) => (c as THREE.Mesh).isMesh)).toBe(false);
  });

  it('the glow shell follows the head color and skin changes', async () => {
    const { factory } = mockRendererFactory();
    const headGeo = new THREE.BoxGeometry(2, 3, 2);
    const a = new Avatar({
      rendererFactory: factory,
      skin: 'orb',
      gltfLoaderFactory: headLoaderFactory(headGeo),
    });
    const hasHalo = (): boolean => a.mesh.children.some((c) => (c as THREE.Mesh).isMesh);
    expect(hasHalo()).toBe(false);

    await a.setSkin('head');
    expect(hasHalo()).toBe(true);
    a.setColors(0xff0000, 0x000000);
    const halo = a.mesh.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh | undefined;
    const mat = halo?.material as THREE.ShaderMaterial | undefined;
    expect(mat && (mat.uniforms.uColorA.value as THREE.Color).getHex()).toBe(0xff0000);

    await a.setSkin('orb');
    expect(hasHalo()).toBe(false);
  });

  it('head load failure resolves ready and keeps the orb (graceful fallback)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { factory } = mockRendererFactory();
    const avatar = new Avatar({
      rendererFactory: factory,
      skin: 'head',
      gltfLoaderFactory: failingLoaderFactory(),
    });
    await expect(avatar.ready).resolves.toBeUndefined();
    expect(avatar.geometry).toBeInstanceOf(THREE.IcosahedronGeometry);
    warn.mockRestore();
  });
});
