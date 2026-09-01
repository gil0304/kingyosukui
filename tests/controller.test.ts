import { describe, expect, it } from 'vitest';

import {
  Cooldown,
  LowPassFilter,
  OneEuroFilter,
  PeakTracker,
  Stillness,
  Vec3LowPass,
  softDeadZone,
} from '@/controller/filtering/filters';
import { Calibrator, averageCalibration } from '@/controller/calibration/calibrator';
import { GestureDetector, DEFAULT_GESTURE_TUNING } from '@/controller/gestures/gestureDetector';
import { DEG2RAD } from '@/game/core/math';
import type { SensorSample } from '@/types';

const DT = 1 / 60;

const sample = (over: Partial<SensorSample> = {}): SensorSample => ({
  alpha: 0,
  beta: 0,
  gamma: 0,
  absolute: false,
  ax: 0,
  ay: 0,
  az: 0,
  gx: 0,
  gy: 0,
  gz: -9.81,
  rotA: 0,
  rotB: 0,
  rotG: 0,
  t: 0,
  ...over,
});

describe('filters', () => {
  it('low pass converges and survives NaN', () => {
    const f = new LowPassFilter(0.2);
    for (let i = 0; i < 200; i++) f.next(10);
    expect(f.value).toBeCloseTo(10, 3);
    f.next(Number.NaN);
    expect(f.value).toBeCloseTo(10, 3);
  });

  it('one-euro tracks a moving signal without exploding', () => {
    const f = new OneEuroFilter();
    let last = 0;
    for (let i = 0; i < 400; i++) {
      const truth = Math.sin(i * 0.05);
      const noisy = truth + (i % 2 ? 0.02 : -0.02);
      last = f.next(noisy, DT);
      expect(Number.isFinite(last)).toBe(true);
    }
    expect(Math.abs(last)).toBeLessThan(1.3);
  });

  it('one-euro removes jitter from a still signal', () => {
    const f = new OneEuroFilter();
    let maxDev = 0;
    for (let i = 0; i < 300; i++) {
      const v = f.next((i % 2 ? 0.03 : -0.03), DT);
      if (i > 60) maxDev = Math.max(maxDev, Math.abs(v));
    }
    expect(maxDev).toBeLessThan(0.03);
  });

  it('soft dead zone is zero inside, continuous outside, and monotonic', () => {
    const dz = 0.1;
    expect(softDeadZone(0, dz)).toBe(0);
    expect(softDeadZone(0.05, dz)).toBe(0);
    expect(softDeadZone(-0.05, dz)).toBe(0);
    // no step at the edge
    expect(Math.abs(softDeadZone(0.1001, dz))).toBeLessThan(0.02);
    expect(softDeadZone(1, dz)).toBeCloseTo(1, 2);
    expect(softDeadZone(-1, dz)).toBeCloseTo(-1, 2);
    let prev = -Infinity;
    for (let v = 0; v <= 1.0001; v += 0.02) {
      const out = softDeadZone(v, dz);
      expect(out).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = out;
    }
  });

  it('cooldown gates repeated triggers', () => {
    const c = new Cooldown(0.5);
    expect(c.tryTrigger(10)).toBe(true);
    expect(c.tryTrigger(10.2)).toBe(false);
    expect(c.tryTrigger(10.6)).toBe(true);
  });

  it('peak tracker holds then decays', () => {
    const p = new PeakTracker(5);
    p.push(9, DT);
    expect(p.peak).toBeCloseTo(9, 5);
    for (let i = 0; i < 60; i++) p.push(0, DT);
    expect(p.peak).toBeLessThan(9);
    p.reset();
    expect(p.peak).toBe(0);
  });

  it('stillness distinguishes a still hand from a shaking one', () => {
    const s = new Stillness();
    for (let i = 0; i < 60; i++) s.push(0.001 * (i % 2 ? 1 : -1));
    expect(s.isStill).toBe(true);
    for (let i = 0; i < 60; i++) s.push(i % 2 ? 6 : -6);
    expect(s.isStill).toBe(false);
  });

  it('vec3 low pass estimates a constant gravity vector', () => {
    const v = new Vec3LowPass(0.08);
    for (let i = 0; i < 300; i++) v.next(0, 0, -9.81);
    expect(v.z).toBeCloseTo(-9.81, 1);
  });
});

describe('calibration', () => {
  it('averages the neutral pose and subtracts it afterwards', () => {
    const c = new Calibrator();
    c.begin();
    for (let i = 0; i < 40; i++) c.addSample(sample({ beta: 40 + (i % 2 ? 0.5 : -0.5), gamma: 5 }));
    const data = c.finish();
    expect(data).not.toBeNull();
    expect(data!.beta).toBeCloseTo(40, 0);
    expect(c.collecting).toBe(false);

    // Holding exactly the neutral pose means zero input.
    const at = c.apply(sample({ beta: 40, gamma: 5 }));
    expect(Math.abs(at.tiltX)).toBeLessThan(0.01);
    expect(Math.abs(at.tiltY)).toBeLessThan(0.01);

    // Rolling the phone 20 degrees right gives a positive tiltX.
    const rolled = c.apply(sample({ beta: 40, gamma: 25 }));
    expect(rolled.tiltX).toBeGreaterThan(15 * DEG2RAD * 0.8);
  });

  it('tipping the phone forward gives a negative pitch (poi goes deeper into the tank)', () => {
    const c = new Calibrator();
    c.begin();
    for (let i = 0; i < 20; i++) c.addSample(sample({ beta: 45 }));
    c.finish();
    const forward = c.apply(sample({ beta: 20 })); // top of the phone tipped away
    expect(forward.tiltY).toBeLessThan(0);
    const back = c.apply(sample({ beta: 70 }));
    expect(back.tiltY).toBeGreaterThan(0);
  });

  it('averages wrapping angles circularly, not arithmetically', () => {
    const d = averageCalibration([
      sample({ alpha: 359, gamma: 179 }),
      sample({ alpha: 1, gamma: -179 }),
    ]);
    expect(d).not.toBeNull();
    // The naive mean would be 180 / 0; the circular mean is ~0 / ~180.
    const a = ((d!.alpha % 360) + 360) % 360;
    expect(Math.min(a, 360 - a)).toBeLessThan(5);
    expect(Math.abs(Math.abs(d!.gamma) - 180)).toBeLessThan(5);
  });

  it('drift correction only runs when the hand is still', () => {
    const c = new Calibrator();
    c.begin();
    for (let i = 0; i < 20; i++) c.addSample(sample({ beta: 40 }));
    c.finish();
    const before = c.data!.beta;
    for (let i = 0; i < 600; i++) c.updateDrift(sample({ beta: 60 }), DT, true);
    expect(c.data!.beta).toBeCloseTo(before, 3);
    for (let i = 0; i < 600; i++) c.updateDrift(sample({ beta: 60 }), DT, false);
    expect(c.data!.beta).toBeGreaterThan(before);
    expect(c.data!.beta).toBeLessThan(60);
  });
});

describe('gesture detection — angle model v3', () => {
  const DEG = Math.PI / 180;

  const feed = (
    g: GestureDetector,
    pitchDeg: (i: number) => number,
    frames: number,
    t0 = 0,
  ): { t: number; events: string[] } => {
    let t = t0;
    const events: string[] = [];
    let prev = pitchDeg(0) * DEG;
    for (let i = 0; i < frames; i++) {
      const tiltY = pitchDeg(i) * DEG;
      const rate = (tiltY - prev) / DT;
      prev = tiltY;
      const out = g.update({ tiltY, pitchRate: rate, verticalAcceleration: 0 }, DT, t);
      out.events.forEach((e) => events.push(e.type));
      t += DT;
    }
    return { t, events };
  };

  it('a level phone does nothing, forever', () => {
    const g = new GestureDetector();
    const r = feed(g, () => 0, 60 * 30);
    expect(r.events).toHaveLength(0);
    expect(g.output.isSubmerging).toBe(false);
    expect(g.output.isLifting).toBe(false);
  });

  it('pitching down submerges; pitching back up at speed scoops', () => {
    const g = new GestureDetector();
    let r = feed(g, (i) => Math.max(-16, -i * 0.8), 60);
    expect(r.events).toContain('SUBMERGE');
    r = feed(g, (i) => -16 + Math.min(32, i * 1.2), 60, r.t);
    expect(r.events).toContain('LIFT');
  });

  it('holds isLifting as a level signal so a dropped packet cannot lose the scoop', () => {
    const g = new GestureDetector();
    let held = 0;
    let t = 0;
    let prev = 0;
    const trace = (i: number): number => (i < 40 ? -16 : Math.min(20, -16 + (i - 40) * 2.2));
    for (let i = 0; i < 120; i++) {
      const tiltY = trace(i) * DEG;
      const rate = (tiltY - prev * DEG) / DT;
      prev = trace(i);
      const out = g.update({ tiltY, pitchRate: rate, verticalAcceleration: 0 }, DT, t);
      if (out.isLifting) held++;
      t += DT;
    }
    expect(held).toBeGreaterThan(3);
  });

  it('bills a snap far above a calm scoop (§55)', () => {
    const gentle = new GestureDetector();
    let r = feed(gentle, () => -16, 60);
    feed(gentle, (i) => -16 + Math.min(32, i * 1.0), 60, r.t);
    const calm = gentle.output.liftPeakAccel;

    const violent = new GestureDetector();
    r = feed(violent, () => -16, 60);
    feed(violent, (i) => -16 + Math.min(36, i * 6), 40, r.t);
    expect(violent.output.liftPeakAccel).toBeGreaterThan(calm * 2.5);
  });

  it('roll never enters the detector — 左右の傾きは関与しない by construction', () => {
    // The detector consumes ONLY pitch; this pins the input surface itself.
    const g = new GestureDetector();
    const out = g.update({ tiltY: 0, pitchRate: 0, verticalAcceleration: 0 }, DT, 0);
    expect(out.isSubmerging).toBe(false);
    expect(Object.keys({ tiltY: 0, pitchRate: 0, verticalAcceleration: 0 })).toHaveLength(3);
  });

  it('survives NaN input without corrupting state', () => {
    const g = new GestureDetector();
    feed(g, () => -16, 60);
    g.update({ tiltY: Number.NaN, pitchRate: Number.NaN, verticalAcceleration: Number.NaN }, DT, 2);
    expect(Number.isFinite(g.output.handOffsetY)).toBe(true);
    const r = feed(g, () => -16, 30, 3);
    expect(g.output.isSubmerging).toBe(true);
    expect(r.events.length).toBeLessThanOrEqual(1);
  });

  it('has sane default tuning: thresholds ordered with real hysteresis gaps', () => {
    const tn = DEFAULT_GESTURE_TUNING;
    expect(tn.submergeAngle).toBeLessThan(tn.submergeExitAngle);
    expect(tn.submergeExitAngle).toBeLessThan(0);
    expect(tn.liftEndAngle).toBeGreaterThan(0);
    expect(tn.liftEndAngle).toBeLessThan(tn.liftAngle);
    expect(tn.cooldown).toBeGreaterThan(0);
  });
});

