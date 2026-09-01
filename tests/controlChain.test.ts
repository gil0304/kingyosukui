/**
 * End-to-end conventions of control model v4 (owner redesign, 2026-08-26):
 *
 *   pitch DOWN → into the water (deeper the further you tip)
 *   pitch UP   → the scoop, billed at the speed it happened (§55)
 *   roll       → no effect on entering or scooping
 *   touch      → lateral/depth glide (right side of the screen = right, etc.)
 *
 * Every function here is imported from the modules the phone actually runs.
 * Angle control has no device sign conventions and nothing to integrate, so
 * these tests pin the entire feel of the piece.
 */

import { describe, expect, it } from 'vitest';

import { gravityAngles, gravityHemisphere, touchCurve } from '@/controller/sensors/sensorAdapter';
import { GestureDetector } from '@/controller/gestures/gestureDetector';
import { POI, POI_BOUNDS } from '@/game/core/constants';
import { DEG2RAD, wrapAngle } from '@/game/core/math';
import { PoiSimulation, type PoiInput } from '@/game/poi/poiSimulation';

const DT = 1 / 60;
const DEG = DEG2RAD;

/** Gravity DOWN unit (W3C hemisphere) for a phone rolled/pitched from flat. */
const gravityFor = (rollDeg: number, pitchDeg: number): [number, number, number] => {
  const r = rollDeg * DEG;
  const p = pitchDeg * DEG;
  const x = Math.sin(r) * Math.cos(p);
  const y = Math.sin(p) * Math.cos(r);
  const z = -Math.sqrt(Math.max(0, 1 - x * x - y * y));
  return [x, y, z];
};

/** The adapter's exact tilt computation for a neutral captured at (roll0, pitch0). */
const tiltFor = (
  rollDeg: number,
  pitchDeg: number,
  roll0Deg = 0,
  pitch0Deg = 0,
  sZ = 1,
): { tiltX: number; tiltY: number } => {
  const flip = sZ === 1 ? 1 : -1;
  const [gx, gy, gz] = gravityFor(rollDeg, pitchDeg);
  const [nx, ny, nz] = gravityFor(roll0Deg, pitch0Deg);
  const a = gravityAngles(gx * flip, gy * flip, gz * flip, sZ);
  const n = gravityAngles(nx * flip, ny * flip, nz * flip, sZ);
  return { tiltX: wrapAngle(a.roll - n.roll), tiltY: -wrapAngle(a.pitch - n.pitch) };
};

const input = (over: Partial<PoiInput> = {}): PoiInput => ({
  x: 0,
  y: 0,
  tiltX: 0,
  tiltY: 0,
  tiltZ: 0,
  verticalAcceleration: 0,
  handOffsetY: 0,
  handVelocityY: 0,
  liftPeakAccel: 0,
  isSubmerging: false,
  isLifting: false,
  connected: true,
  ...over,
});

// ---------------------------------------------------------------------------

describe('gravity pitch — the action lever', () => {
  it('tipping the phone DOWN reads negative tiltY, UP positive', () => {
    // Our pitch convention: top edge tipped AWAY/down ⇒ pitch grows ⇒ tiltY = −.
    expect(tiltFor(0, 18).tiltY).toBeLessThan(-15 * DEG);
    expect(tiltFor(0, -18).tiltY).toBeGreaterThan(15 * DEG);
  });

  it('roll does not leak into pitch — 左右の傾きは動作に関与しない', () => {
    for (const roll of [-30, -15, 15, 30]) {
      const t = tiltFor(roll, 0);
      expect(Math.abs(t.tiltY)).toBeLessThan(2 * DEG);
    }
    // …and a pitched phone keeps its pitch reading while rolled.
    const straight = tiltFor(0, 16).tiltY;
    const rolled = tiltFor(25, 16).tiltY;
    expect(Math.abs(rolled - straight)).toBeLessThan(4 * DEG);
  });

  it('the iOS inverted-gravity convention reads identically', () => {
    const w3c = tiltFor(10, 14, 0, 0, 1);
    const ios = tiltFor(10, 14, 0, 0, -1);
    expect(ios.tiltY).toBeCloseTo(w3c.tiltY, 6);
    expect(ios.tiltX).toBeCloseTo(w3c.tiltX, 6);
    expect(gravityHemisphere(-1)).toBe(1);
    expect(gravityHemisphere(1)).toBe(-1);
  });

  it('a different natural grip reads level after calibration', () => {
    const t = tiltFor(0, -25, 0, -25);
    expect(Math.abs(t.tiltY)).toBeLessThan(1.5 * DEG);
  });
});

// ---------------------------------------------------------------------------

describe('angle gestures — 下に傾けると入水、上に傾けるとすくう', () => {
  const feed = (
    g: GestureDetector,
    pitchDeg: (i: number) => number,
    frames: number,
    t0 = 0,
  ): { t: number; events: string[]; liftFrames: number } => {
    let t = t0;
    const events: string[] = [];
    let liftFrames = 0;
    let prev = pitchDeg(0) * DEG;
    for (let i = 0; i < frames; i++) {
      const tiltY = pitchDeg(i) * DEG;
      const rate = (tiltY - prev) / DT;
      prev = tiltY;
      const out = g.update({ tiltY, pitchRate: rate, verticalAcceleration: 0 }, DT, t);
      out.events.forEach((e) => events.push(e.type));
      if (out.isLifting) liftFrames++;
      t += DT;
    }
    return { t, events, liftFrames };
  };

  it('pitch down past the threshold submerges; small pitch does nothing', () => {
    const g = new GestureDetector();
    const small = feed(g, () => -8, 120);
    expect(small.events).not.toContain('SUBMERGE');
    expect(g.output.isSubmerging).toBe(false);

    const g2 = new GestureDetector();
    const deep = feed(g2, (i) => Math.min(16, i * 0.5) * -1, 120);
    expect(deep.events).toContain('SUBMERGE');
    expect(g2.output.isSubmerging).toBe(true);
  });

  it('holding the pitch keeps it in the water for as long as you like', () => {
    const g = new GestureDetector();
    feed(g, () => -18, 60 * 20);
    expect(g.output.isSubmerging).toBe(true);
  });

  it('deeper pitch = deeper poi (the analog height lever)', () => {
    const g = new GestureDetector();
    feed(g, () => -14, 90);
    const shallow = g.output.handOffsetY;
    feed(g, () => -30, 90);
    expect(g.output.handOffsetY).toBeLessThan(shallow);
  });

  it('a SLOW drift up leaves via the gentle path — SETTLE, no billing (§55)', () => {
    const g = new GestureDetector();
    let r = feed(g, () => -18, 60);
    // rise from −18° to +16° over 1.7 s (≈0.35 rad/s): careful and unhurried
    r = feed(g, (i) => -18 + Math.min(34, i * 0.34), 140, r.t);
    expect(r.events).toContain('SETTLE');
    expect(r.events).not.toContain('LIFT');
  });

  it('a brisk-but-controlled tilt-up IS a scoop, billed gently', () => {
    const g = new GestureDetector();
    let r = feed(g, () => -18, 60);
    // ≈ 1.05 rad/s: a clearly intentional scoop, nowhere near a snap
    r = feed(g, (i) => -18 + Math.min(34, i * 1.0), 60, r.t);
    expect(r.events).toContain('LIFT');
    expect(g.output.liftPeakAccel).toBeLessThan(2.4);
  });

  it('a SNAP up is a violent scoop — billed high enough to tear wet paper', () => {
    const g = new GestureDetector();
    let r = feed(g, () => -18, 60);
    // −18° to +22° in ~0.13 s ≈ 5.2 rad/s
    r = feed(g, (i) => -18 + Math.min(40, i * 5), 40, r.t);
    expect(r.events).toContain('LIFT');
    expect(g.output.liftPeakAccel).toBeGreaterThan(4);
  });

  it('returning to neutral leaves the water calmly (SETTLE, no LIFT)', () => {
    const g = new GestureDetector();
    let r = feed(g, () => -16, 90);
    r = feed(g, (i) => -16 + Math.min(14, i * 0.25), 120, r.t); // back to ≈ −2°
    expect(r.events).toContain('SETTLE');
    expect(r.events).not.toContain('LIFT');
    expect(g.output.isSubmerging).toBe(false);
  });

  it('hysteresis: hovering at the threshold cannot flap in and out', () => {
    const g = new GestureDetector();
    const r = feed(g, (i) => -11 + Math.sin(i * 0.7) * 1.5, 60 * 10);
    const submerges = r.events.filter((e) => e === 'SUBMERGE').length;
    expect(submerges).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------

describe('touch steering — 画面の右側を押すと右へ', () => {
  it('has a resting-thumb dead zone and a progressive curve to the edges', () => {
    expect(touchCurve(0)).toBe(0);
    expect(touchCurve(0.1)).toBe(0);
    expect(touchCurve(-0.1)).toBe(0);
    expect(touchCurve(1)).toBeCloseTo(1, 5);
    expect(touchCurve(-1)).toBeCloseTo(-1, 5);
    const mid = touchCurve(0.55);
    expect(mid).toBeGreaterThan(0.05);
    expect(mid).toBeLessThan(0.5);
    let prev = 0;
    for (let v = 0; v <= 1.001; v += 0.05) {
      const c = touchCurve(v);
      expect(c).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = c;
    }
  });
});

// ---------------------------------------------------------------------------

describe('the full chain into the poi simulation', () => {
  const drive = (
    g: GestureDetector,
    poi: PoiSimulation,
    pitchDeg: (i: number) => number,
    frames: number,
    t0: number,
  ): { t: number; resolved: boolean; broke: boolean } => {
    let t = t0;
    let resolved = false;
    let broke = false;
    let prev = pitchDeg(0) * DEG;
    for (let i = 0; i < frames; i++) {
      const tiltY = pitchDeg(i) * DEG;
      const rate = (tiltY - prev) / DT;
      prev = tiltY;
      const out = g.update({ tiltY, pitchRate: rate, verticalAcceleration: 0 }, DT, t);
      poi.setInput(
        input({
          tiltY,
          isSubmerging: out.isSubmerging,
          isLifting: out.isLifting,
          handOffsetY: out.handOffsetY,
          handVelocityY: out.handVelocityY,
          liftPeakAccel: out.liftPeakAccel,
        }),
      );
      for (const e of poi.update(DT, t)) {
        if (e.type === 'LIFT_RESOLVED') resolved = true;
        if (e.type === 'BROKE') broke = true;
      }
      t += DT;
    }
    return { t, resolved, broke };
  };

  it('tilt down → in the water; slow tilt up → a successful, cheap scoop', () => {
    const g = new GestureDetector();
    const poi = new PoiSimulation(1, 0);
    let r = { t: 0, resolved: false, broke: false };
    r = drive(g, poi, (i) => Math.max(-18, -i * 0.6), 120, r.t);
    expect(poi.inWater).toBe(true);
    expect(poi.state).toBe('Submerged');

    r = drive(g, poi, (i) => -18 + Math.min(36, i * 0.3), 240, r.t);
    expect(r.resolved).toBe(true);
    expect(r.broke).toBe(false);
    expect(poi.durability).toBeGreaterThan(88);
    expect(poi.inWater).toBe(false);
  });

  it('a violent snap out of soaked water punishes the paper far beyond a calm scoop (§55)', () => {
    const scoopWithFish = (degPerFrame: number): number => {
      const g = new GestureDetector();
      const poi = new PoiSimulation(1, 0);
      let r = { t: 0, resolved: false, broke: false };
      r = drive(g, poi, () => -18, 60 * 8, r.t); // soak
      poi.carriedWeight = 1.5; // a fish aboard — the load the violence multiplies
      const before = poi.durability;
      r = drive(g, poi, (i) => -18 + Math.min(40, i * degPerFrame), 80, r.t);
      return before - poi.durability;
    };
    const gentle = scoopWithFish(0.67); // ≈0.7 rad/s
    const snap = scoopWithFish(6); // ≈6.3 rad/s
    expect(gentle).toBeLessThan(8);
    expect(snap).toBeGreaterThan(gentle + 10);
  });

  it('touch position → poi position: pressing right glides it right and stops on release', () => {
    // the adapter integrates touchCurve into a virtual position; replicate that
    // exact arithmetic against the poi simulation's absolute mapping
    let pos = 0;
    const SPEED = 0.85;
    for (let i = 0; i < 120; i++) pos = Math.min(1, pos + touchCurve(0.9) * SPEED * DT); // 2 s press near the right edge
    const held = pos;
    for (let i = 0; i < 120; i++) pos = Math.min(1, pos + touchCurve(0) * SPEED * DT); // finger up
    expect(pos).toBe(held);
    expect(pos).toBeGreaterThan(0.5);

    const poi = new PoiSimulation(1, 0);
    poi.setInput(input({ x: pos }));
    for (let i = 0; i < 240; i++) poi.update(DT, i * DT);
    expect(poi.x).toBeGreaterThan(POI_BOUNDS.maxX * 0.4);
    expect(poi.x).toBeLessThanOrEqual(POI_BOUNDS.maxX + 1e-6);
  });
})

describe('the poi mirrors the phone — 上に傾ければ上を向く (venue regression)', () => {
  it('phone nose DOWN → the far edge of the paper dips DOWN (negative tiltX)', () => {
    const poi = new PoiSimulation(1, 0);
    poi.setInput(input({ tiltY: -20 * DEG }));
    for (let i = 0; i < 120; i++) poi.update(DT, i * DT);
    // three.js Rx: a POSITIVE angle lifts the far (−Z) edge, so mirroring the
    // phone requires tiltX to carry the SAME sign as the phone pitch.
    expect(poi.tiltX).toBeLessThan(-0.1);
  });

  it('phone nose UP (the scoop pose) → the far edge rises (positive tiltX)', () => {
    const poi = new PoiSimulation(1, 0);
    poi.setInput(input({ tiltY: 20 * DEG }));
    for (let i = 0; i < 120; i++) poi.update(DT, i * DT);
    expect(poi.tiltX).toBeGreaterThan(0.1);
  });

  it('rolling the phone right keeps dipping the right edge (unchanged axis)', () => {
    const poi = new PoiSimulation(1, 0);
    poi.setInput(input({ tiltX: 20 * DEG }));
    for (let i = 0; i < 120; i++) poi.update(DT, i * DT);
    // Rz with a NEGATIVE angle dips the +X (right) edge.
    expect(poi.tiltZ).toBeLessThan(-0.1);
  });
});
