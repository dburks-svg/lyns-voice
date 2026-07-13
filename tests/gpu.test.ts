import { describe, it, expect } from 'vitest';
import { isSoftwareRenderer } from '../src/avatar/gpu';

describe('isSoftwareRenderer', () => {
  it('flags known CPU/software WebGL backends', () => {
    const software = [
      'Google SwiftShader',
      'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)',
      'ANGLE (Software Adapter)',
      'Microsoft Basic Render Driver',
      'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0)',
      'llvmpipe (LLVM 15.0.0, 256 bits)',
    ];
    for (const r of software) {
      expect(isSoftwareRenderer(r), r).toBe(true);
    }
  });

  it('does not flag real hardware GPUs', () => {
    const hardware = [
      'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0)',
      'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0)',
      'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0)',
      'Apple M2',
    ];
    for (const r of hardware) {
      expect(isSoftwareRenderer(r), r).toBe(false);
    }
  });
});
