import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { Avatar, IDLE_PARAMS } from '../src/avatar/Avatar';

/**
 * happy-dom has no WebGL, so we inject a mock renderer. Everything else (scene
 * graph, geometry, deformation) runs on real Three.js CPU objects.
 */
function mockRendererFactory() {
  const render = vi.fn();
  const setSize = vi.fn();
  const setPixelRatio = vi.fn();
  const dispose = vi.fn();
  const factory = (canvas: HTMLCanvasElement): THREE.WebGLRenderer =>
    ({
      domElement: canvas,
      render,
      setSize,
      setPixelRatio,
      setClearColor: vi.fn(),
      dispose,
    }) as unknown as THREE.WebGLRenderer;
  return { factory, render, setSize, setPixelRatio, dispose };
}

describe('Avatar', () => {
  it('builds a wireframe icosahedron with neon uniforms and idle params', () => {
    const { factory } = mockRendererFactory();
    const avatar = new Avatar({ rendererFactory: factory });

    expect(avatar.geometry).toBeInstanceOf(THREE.IcosahedronGeometry);
    expect(avatar.material.wireframe).toBe(true);
    expect(avatar.material.uniforms.uColorA.value).toBeInstanceOf(THREE.Color);
    expect(avatar.material.transparent).toBe(true);
    expect(avatar.scene.children).toContain(avatar.mesh);
    expect(avatar.params).toEqual(IDLE_PARAMS);
  });

  it('mounts its canvas into the container', () => {
    const { factory } = mockRendererFactory();
    const avatar = new Avatar({ rendererFactory: factory });
    const container = document.createElement('div');
    avatar.mount(container);
    expect(container.contains(avatar.renderer.domElement)).toBe(true);
  });

  it('deforms vertices when breathing and restores rest shape at amplitude 0', () => {
    const { factory } = mockRendererFactory();
    const avatar = new Avatar({ rendererFactory: factory });
    const pos = avatar.geometry.attributes.position.array as Float32Array;
    const rest = Float32Array.from(pos);

    avatar.deform(1.0);
    let moved = false;
    for (let i = 0; i < pos.length; i += 1) {
      if (Math.abs(pos[i] - rest[i]) > 1e-6) {
        moved = true;
        break;
      }
    }
    expect(moved).toBe(true);

    avatar.setParams({ amplitude: 0 });
    avatar.deform(1.0);
    for (let i = 0; i < pos.length; i += 1) {
      expect(pos[i]).toBeCloseTo(rest[i], 6);
    }
  });

  it('updates camera aspect and renderer size on resize', () => {
    const { factory, setSize } = mockRendererFactory();
    const avatar = new Avatar({ rendererFactory: factory });
    avatar.resize(800, 400);
    expect(avatar.camera.aspect).toBeCloseTo(2);
    expect(setSize).toHaveBeenCalledWith(800, 400, false);
  });

  it('renders exactly once per update', () => {
    const { factory, render } = mockRendererFactory();
    const avatar = new Avatar({ rendererFactory: factory });
    avatar.update(0.5);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('sets the glow uniform', () => {
    const { factory } = mockRendererFactory();
    const avatar = new Avatar({ rendererFactory: factory });
    avatar.setGlow(2.5);
    expect(avatar.material.uniforms.uGlow.value).toBe(2.5);
  });

  it('releases resources and detaches on dispose', () => {
    const { factory, dispose } = mockRendererFactory();
    const avatar = new Avatar({ rendererFactory: factory });
    const geometryDispose = vi.spyOn(avatar.geometry, 'dispose');
    const materialDispose = vi.spyOn(avatar.material, 'dispose');

    avatar.dispose();

    expect(geometryDispose).toHaveBeenCalledTimes(1);
    expect(materialDispose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(avatar.scene.children).not.toContain(avatar.mesh);
  });
});
