import { describe, expect, it } from 'vitest';

import { FISH_BOUNDS, TANK } from '@/game/core/constants';
import { createRng } from '@/game/core/math';
import { DEFAULT_BOID_WEIGHTS, SpatialHash } from '@/game/fish/boids';

/** The same grid the fish simulation uses: one cell wider than a neighbourhood. */
const CELL = 1.5;

const makeHash = (): SpatialHash =>
  new SpatialHash(
    -TANK.halfWidth,
    TANK.floorY,
    -TANK.halfDepth,
    TANK.halfWidth,
    TANK.surfaceY,
    TANK.halfDepth,
    CELL,
  );

const idsOf = (out: Int32Array, n: number): number[] => Array.from(out.subarray(0, n));

interface Point {
  x: number;
  y: number;
  z: number;
}

const scatter = (h: SpatialHash, count: number, seed: number): Point[] => {
  const rng = createRng(seed);
  const pts: Point[] = [];
  for (let i = 0; i < count; i++) {
    const p: Point = {
      x: rng.range(FISH_BOUNDS.minX, FISH_BOUNDS.maxX),
      y: rng.range(FISH_BOUNDS.minY, FISH_BOUNDS.maxY),
      z: rng.range(FISH_BOUNDS.minZ, FISH_BOUNDS.maxZ),
    };
    pts.push(p);
    h.insert(i, p.x, p.y, p.z);
  }
  return pts;
};

describe('SpatialHash', () => {
  it('returns every point a query covers', () => {
    const h = makeHash();
    h.insert(0, 0, -1, 0);
    h.insert(1, 0.3, -1.1, 0.2);
    h.insert(2, -0.4, -0.9, -0.3);

    const out = new Int32Array(64);
    const n = h.query(0, -1, 0, 0.6, out);
    const ids = idsOf(out, n);

    expect(n).toBeGreaterThanOrEqual(3);
    expect(ids).toContain(0);
    expect(ids).toContain(1);
    expect(ids).toContain(2);
    expect(new Set(ids).size).toBe(n);
  });

  it('leaves points on the other side of the tank out of the result', () => {
    const h = makeHash();
    h.insert(0, 0, -1, 0);
    h.insert(1, 6.5, -1, 3.5);

    const out = new Int32Array(32);
    const ids = idsOf(out, h.query(0, -1, 0, 1.0, out));
    expect(ids).toContain(0);
    expect(ids).not.toContain(1);
  });

  it('is conservative but never misses a true neighbour', () => {
    const h = makeHash();
    const pts = scatter(h, 200, 0x51a7);
    const radius = DEFAULT_BOID_WEIGHTS.neighborRadius;
    const out = new Int32Array(256);

    for (let q = 0; q < 25; q++) {
      const c = pts[(q * 7) % pts.length];
      const n = h.query(c.x, c.y, c.z, radius, out);
      const ids = idsOf(out, n);
      const found = new Set(ids);

      // Nothing bogus, nothing repeated.
      expect(found.size).toBe(n);
      for (const i of ids) {
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(pts.length);
      }

      // Every point actually inside the sphere is in the candidate set.
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const d = Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z);
        if (d <= radius) expect(found.has(i)).toBe(true);
      }
    }
  });

  it('clamps coordinates far outside the AABB into the edge cells', () => {
    const h = makeHash();
    h.insert(0, 0, -1, 0);
    h.insert(1, 1e6, 1e6, 1e6);
    h.insert(2, -1e6, -1e6, -1e6);
    h.insert(3, Number.NaN, Number.NaN, Number.NaN);

    const out = new Int32Array(64);

    // The middle of the tank is untouched by any of them.
    expect(idsOf(out, h.query(0, -1, 0, 0.5, out))).toEqual([0]);

    // The far-positive point sits in the max corner cell.
    const hi = idsOf(out, h.query(TANK.halfWidth - 0.1, -0.1, TANK.halfDepth - 0.1, 0.2, out));
    expect(hi).toContain(1);
    expect(hi).not.toContain(0);

    // The far-negative point and the NaN both fall into the min corner cell.
    const lo = idsOf(
      out,
      h.query(-TANK.halfWidth + 0.1, TANK.floorY + 0.1, -TANK.halfDepth + 0.1, 0.2, out),
    );
    expect(lo).toContain(2);
    expect(lo).toContain(3);
    expect(lo).not.toContain(0);
  });

  it('empties on clear() and can be refilled', () => {
    const h = makeHash();
    const out = new Int32Array(32);
    scatter(h, 40, 7);
    expect(h.query(0, -1.2, 0, 100, out)).toBeGreaterThan(0);

    h.clear();
    expect(h.query(0, -1.2, 0, 100, out)).toBe(0);

    h.insert(9, 0, -1, 0);
    expect(idsOf(out, h.query(0, -1, 0, 0.5, out))).toEqual([9]);
  });

  it('never writes past the end of the out array', () => {
    const h = makeHash();
    for (let i = 0; i < 50; i++) {
      h.insert(i, Math.cos(i) * 0.1, -1, Math.sin(i) * 0.1);
    }

    const backing = new Int32Array(16).fill(-7);
    const out = backing.subarray(0, 4);
    const n = h.query(0, -1, 0, 0.4, out);

    expect(n).toBe(4);
    for (let i = 4; i < backing.length; i++) expect(backing[i]).toBe(-7);
  });

  it('stays correct when inserts and queries are interleaved', () => {
    const h = makeHash();
    const out = new Int32Array(32);

    h.insert(0, 0, -1, 0);
    expect(idsOf(out, h.query(0, -1, 0, 0.5, out))).toEqual([0]);

    h.insert(1, 0.1, -1, 0.1);
    const n = h.query(0, -1, 0, 0.5, out);
    expect(new Set(idsOf(out, n))).toEqual(new Set([0, 1]));
  });

  it('grows past its initial capacity without losing or duplicating entries', () => {
    const h = makeHash();
    const count = 400;
    scatter(h, count, 0xbeef);

    const out = new Int32Array(600);
    const n = h.query(0, -1.2, 0, 100, out);
    expect(n).toBe(count);
    expect(new Set(idsOf(out, n)).size).toBe(count);
  });

  it('answers an empty grid and a negative radius without complaint', () => {
    const h = makeHash();
    const out = new Int32Array(8);
    expect(h.query(0, -1, 0, 5, out)).toBe(0);

    h.insert(3, 0, -1, 0);
    expect(idsOf(out, h.query(0, -1, 0, -5, out))).toEqual([3]);
  });
});

describe('DEFAULT_BOID_WEIGHTS', () => {
  it('has sane, positive values with separation dominant', () => {
    const w = DEFAULT_BOID_WEIGHTS;
    for (const v of Object.values(w)) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
    // Fish that interpenetrate read as one blob from across the room.
    expect(w.separation).toBeGreaterThan(w.alignment);
    expect(w.separation).toBeGreaterThan(w.cohesion);
    expect(w.separationRadius).toBeLessThan(w.neighborRadius);
    // A neighbourhood is local: nowhere near the width of the tank.
    expect(w.neighborRadius).toBeLessThan(TANK.width * 0.25);
    expect(w.neighborRadius).toBeLessThanOrEqual(CELL);
  });
});
