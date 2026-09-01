import { describe, expect, it } from 'vitest';
import {
  decodeFishPacket,
  decodeInput,
  decodePoiPacket,
  encodeFishPacket,
  encodeInput,
  encodePoiPacket,
  type FishWireSource,
  type PoiWire,
} from '@/network/protocol/codec';

const fish = (id: number): FishWireSource => ({
  id,
  typeIndex: id % 5,
  // stay inside the +-32.7 fixed-point range; the tank is only 15 wide
  x: -6.25 + (id % 100) * 0.01,
  y: -1.234,
  z: 3.5,
  yaw: 1.2345,
  pitch: -0.4,
  roll: 0.25,
  speed01: 0.6,
  animIndex: 2,
  carriedBy: id % 4,
});

describe('fish packet', () => {
  it('round-trips within fixed-point precision', () => {
    const src = [fish(1), fish(2), fish(70000 & 0xffff)];
    const decoded = decodeFishPacket(encodeFishPacket(42, 1234, src));
    expect(decoded).not.toBeNull();
    expect(decoded!.tick).toBe(42);
    expect(decoded!.timeMs).toBe(1234);
    expect(decoded!.fish).toHaveLength(3);
    decoded!.fish.forEach((f, i) => {
      expect(f.x).toBeCloseTo(src[i]!.x, 2);
      expect(f.y).toBeCloseTo(src[i]!.y, 2);
      expect(f.z).toBeCloseTo(src[i]!.z, 2);
      expect(f.yaw).toBeCloseTo(src[i]!.yaw, 3);
      expect(f.pitch).toBeCloseTo(src[i]!.pitch, 1);
      expect(f.speed01).toBeCloseTo(src[i]!.speed01, 2);
      expect(f.carriedBy).toBe(src[i]!.carriedBy);
    });
  });

  it('handles a full 200-fish school', () => {
    const src = Array.from({ length: 200 }, (_, i) => fish(i + 1));
    const buf = encodeFishPacket(1, 0, src);
    expect(buf.byteLength).toBe(12 + 16 * 200);
    expect(decodeFishPacket(buf)!.fish).toHaveLength(200);
  });

  it('rejects truncated or foreign buffers', () => {
    expect(decodeFishPacket(new ArrayBuffer(4))).toBeNull();
    const buf = encodeFishPacket(1, 0, [fish(1)]);
    expect(decodeFishPacket(buf.slice(0, 14))).toBeNull();
    const wrong = new ArrayBuffer(32);
    new DataView(wrong).setUint8(0, 99);
    expect(decodeFishPacket(wrong)).toBeNull();
  });

  it('clamps out-of-range values instead of wrapping', () => {
    const wild = { ...fish(1), x: 9999, yaw: 500, speed01: 42, carriedBy: 900 };
    const f = decodeFishPacket(encodeFishPacket(0, 0, [wild]))!.fish[0]!;
    expect(Math.abs(f.x)).toBeLessThanOrEqual(33);
    expect(Math.abs(f.yaw)).toBeLessThanOrEqual(7);
    expect(f.speed01).toBeLessThanOrEqual(1);
    expect(f.carriedBy).toBeLessThanOrEqual(255);
  });
});

describe('poi packet', () => {
  const poi = (n: number): PoiWire => ({
    playerNumber: n,
    state: 'Submerged',
    x: 1.5,
    y: -0.55,
    z: -2.25,
    tiltX: 0.31,
    tiltZ: -0.22,
    spin: 2.5,
    wetness: 0.73,
    durability: 62,
    carriedFish: 2,
    tear: 0.4,
    vy: -0.8,
  });

  it('round-trips', () => {
    const src = [poi(1), poi(2), poi(3), poi(4)];
    const d = decodePoiPacket(encodePoiPacket(7, 99, src))!;
    expect(d.poi).toHaveLength(4);
    expect(d.poi[0]!.state).toBe('Submerged');
    expect(d.poi[0]!.x).toBeCloseTo(1.5, 2);
    expect(d.poi[0]!.wetness).toBeCloseTo(0.73, 1);
    expect(d.poi[0]!.durability).toBe(62);
    expect(d.poi[0]!.tear).toBeCloseTo(0.4, 1);
    expect(d.poi[0]!.vy).toBeCloseTo(-0.8, 2);
  });

  it('survives an empty poi list', () => {
    expect(decodePoiPacket(encodePoiPacket(0, 0, []))!.poi).toHaveLength(0);
  });
});

describe('input packet', () => {
  it('round-trips every field including the gesture flags', () => {
    const src = {
      timeMs: 123456,
      x: -0.4321,
      y: 0.8765,
      tiltX: 0.42,
      tiltY: -0.31,
      tiltZ: 0.11,
      verticalAcceleration: -6.25,
      handOffsetY: -0.085,
      handVelocityY: 0.42,
      liftPeakAccel: 9.5,
      isSubmerging: true,
      isLifting: false,
      shake: 0.35,
    };
    const d = decodeInput(encodeInput(src))!;
    expect(d.x).toBeCloseTo(src.x, 3);
    expect(d.y).toBeCloseTo(src.y, 3);
    expect(d.tiltX).toBeCloseTo(src.tiltX, 3);
    expect(d.verticalAcceleration).toBeCloseTo(src.verticalAcceleration, 2);
    expect(d.handOffsetY).toBeCloseTo(src.handOffsetY, 3);
    expect(d.liftPeakAccel).toBeCloseTo(src.liftPeakAccel, 2);
    expect(d.isSubmerging).toBe(true);
    expect(d.isLifting).toBe(false);
    expect(d.shake).toBeCloseTo(0.35, 2);
  });

  it('accepts a Node Buffer, as socket.io delivers it server-side', () => {
    const ab = encodeInput({
      timeMs: 1,
      x: 0.5,
      y: -0.5,
      tiltX: 0,
      tiltY: 0,
      tiltZ: 0,
      verticalAcceleration: 0,
      handOffsetY: 0,
      handVelocityY: 0,
      liftPeakAccel: 0,
      isSubmerging: false,
      isLifting: true,
      shake: 0,
    });
    const decoded = decodeInput(Buffer.from(ab));
    expect(decoded).not.toBeNull();
    expect(decoded!.x).toBeCloseTo(0.5, 3);
    expect(decoded!.isLifting).toBe(true);
  });

  it('rejects garbage', () => {
    expect(decodeInput(new ArrayBuffer(3))).toBeNull();
  });
});
