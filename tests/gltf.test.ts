import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  extractHeadGeometry,
  normalizeHeadGeometry,
  loadHeadGeometry,
  type GLTFLoaderLike,
  type GLTFResultLike,
} from '../src/avatar/gltf';

function sceneWithMesh(geometry: THREE.BufferGeometry): THREE.Object3D {
  const group = new THREE.Group();
  const inner = new THREE.Group(); // nest it to exercise traversal
  inner.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()));
  group.add(inner);
  return group;
}

/** A loader stub that immediately invokes onLoad with the given scene. */
function fakeLoader(scene: THREE.Object3D): GLTFLoaderLike {
  return {
    load: (_url, onLoad) => onLoad({ scene } as GLTFResultLike),
  };
}

describe('extractHeadGeometry', () => {
  it('finds a nested mesh geometry', () => {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    expect(extractHeadGeometry(sceneWithMesh(geo))).toBe(geo);
  });

  it('throws when the scene has no mesh', () => {
    expect(() => extractHeadGeometry(new THREE.Group())).toThrow(/no mesh/i);
  });
});

describe('normalizeHeadGeometry', () => {
  it('centers at the origin and scales to the target radius', () => {
    const geo = new THREE.BoxGeometry(1, 2, 3);
    geo.translate(10, -5, 2); // shove it off-center
    normalizeHeadGeometry(geo, 1.2);

    geo.computeBoundingBox();
    const center = new THREE.Vector3();
    geo.boundingBox?.getCenter(center);
    expect(center.length()).toBeCloseTo(0, 5);

    geo.computeBoundingSphere();
    expect(geo.boundingSphere?.radius).toBeCloseTo(1.2, 5);
  });

  it('computes vertex normals when the model lacks them (deform needs them)', () => {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.deleteAttribute('normal');
    expect(geo.getAttribute('normal')).toBeUndefined();
    normalizeHeadGeometry(geo);
    expect(geo.getAttribute('normal')).toBeDefined();
  });
});

describe('loadHeadGeometry', () => {
  it('resolves with a normalized geometry from the injected loader', async () => {
    const geo = new THREE.BoxGeometry(2, 2, 2);
    const out = await loadHeadGeometry({
      url: 'head.glb',
      loaderFactory: () => fakeLoader(sceneWithMesh(geo)),
      targetRadius: 1.5,
    });
    out.computeBoundingSphere();
    expect(out.boundingSphere?.radius).toBeCloseTo(1.5, 5);
  });

  it('rejects when the loader errors', async () => {
    const loader: GLTFLoaderLike = {
      load: (_url, _onLoad, _onProgress, onError) => onError?.(new Error('404')),
    };
    await expect(
      loadHeadGeometry({ url: 'missing.glb', loaderFactory: () => loader }),
    ).rejects.toThrow(/404/);
  });

  it('rejects when the model has no mesh (caller keeps the orb fallback)', async () => {
    await expect(
      loadHeadGeometry({ url: 'empty.glb', loaderFactory: () => fakeLoader(new THREE.Group()) }),
    ).rejects.toThrow(/no mesh/i);
  });
});
