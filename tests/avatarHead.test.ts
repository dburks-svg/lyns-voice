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
    const avatar = new Avatar({ rendererFactory: factory });
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

  it('defaults amplitudeScale to 1', () => {
    const { factory } = mockRendererFactory();
    expect(new Avatar({ rendererFactory: factory }).amplitudeScale).toBe(1);
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
