import { describe, expect, it } from 'vitest';

import { NET, TANK } from '@/game/core/constants';
import {
  encodeFishPacket,
  encodePoiPacket,
  type FishWireSource,
  type PoiWire,
} from '@/network/protocol/codec';
import { FishSnapshotBuffer, PoiStateBuffer } from '@/network/state/snapshotBuffer';

const DELAY = NET.fishInterpolationDelay;

const fish = (over: Partial<FishWireSource> = {}): FishWireSource => ({
  id: 1,
  typeIndex: 0,
  x: 0,
  y: -1,
  z: 0,
  yaw: 0,
  pitch: 0,
  roll: 0,
  speed01: 0.5,
  animIndex: 0,
  carriedBy: 0,
  ...over,
});

const poi = (over: Partial<PoiWire> = {}): PoiWire => ({
  playerNumber: 1,
  state: 'Above',
  x: 0,
  y: 0.5,
  z: 0,
  tiltX: 0,
  tiltZ: 0,
  spin: 0,
  wetness: 0,
  durability: 100,
  carriedFish: 0,
  tear: 0,
  vy: 0,
  ...over,
});

// ---------------------------------------------------------------------------

describe('FishSnapshotBuffer', () => {
  it('interpolates between the two frames that bracket the render time', () => {
    const buf = new FishSnapshotBuffer();
    buf.push(encodeFishPacket(1, 0, [fish({ x: 0, z: 2, speed01: 0 })]), 1.0);
    buf.push(encodeFishPacket(2, 33, [fish({ x: 1, z: 3, speed01: 1 })]), 1.1);

    // renderTime = 1.05 -> exactly half way between the two frames.
    const out = buf.sample(1.05 + DELAY);
    expect(out).toHaveLength(1);
    const f = out[0];
    expect(f.x).toBeGreaterThan(0);
    expect(f.x).toBeLessThan(1);
    expect(f.x).toBeCloseTo(0.5, 3);
    expect(f.z).toBeCloseTo(2.5, 3);
    expect(f.speed01).toBeCloseTo(0.5, 2);
    expect(f.id).toBe(1);
  });

  it('lands on each end of the span at the ends of the interpolation window', () => {
    const buf = new FishSnapshotBuffer();
    buf.push(encodeFishPacket(1, 0, [fish({ x: 0 })]), 1.0);
    buf.push(encodeFishPacket(2, 33, [fish({ x: 2 })]), 1.2);

    expect(buf.sample(1.0 + DELAY)[0].x).toBeCloseTo(0, 3);
    // A quarter of the way along the span.
    expect(buf.sample(1.05 + DELAY)[0].x).toBeCloseTo(0.5, 2);
    expect(buf.sample(1.2 + DELAY)[0].x).toBeCloseTo(2, 3);
  });

  it('returns an empty array before any data has arrived', () => {
    const buf = new FishSnapshotBuffer();
    expect(buf.sample(0)).toEqual([]);
    expect(buf.sample(12.5)).toEqual([]);
    expect(buf.lastTick).toBe(0);
    expect(buf.fps).toBe(0);
  });

  it('shows the single frame it has, both before and after its timestamp', () => {
    const buf = new FishSnapshotBuffer();
    buf.push(encodeFishPacket(7, 0, [fish({ x: -3.25, y: -0.5, z: 1.5, yaw: 0.5 })]), 1.0);

    const early = buf.sample(1.0);
    expect(early).toHaveLength(1);
    expect(early[0].x).toBeCloseTo(-3.25, 3);

    const late = buf.sample(5.0);
    expect(late).toHaveLength(1);
    expect(late[0].x).toBeCloseTo(-3.25, 3);
    expect(late[0].y).toBeCloseTo(-0.5, 3);
    expect(late[0].z).toBeCloseTo(1.5, 3);
    expect(late[0].yaw).toBeCloseTo(0.5, 3);
    expect(buf.lastTick).toBe(7);
  });

  it('shows a fish that only exists in the newer frame at its own position', () => {
    const buf = new FishSnapshotBuffer();
    buf.push(encodeFishPacket(1, 0, [fish({ id: 1, x: 0 })]), 1.0);
    buf.push(
      encodeFishPacket(2, 33, [fish({ id: 1, x: 1 }), fish({ id: 2, x: 4, typeIndex: 4 })]),
      1.1,
    );

    const out = buf.sample(1.05 + DELAY);
    expect(out).toHaveLength(2);
    const byId = new Map(out.map((f) => [f.id, { x: f.x, type: f.type }]));
    expect(byId.get(1)?.x).toBeCloseTo(0.5, 3);
    // Nothing to interpolate from, so it is drawn exactly where it was sent.
    expect(byId.get(2)?.x).toBeCloseTo(4, 3);
    expect(byId.get(2)?.type).toBe('gold');
  });

  it('drops out-of-order and duplicate ticks', () => {
    const buf = new FishSnapshotBuffer();
    buf.push(encodeFishPacket(5, 0, [fish({ x: 1 })]), 1.0);
    buf.push(encodeFishPacket(3, 0, [fish({ x: -6 })]), 1.05); // stale
    buf.push(encodeFishPacket(5, 0, [fish({ x: -6 })]), 1.06); // duplicate

    expect(buf.lastTick).toBe(5);
    const out = buf.sample(2.0);
    expect(out).toHaveLength(1);
    expect(out[0].x).toBeCloseTo(1, 3);
  });

  it('interpolates yaw the short way around the +-pi wrap', () => {
    const buf = new FishSnapshotBuffer();
    buf.push(encodeFishPacket(1, 0, [fish({ yaw: 3.0 })]), 1.0);
    buf.push(encodeFishPacket(2, 33, [fish({ yaw: -3.0 })]), 1.1);

    const yaw = buf.sample(1.05 + DELAY)[0].yaw;
    // Going the long way would pass through 0; the short way passes through pi.
    expect(Math.abs(yaw)).toBeGreaterThan(3.0);
    expect(Math.abs(yaw)).toBeCloseTo(Math.PI, 3);
  });

  it('does not grow without bound when fed hundreds of frames', () => {
    const buf = new FishSnapshotBuffer();
    const step = 1 / 30;
    for (let i = 0; i < 300; i++) {
      buf.push(encodeFishPacket(i + 1, i * 33, [fish({ x: i * 0.02 })]), i * step);
    }

    expect(buf.lastTick).toBe(300);
    // Roughly one second of 30 Hz history is what the rate meter sees.
    expect(buf.fps).toBeGreaterThan(25);
    expect(buf.fps).toBeLessThan(36);

    // Asking for a render time from the distant past can only return the oldest
    // frame still held. If nothing had been discarded that would be x ~ 0.6
    // (the frame at t = 1 s); a bounded buffer answers with a far later one.
    const stale = buf.sample(1.0 + DELAY);
    expect(stale).toHaveLength(1);
    expect(stale[0].x).toBeGreaterThan(4);

    // The newest data is still exact.
    const fresh = buf.sample(300 * step + DELAY);
    expect(fresh[0].x).toBeCloseTo(299 * 0.02, 2);
  });

  it('forgets everything on clear()', () => {
    const buf = new FishSnapshotBuffer();
    buf.push(encodeFishPacket(4, 0, [fish({ x: 2 })]), 1.0);
    expect(buf.sample(1.5)).toHaveLength(1);

    buf.clear();
    expect(buf.sample(1.5)).toEqual([]);
    expect(buf.lastTick).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('PoiStateBuffer', () => {
  const DT = 1 / 60;

  it('starts on the first packet and then eases toward each new target', () => {
    const buf = new PoiStateBuffer();
    buf.push(encodePoiPacket(1, 0, [poi({ x: 0 })]), 0);
    expect(buf.sample(0, DT)[0].x).toBeCloseTo(0, 4);

    buf.push(encodePoiPacket(2, 16, [poi({ x: 4 })]), 0.016);

    const xs: number[] = [];
    for (let i = 0; i < 40; i++) xs.push(buf.sample(0.016 + i * DT, DT)[0].x);

    // It moves immediately, but it does not teleport.
    expect(xs[0]).toBeGreaterThan(0);
    expect(xs[0]).toBeLessThan(4);
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1]);
      expect(xs[i]).toBeLessThanOrEqual(4.0001);
    }
    expect(xs[xs.length - 1]).toBeCloseTo(4, 2);
  });

  it('passes the paper condition through untouched, with no smoothing', () => {
    const buf = new PoiStateBuffer();
    buf.push(encodePoiPacket(1, 0, [poi({ durability: 100, wetness: 0 })]), 0);
    buf.sample(0, DT);
    buf.push(
      encodePoiPacket(2, 16, [poi({ durability: 41, wetness: 0.75, tear: 0.5, state: 'Submerged', carriedFish: 3 })]),
      0.016,
    );

    const p = buf.sample(0.016, DT)[0];
    expect(p.durability).toBe(41);
    expect(p.wetness).toBeCloseTo(0.75, 2);
    expect(p.tear).toBeCloseTo(0.5, 2);
    expect(p.state).toBe('Submerged');
    expect(p.carriedFish).toBe(3);
  });

  it('drops a poi that disappears from the packet', () => {
    const buf = new PoiStateBuffer();
    buf.push(
      encodePoiPacket(1, 0, [poi({ playerNumber: 1, x: -2 }), poi({ playerNumber: 2, x: 2 })]),
      0,
    );
    expect(buf.sample(0, DT).map((p) => p.playerNumber)).toEqual([1, 2]);
    expect(buf.get(1)).toBeDefined();

    buf.push(encodePoiPacket(2, 16, [poi({ playerNumber: 2, x: 2 })]), 0.016);
    const out = buf.sample(0.016, DT);
    expect(out).toHaveLength(1);
    expect(out[0].playerNumber).toBe(2);
    expect(buf.get(1)).toBeUndefined();
    expect(buf.get(2)).toBeDefined();
  });

  it('returns the poi sorted by player number whatever order they arrive in', () => {
    const buf = new PoiStateBuffer();
    buf.push(
      encodePoiPacket(1, 0, [
        poi({ playerNumber: 3 }),
        poi({ playerNumber: 1 }),
        poi({ playerNumber: 4 }),
        poi({ playerNumber: 2 }),
      ]),
      0,
    );
    expect(buf.sample(0, DT).map((p) => p.playerNumber)).toEqual([1, 2, 3, 4]);
  });

  it('clamps a wild position back inside the tank', () => {
    const buf = new PoiStateBuffer();
    buf.push(encodePoiPacket(1, 0, [poi({ x: 30, z: 20 })]), 0);

    const p = buf.sample(0, DT)[0];
    expect(p.x).toBeLessThanOrEqual(TANK.halfWidth);
    expect(p.x).toBeCloseTo(TANK.halfWidth, 5);
    expect(p.z).toBeLessThanOrEqual(TANK.halfDepth);
    expect(p.z).toBeCloseTo(TANK.halfDepth, 5);
  });

  it('ignores a packet that arrives out of order', () => {
    const buf = new PoiStateBuffer();
    buf.push(encodePoiPacket(10, 0, [poi({ x: 1 })]), 0);
    buf.push(encodePoiPacket(5, 0, [poi({ x: -6 })]), 0.016);

    let x = 0;
    for (let i = 0; i < 60; i++) x = buf.sample(i * DT, DT)[0].x;
    expect(x).toBeCloseTo(1, 3);
  });

  it('ignores a foreign or truncated buffer', () => {
    const buf = new PoiStateBuffer();
    buf.push(new ArrayBuffer(4), 0);
    expect(buf.sample(0, DT)).toEqual([]);

    const good = encodePoiPacket(1, 0, [poi({ x: 1 })]);
    buf.push(good.slice(0, 16), 0);
    expect(buf.sample(0, DT)).toEqual([]);

    buf.push(good, 0);
    expect(buf.sample(0, DT)).toHaveLength(1);
  });

  it('forgets everything on clear()', () => {
    const buf = new PoiStateBuffer();
    buf.push(encodePoiPacket(1, 0, [poi({ x: 1 })]), 0);
    buf.sample(0, DT);

    buf.clear();
    expect(buf.sample(0, DT)).toEqual([]);
    expect(buf.get(1)).toBeUndefined();
  });
});
