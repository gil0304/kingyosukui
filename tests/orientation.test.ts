/**
 * Orientation conventions across module boundaries.
 *
 * The fish geometry is +X-forward but the simulation reports headings in a
 * +Z-forward frame, and the poi renderer must compose its Euler angles in the
 * same order the capture system uses to place fish on the paper. Both are silent
 * failures — the fish simply swim sideways, or a carried fish floats off the
 * paper — so both conventions are pinned here.
 */

import { describe, expect, it } from 'vitest';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';

import { FishSimulation } from '@/game/fish/fishSimulation';
import { PoiSimulation, type PoiInput } from '@/game/poi/poiSimulation';
import { POI } from '@/game/core/constants';
import { vec3, wrapAngle } from '@/game/core/math';

const DT = 1 / 60;
const HALF_PI = Math.PI / 2;

/** Exactly the transform src/game/fish/FishSchool.tsx builds per instance. */
const fishForward = (yaw: number, pitch: number, roll: number): Vector3 => {
  const e = new Euler(roll, yaw - HALF_PI, -pitch, 'YZX');
  const q = new Quaternion().setFromEuler(e);
  // The geometry's nose is +X.
  return new Vector3(1, 0, 0).applyQuaternion(q);
};

describe('fish heading (simulation -> renderer)', () => {
  it('the rendered nose points along the direction the fish is actually moving', () => {
    const sim = new FishSimulation(120, 2024);
    for (let i = 0; i < 400; i++) sim.update(DT, []);

    const before = new Map<number, { x: number; y: number; z: number }>();
    for (const f of sim.getWire()) before.set(f.id, { x: f.x, y: f.y, z: f.z });
    for (let i = 0; i < 6; i++) sim.update(DT, []);

    const dots: number[] = [];
    for (const f of sim.getWire()) {
      const p0 = before.get(f.id);
      if (!p0) continue;
      const vx = f.x - p0.x;
      const vz = f.z - p0.z;
      const horiz = Math.hypot(vx, vz);
      // Vertical-only motion carries no heading information, and the turn rate
      // limiter means a hard-turning fish lags its velocity by design.
      if (horiz < 1e-4) continue;

      const nose = fishForward(f.yaw, f.pitch, f.roll);
      const noseH = Math.hypot(nose.x, nose.z);
      dots.push((nose.x * vx + nose.z * vz) / (horiz * noseH));
    }

    expect(dots.length).toBeGreaterThan(80);
    dots.sort((a, b) => a - b);
    // If the +X / +Z frames were confused the whole school would sit near 0.
    expect(dots[Math.floor(dots.length / 2)]!).toBeGreaterThan(0.99);
    expect(dots[0]!).toBeGreaterThan(0.5);
  });

  it('the nose pitches the same way the fish is actually moving vertically', () => {
    const sim = new FishSimulation(120, 4711);
    for (let i = 0; i < 400; i++) sim.update(DT, []);
    const before = new Map<number, number>();
    for (const f of sim.getWire()) before.set(f.id, f.y);
    for (let i = 0; i < 10; i++) sim.update(DT, []);

    let agree = 0;
    let total = 0;
    for (const f of sim.getWire()) {
      const y0 = before.get(f.id);
      if (y0 === undefined) continue;
      const dy = f.y - y0;
      if (Math.abs(dy) < 0.004) continue;
      total++;
      if (Math.sign(fishForward(f.yaw, f.pitch, f.roll).y) === Math.sign(dy)) agree++;
    }
    expect(total).toBeGreaterThan(10);
    expect(agree / total).toBeGreaterThan(0.85);
  });

  it('yaw follows the +Z-forward convention the renderer compensates for', () => {
    const sim = new FishSimulation(30, 99);
    for (let i = 0; i < 300; i++) sim.update(DT, []);
    for (const f of sim.getWire()) {
      const nose = fishForward(f.yaw, 0, 0);
      // Ry(yaw - PI/2) . +X  ==  (sin yaw, 0, cos yaw)
      expect(nose.x).toBeCloseTo(Math.sin(f.yaw), 5);
      expect(nose.z).toBeCloseTo(Math.cos(f.yaw), 5);
      expect(nose.y).toBeCloseTo(0, 5);
    }
  });

  it('a rising fish points its nose up, a diving fish points it down', () => {
    expect(fishForward(0, -0.5, 0).y).toBeGreaterThan(0.3); // pitch is negative when rising
    expect(fishForward(0, 0.5, 0).y).toBeLessThan(-0.3);
    expect(fishForward(1.2, -0.4, 0.2).y).toBeGreaterThan(0);
  });

  it('every heading round-trips: nose direction recovers the yaw', () => {
    for (let yaw = -Math.PI; yaw < Math.PI; yaw += 0.37) {
      const nose = fishForward(yaw, 0, 0);
      expect(Math.abs(wrapAngle(Math.atan2(nose.x, nose.z) - yaw))).toBeLessThan(1e-6);
    }
  });
});

describe('poi paper frame (simulation -> renderer)', () => {
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

  /** Exactly the transform src/game/poi/PoiView.tsx applies to the poi root. */
  const renderPaperPoint = (poi: PoiSimulation, local: Vector3): Vector3 => {
    const e = new Euler(poi.tiltX, poi.spin, poi.tiltZ, 'XZY');
    const m = new Matrix4().compose(
      new Vector3(poi.x, poi.y, poi.z),
      new Quaternion().setFromEuler(e),
      new Vector3(1, 1, 1),
    );
    return local.clone().applyMatrix4(m);
  };

  it('a carried fish sits exactly where the renderer draws the paper, even when tilted', () => {
    const poi = new PoiSimulation(1, 0);
    // Push it into a strongly tilted, spun pose.
    poi.setInput(input({ x: 0.4, y: -0.3, tiltX: -0.6, tiltY: 0.55, tiltZ: 0.9 }));
    for (let i = 0; i < 400; i++) poi.update(DT, i * DT);
    expect(Math.abs(poi.tiltX) + Math.abs(poi.tiltZ)).toBeGreaterThan(0.3);

    for (const count of [1, 2, 3]) {
      for (let i = 0; i < count; i++) {
        const out = { x: 0, y: 0, z: 0 };
        poi.paperPoint(i, count, out);

        // Rebuild the same local offset the simulation used, then push it
        // through the renderer's transform. The two must agree.
        const world = renderPaperPoint(poi, localPaperOffset(i, count));
        expect(world.x).toBeCloseTo(out.x, 6);
        expect(world.y).toBeCloseTo(out.y, 6);
        expect(world.z).toBeCloseTo(out.z, 6);
      }
    }
  });

  it('a single carried fish sits on the centre of the paper', () => {
    const poi = new PoiSimulation(1, 0);
    for (let i = 0; i < 60; i++) poi.update(DT, i * DT);
    const out = { x: 0, y: 0, z: 0 };
    poi.paperPoint(0, 1, out);
    expect(Math.hypot(out.x - poi.x, out.z - poi.z)).toBeLessThan(0.02);
    expect(out.y).toBeGreaterThan(poi.y);
  });

  it('several carried fish are spread across the paper, all within its rim', () => {
    const poi = new PoiSimulation(1, 0);
    for (let i = 0; i < 60; i++) poi.update(DT, i * DT);
    const pts: { x: number; z: number }[] = [];
    for (let i = 0; i < 3; i++) {
      const out = { x: 0, y: 0, z: 0 };
      poi.paperPoint(i, 3, out);
      expect(Math.hypot(out.x - poi.x, out.z - poi.z)).toBeLessThan(POI.paperRadius);
      pts.push({ x: out.x, z: out.z });
    }
    expect(Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.z - pts[1]!.z)).toBeGreaterThan(0.1);
  });
});

/** Mirrors the local offset PoiSimulation.paperPoint() starts from. */
const TAU = Math.PI * 2;
const PAPER_SIT_HEIGHT = 0.045;
function localPaperOffset(index: number, count: number): Vector3 {
  const n = Math.max(1, Math.floor(count));
  const i = Math.min(Math.max(Math.floor(index), 0), n - 1);
  if (n === 1) return new Vector3(0, PAPER_SIT_HEIGHT, 0);
  const r = POI.paperRadius * (n <= 4 ? 0.42 : 0.56);
  const a = (i / n) * TAU + (n % 2 === 0 ? Math.PI / n : 0);
  return new Vector3(Math.cos(a) * r, PAPER_SIT_HEIGHT, Math.sin(a) * r);
}

/** Keep the unused import honest — vec3 is the sim's own vector helper. */
void vec3;
