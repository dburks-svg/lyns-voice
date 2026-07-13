import { describe, it, expect } from 'vitest';
import { computeSnap, type SnapRect } from '../src/app/terminal/dragResize';

describe('computeSnap', () => {
  const vpW = 1000;
  const vpH = 800;

  it('snaps to left edge when within threshold', () => {
    const rect: SnapRect = { x: 8, y: 200, width: 300, height: 200 };
    const result = computeSnap(rect, vpW, vpH, [], 12);
    expect(result.x).toBe(0);
    expect(result.y).toBe(200);
  });

  it('snaps to right edge when within threshold', () => {
    const rect: SnapRect = { x: 695, y: 200, width: 300, height: 200 };
    const result = computeSnap(rect, vpW, vpH, [], 12);
    expect(result.x).toBe(700);
  });

  it('snaps to top edge when within threshold', () => {
    const rect: SnapRect = { x: 100, y: 5, width: 300, height: 200 };
    const result = computeSnap(rect, vpW, vpH, [], 12);
    expect(result.y).toBe(0);
  });

  it('snaps to bottom edge when within threshold', () => {
    const rect: SnapRect = { x: 100, y: 593, width: 300, height: 200 };
    const result = computeSnap(rect, vpW, vpH, [], 12);
    expect(result.y).toBe(600);
  });

  it('does not snap when outside threshold', () => {
    const rect: SnapRect = { x: 50, y: 50, width: 300, height: 200 };
    const result = computeSnap(rect, vpW, vpH, [], 12);
    expect(result.x).toBe(50);
    expect(result.y).toBe(50);
  });

  it('snaps to sibling panel right edge', () => {
    const rect: SnapRect = { x: 308, y: 100, width: 300, height: 200 };
    const target: SnapRect = { x: 0, y: 100, width: 300, height: 200 };
    const result = computeSnap(rect, vpW, vpH, [target], 12);
    expect(result.x).toBe(300);
  });

  it('snaps to sibling panel left edge', () => {
    const rect: SnapRect = { x: 192, y: 100, width: 300, height: 200 };
    const target: SnapRect = { x: 500, y: 100, width: 300, height: 200 };
    const result = computeSnap(rect, vpW, vpH, [target], 12);
    expect(result.x).toBe(200);
  });

  it('snaps to sibling panel bottom edge', () => {
    const rect: SnapRect = { x: 100, y: 207, width: 300, height: 200 };
    const target: SnapRect = { x: 100, y: 0, width: 300, height: 200 };
    const result = computeSnap(rect, vpW, vpH, [target], 12);
    expect(result.y).toBe(200);
  });

  it('returns unchanged position with threshold 0', () => {
    const rect: SnapRect = { x: 5, y: 5, width: 300, height: 200 };
    const result = computeSnap(rect, vpW, vpH, [], 0);
    expect(result.x).toBe(5);
    expect(result.y).toBe(5);
  });
});
