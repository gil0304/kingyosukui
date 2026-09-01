import { describe, expect, it } from 'vitest';

import { DEG2RAD } from '@/game/core/math';
import { FISH_TYPES } from '@/game/fish/fishTypes';
import { BowlSimulation, type BowlBounds } from '@/smartphone/bowl/bowlSimulation';
import type { CapturedFish, FishType } from '@/types';

const BOUNDS: BowlBounds = { cx: 160, cy: 220, rx: 150, ry: 190, waterY: 120 };
const DT = 1 / 60;
/** Spec §93 — the surface never tilts past this, whatever the phone does. */
const MAX_SURFACE_TILT = 6 * DEG2RAD;

const cf = (id: string, fishType: FishType = 'red', score = 100): CapturedFish => ({
  id,
  fishType,
  score,
  capturedAt: 0,
});

const school = (n: number): CapturedFish[] =>
  Array.from({ length: n }, (_, i) => cf(`f${i}`, FISH_TYPES[i % FISH_TYPES.length], 100 + i));

const makeBowl = (): BowlSimulation => {
  const bowl = new BowlSimulation();
  bowl.setBounds({ ...BOUNDS });
  return bowl;
};

/** Advance the bowl by 'seconds' of 60 Hz frames; returns the new clock. */
const run = (bowl: BowlSimulation, seconds: number, t0 = 0): number => {
  const steps = Math.round(seconds * 60);
  let t = t0;
  for (let i = 0; i < steps; i++) {
    t += DT;
    bowl.update(DT, t);
  }
  return t;
};

/** The wave-free part of the water line: still level plus the steady tilt. */
const tiltedLineAt = (bowl: BowlSimulation, x: number): number => {
  const u = (x - (BOUNDS.cx - BOUNDS.rx)) / (BOUNDS.rx * 2);
  return bowl.waterLineY(x) - bowl.surfaceHeightAt(u);
};

const insideGlass = (x: number, y: number): number =>
  Math.hypot((x - BOUNDS.cx) / BOUNDS.rx, (y - BOUNDS.cy) / BOUNDS.ry);

describe('BowlSimulation', () => {
  it('adds one fish per captured fish and never duplicates on a repeated sync', () => {
    const bowl = makeBowl();
    const caught = [cf('a', 'red'), cf('b', 'gold', 1000)];

    bowl.sync(caught);
    expect(bowl.count).toBe(2);
    expect(bowl.fish.map((f) => f.id)).toEqual(['a', 'b']);
    expect(bowl.fish[1].type).toBe('gold');
    expect(bowl.fish[1].score).toBe(1000);
    expect(bowl.fish.every((f) => f.size > 0)).toBe(true);

    // The server re-sends the same list on every heartbeat.
    bowl.sync(caught);
    bowl.sync([...caught]);
    expect(bowl.count).toBe(2);

    bowl.sync([...caught, cf('c', 'black')]);
    expect(bowl.count).toBe(3);
    expect(bowl.fish.map((f) => f.id)).toEqual(['a', 'b', 'c']);
  });

  it('drops a newly caught fish in from above the water and lets it settle below it', () => {
    const bowl = makeBowl();
    // The first batch is placed already swimming; only later arrivals fall in.
    bowl.sync([cf('a')]);
    const t = run(bowl, 1);

    bowl.sync([cf('a'), cf('b', 'gold', 1000)]);
    const dropping = bowl.fish.find((f) => f.id === 'b')!;
    expect(dropping.enterT).toBeLessThan(1);
    expect(dropping.y).toBeLessThan(bowl.waterLineY(dropping.x));

    // Just past the end of the fall: it has broken the surface and left a ring.
    const landed = run(bowl, 0.7, t);
    expect(bowl.splashes.length).toBeGreaterThan(0);

    run(bowl, 1.5, landed);
    const settled = bowl.fish.find((f) => f.id === 'b')!;
    expect(settled.enterT).toBe(1);
    expect(settled.y).toBeGreaterThan(bowl.waterLineY(settled.x));
    expect(settled.scale).toBeGreaterThan(0);
    expect(insideGlass(settled.x, settled.y)).toBeLessThanOrEqual(1);
  });

  it('keeps every fish inside the glass and under the water after a long swim', () => {
    const bowl = makeBowl();
    bowl.sync(school(6));
    run(bowl, 25);

    expect(bowl.count).toBe(6);
    for (const f of bowl.fish) {
      expect(Number.isFinite(f.x)).toBe(true);
      expect(Number.isFinite(f.y)).toBe(true);
      expect(Number.isFinite(f.angle)).toBe(true);
      expect(Number.isFinite(f.scale)).toBe(true);
      expect(Number.isFinite(f.phase)).toBe(true);
      expect(f.scale).toBeGreaterThan(0);
      expect(insideGlass(f.x, f.y)).toBeLessThanOrEqual(1);
      expect(f.y).toBeGreaterThan(bowl.waterLineY(f.x));
    }
  });

  it('tilts the surface with the phone but clamps it far below anything usable', () => {
    const bowl = makeBowl();
    bowl.sync(school(4));

    // A wildly over-tilted phone: 1.2 rad is nearly 70 degrees.
    bowl.setTilt(1.2);
    const t = run(bowl, 4);

    expect(bowl.tilt).toBeGreaterThan(0);
    expect(Math.abs(bowl.tilt)).toBeLessThanOrEqual(MAX_SURFACE_TILT + 1e-9);

    const right = tiltedLineAt(bowl, BOUNDS.cx + BOUNDS.rx * 0.9);
    const left = tiltedLineAt(bowl, BOUNDS.cx - BOUNDS.rx * 0.9);
    expect(tiltedLineAt(bowl, BOUNDS.cx)).toBeCloseTo(BOUNDS.waterY, 6);
    expect(right).toBeGreaterThan(left);
    expect(right - left).toBeCloseTo(Math.tan(bowl.tilt) * BOUNDS.rx * 1.8, 6);
    // Across the whole bowl the water moves a few pixels, not half a bowl.
    expect(right - left).toBeLessThan(BOUNDS.rx * 0.25);

    // Rolling the other way mirrors it, still clamped.
    bowl.setTilt(-1.2);
    run(bowl, 4, t);
    expect(bowl.tilt).toBeLessThan(0);
    expect(Math.abs(bowl.tilt)).toBeLessThanOrEqual(MAX_SURFACE_TILT + 1e-9);
    expect(tiltedLineAt(bowl, BOUNDS.cx + BOUNDS.rx * 0.9)).toBeLessThan(
      tiltedLineAt(bowl, BOUNDS.cx - BOUNDS.rx * 0.9),
    );

    // Nothing was flung out of the glass by the roll.
    for (const f of bowl.fish) {
      expect(insideGlass(f.x, f.y)).toBeLessThanOrEqual(1);
      expect(f.y).toBeGreaterThan(bowl.waterLineY(f.x));
    }
  });

  it('handles the bowl being emptied and refilled between rounds', () => {
    const bowl = makeBowl();
    bowl.sync([cf('a'), cf('b', 'black')]);
    const t = run(bowl, 1);

    bowl.sync([]);
    expect(bowl.count).toBe(0);
    expect(bowl.fish).toHaveLength(0);

    run(bowl, 1, t);
    expect(bowl.count).toBe(0);

    bowl.sync([cf('c', 'demekin')]);
    expect(bowl.count).toBe(1);
    run(bowl, 2, t + 1);
    expect(bowl.fish[0].y).toBeGreaterThan(bowl.waterLineY(bowl.fish[0].x));
  });

  it('stays stable for a long run with a full bowl of 40 fish', () => {
    const bowl = makeBowl();
    bowl.sync(school(40));
    expect(bowl.count).toBe(40);

    run(bowl, 30);

    expect(bowl.count).toBe(40);
    for (const f of bowl.fish) {
      expect(Number.isFinite(f.x)).toBe(true);
      expect(Number.isFinite(f.y)).toBe(true);
      expect(Number.isFinite(f.vx)).toBe(true);
      expect(Number.isFinite(f.vy)).toBe(true);
      expect(f.size).toBeGreaterThan(0);
      expect(insideGlass(f.x, f.y)).toBeLessThanOrEqual(1);
      expect(f.y).toBeGreaterThan(bowl.waterLineY(f.x));
    }
    for (const w of bowl.surface) {
      expect(Number.isFinite(w.amplitude)).toBe(true);
      expect(Math.abs(w.amplitude)).toBeLessThanOrEqual(BOUNDS.ry * 0.06 + 1e-9);
    }
  });

  it('caps the surface rings even when splashes are spammed', () => {
    const bowl = makeBowl();
    bowl.sync([cf('a')]);
    for (let i = 0; i < 100; i++) bowl.addSplash(BOUNDS.cx, BOUNDS.waterY, 1);
    expect(bowl.splashes.length).toBeLessThanOrEqual(24);

    run(bowl, 3);
    expect(bowl.splashes).toHaveLength(0);
    for (const w of bowl.surface) {
      expect(Number.isFinite(w.amplitude)).toBe(true);
      expect(Math.abs(w.amplitude)).toBeLessThanOrEqual(BOUNDS.ry * 0.06 + 1e-9);
    }
  });

  it('ignores a zero or negative dt and survives a backgrounded tab', () => {
    const bowl = makeBowl();
    bowl.sync(school(4));
    const before = bowl.fish.map((f) => f.x);

    bowl.update(0, 1);
    bowl.update(-1, 1);
    expect(bowl.fish.map((f) => f.x)).toEqual(before);

    // Seconds of dt at once: clamped internally, never integrated raw.
    bowl.update(5, 6);
    bowl.update(5, 11);
    for (const f of bowl.fish) {
      expect(Number.isFinite(f.x)).toBe(true);
      expect(Number.isFinite(f.y)).toBe(true);
      expect(insideGlass(f.x, f.y)).toBeLessThanOrEqual(1);
    }
  });
});
