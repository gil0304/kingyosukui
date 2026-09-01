/**
 * Binary wire codec.
 *
 * Three packet families travel as ArrayBuffers instead of JSON:
 *   FISH  (server -> screen, 30 Hz)  — up to 200 fish, 16 bytes each
 *   POI   (server -> screen, 60 Hz)  — the latency-critical path
 *   INPUT (phone  -> server, 60 Hz)
 *
 * Everything is little-endian. Positions are fixed-point i16 at 1/1000 of a
 * world unit (±32.7 units, far larger than the tank) and angles are i16 at
 * 1/5000 rad (±6.55 rad).
 */

import {
  fishAnimFromIndex,
  fishAnimIndex,
  fishTypeFromIndex,
  fishTypeIndex,
  poiStateFromIndex,
  poiStateIndex,
  type FishSnapshot,
  type PoiVerticalState,
} from '@/types';

export const PACKET = {
  FISH: 1,
  POI: 2,
  INPUT: 10,
} as const;

export const PROTOCOL_VERSION = 1;

const POS_SCALE = 1000;
const ANG_SCALE = 5000;
const SMALL_ANG_SCALE = 40;
const ACC_SCALE = 200;
const NORM_SCALE = 10000;

const FISH_HEADER = 12;
const FISH_STRIDE = 16;
const POI_HEADER = 12;
const POI_STRIDE = 20;
const INPUT_SIZE = 26;

const clampI16 = (v: number): number => (v < -32768 ? -32768 : v > 32767 ? 32767 : v | 0);
const clampI8 = (v: number): number => (v < -128 ? -128 : v > 127 ? 127 : v | 0);
const clampU8 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

const putPos = (dv: DataView, o: number, v: number) =>
  dv.setInt16(o, clampI16(Math.round(v * POS_SCALE)), true);
const getPos = (dv: DataView, o: number) => dv.getInt16(o, true) / POS_SCALE;
const putAng = (dv: DataView, o: number, v: number) =>
  dv.setInt16(o, clampI16(Math.round(v * ANG_SCALE)), true);
const getAng = (dv: DataView, o: number) => dv.getInt16(o, true) / ANG_SCALE;

// ---------------------------------------------------------------------------
// FISH
// ---------------------------------------------------------------------------

export interface FishPacket {
  tick: number;
  timeMs: number;
  fish: FishSnapshot[];
}

/** Source shape the server keeps; kept structural so the sim can pass its own objects. */
export interface FishWireSource {
  id: number;
  typeIndex: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  speed01: number;
  animIndex: number;
  carriedBy: number;
}

export const encodeFishPacket = (
  tick: number,
  timeMs: number,
  fish: readonly FishWireSource[],
): ArrayBuffer => {
  const buf = new ArrayBuffer(FISH_HEADER + FISH_STRIDE * fish.length);
  const dv = new DataView(buf);
  dv.setUint8(0, PACKET.FISH);
  dv.setUint8(1, PROTOCOL_VERSION);
  dv.setUint16(2, fish.length, true);
  dv.setUint32(4, tick >>> 0, true);
  dv.setUint32(8, timeMs >>> 0, true);

  for (let i = 0; i < fish.length; i++) {
    const f = fish[i]!;
    const o = FISH_HEADER + i * FISH_STRIDE;
    dv.setUint16(o + 0, f.id & 0xffff, true);
    putPos(dv, o + 2, f.x);
    putPos(dv, o + 4, f.y);
    putPos(dv, o + 6, f.z);
    putAng(dv, o + 8, f.yaw);
    dv.setInt8(o + 10, clampI8(Math.round(f.pitch * SMALL_ANG_SCALE)));
    dv.setInt8(o + 11, clampI8(Math.round(f.roll * SMALL_ANG_SCALE)));
    dv.setUint8(o + 12, clampU8(f.typeIndex));
    dv.setUint8(o + 13, clampU8(f.animIndex));
    dv.setUint8(o + 14, clampU8(Math.round(f.speed01 * 255)));
    dv.setUint8(o + 15, clampU8(f.carriedBy));
  }
  return buf;
};

export const decodeFishPacket = (buf: ArrayBuffer): FishPacket | null => {
  if (buf.byteLength < FISH_HEADER) return null;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== PACKET.FISH) return null;
  const count = dv.getUint16(2, true);
  if (buf.byteLength < FISH_HEADER + FISH_STRIDE * count) return null;

  const fish: FishSnapshot[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const o = FISH_HEADER + i * FISH_STRIDE;
    fish[i] = {
      id: dv.getUint16(o + 0, true),
      x: getPos(dv, o + 2),
      y: getPos(dv, o + 4),
      z: getPos(dv, o + 6),
      yaw: getAng(dv, o + 8),
      pitch: dv.getInt8(o + 10) / SMALL_ANG_SCALE,
      roll: dv.getInt8(o + 11) / SMALL_ANG_SCALE,
      type: fishTypeFromIndex(dv.getUint8(o + 12)),
      state: fishAnimFromIndex(dv.getUint8(o + 13)),
      speed01: dv.getUint8(o + 14) / 255,
      carriedBy: dv.getUint8(o + 15),
    };
  }
  return { tick: dv.getUint32(4, true), timeMs: dv.getUint32(8, true), fish };
};

/** Convenience for tests / bots that build snapshots from the public shape. */
export const toWireSource = (f: FishSnapshot): FishWireSource => ({
  id: f.id,
  typeIndex: fishTypeIndex(f.type),
  x: f.x,
  y: f.y,
  z: f.z,
  yaw: f.yaw,
  pitch: f.pitch,
  roll: f.roll,
  speed01: f.speed01,
  animIndex: fishAnimIndex(f.state),
  carriedBy: f.carriedBy,
});

// ---------------------------------------------------------------------------
// POI
// ---------------------------------------------------------------------------

export interface PoiWire {
  playerNumber: number;
  state: PoiVerticalState;
  x: number;
  y: number;
  z: number;
  /** Tilt around the X axis (nose down/up). */
  tiltX: number;
  /** Tilt around the Z axis (roll left/right). */
  tiltZ: number;
  /** Spin around Y. */
  spin: number;
  /** 0..1 */
  wetness: number;
  /** 0..100 */
  durability: number;
  carriedFish: number;
  /** 0..1 hole size */
  tear: number;
  /** Vertical velocity, world units/s. */
  vy: number;
}

export interface PoiPacket {
  tick: number;
  timeMs: number;
  poi: PoiWire[];
}

export const encodePoiPacket = (
  tick: number,
  timeMs: number,
  poi: readonly PoiWire[],
): ArrayBuffer => {
  const buf = new ArrayBuffer(POI_HEADER + POI_STRIDE * poi.length);
  const dv = new DataView(buf);
  dv.setUint8(0, PACKET.POI);
  dv.setUint8(1, PROTOCOL_VERSION);
  dv.setUint16(2, poi.length, true);
  dv.setUint32(4, tick >>> 0, true);
  dv.setUint32(8, timeMs >>> 0, true);

  for (let i = 0; i < poi.length; i++) {
    const p = poi[i]!;
    const o = POI_HEADER + i * POI_STRIDE;
    dv.setUint8(o + 0, clampU8(p.playerNumber));
    dv.setUint8(o + 1, poiStateIndex(p.state));
    putPos(dv, o + 2, p.x);
    putPos(dv, o + 4, p.y);
    putPos(dv, o + 6, p.z);
    putAng(dv, o + 8, p.tiltX);
    putAng(dv, o + 10, p.tiltZ);
    putAng(dv, o + 12, p.spin);
    dv.setUint8(o + 14, clampU8(Math.round(p.wetness * 255)));
    dv.setUint8(o + 15, clampU8(Math.round(p.durability)));
    dv.setUint8(o + 16, clampU8(p.carriedFish));
    dv.setUint8(o + 17, clampU8(Math.round(p.tear * 255)));
    dv.setInt16(o + 18, clampI16(Math.round(p.vy * POS_SCALE)), true);
  }
  return buf;
};

export const decodePoiPacket = (buf: ArrayBuffer): PoiPacket | null => {
  if (buf.byteLength < POI_HEADER) return null;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== PACKET.POI) return null;
  const count = dv.getUint16(2, true);
  if (buf.byteLength < POI_HEADER + POI_STRIDE * count) return null;

  const poi: PoiWire[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const o = POI_HEADER + i * POI_STRIDE;
    poi[i] = {
      playerNumber: dv.getUint8(o + 0),
      state: poiStateFromIndex(dv.getUint8(o + 1)),
      x: getPos(dv, o + 2),
      y: getPos(dv, o + 4),
      z: getPos(dv, o + 6),
      tiltX: getAng(dv, o + 8),
      tiltZ: getAng(dv, o + 10),
      spin: getAng(dv, o + 12),
      wetness: dv.getUint8(o + 14) / 255,
      durability: dv.getUint8(o + 15),
      carriedFish: dv.getUint8(o + 16),
      tear: dv.getUint8(o + 17) / 255,
      vy: dv.getInt16(o + 18, true) / POS_SCALE,
    };
  }
  return { tick: dv.getUint32(4, true), timeMs: dv.getUint32(8, true), poi };
};

// ---------------------------------------------------------------------------
// CONTROLLER INPUT
// ---------------------------------------------------------------------------

export interface InputWire {
  timeMs: number;
  x: number;
  y: number;
  tiltX: number;
  tiltY: number;
  tiltZ: number;
  verticalAcceleration: number;
  handOffsetY: number;
  handVelocityY: number;
  liftPeakAccel: number;
  isSubmerging: boolean;
  isLifting: boolean;
  shake: number;
}

export const encodeInput = (i: InputWire): ArrayBuffer => {
  const buf = new ArrayBuffer(INPUT_SIZE);
  const dv = new DataView(buf);
  dv.setUint8(0, PACKET.INPUT);
  dv.setUint8(1, PROTOCOL_VERSION);
  dv.setUint8(2, (i.isSubmerging ? 1 : 0) | (i.isLifting ? 2 : 0));
  dv.setUint8(3, clampU8(Math.round(i.shake * 255)));
  dv.setUint32(4, i.timeMs >>> 0, true);
  dv.setInt16(8, clampI16(Math.round(i.x * NORM_SCALE)), true);
  dv.setInt16(10, clampI16(Math.round(i.y * NORM_SCALE)), true);
  putAng(dv, 12, i.tiltX);
  putAng(dv, 14, i.tiltY);
  putAng(dv, 16, i.tiltZ);
  dv.setInt16(18, clampI16(Math.round(i.verticalAcceleration * ACC_SCALE)), true);
  dv.setInt16(20, clampI16(Math.round(i.handOffsetY * POS_SCALE)), true);
  dv.setInt16(22, clampI16(Math.round(i.handVelocityY * POS_SCALE)), true);
  dv.setInt16(24, clampI16(Math.round(i.liftPeakAccel * ACC_SCALE)), true);
  return buf;
};

export const decodeInput = (buf: ArrayBuffer | Buffer | Uint8Array): InputWire | null => {
  const ab =
    buf instanceof ArrayBuffer
      ? buf
      : (buf.buffer as ArrayBuffer).slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  if (ab.byteLength < INPUT_SIZE) return null;
  const dv = new DataView(ab);
  if (dv.getUint8(0) !== PACKET.INPUT) return null;
  const flags = dv.getUint8(2);
  return {
    isSubmerging: (flags & 1) !== 0,
    isLifting: (flags & 2) !== 0,
    shake: dv.getUint8(3) / 255,
    timeMs: dv.getUint32(4, true),
    x: dv.getInt16(8, true) / NORM_SCALE,
    y: dv.getInt16(10, true) / NORM_SCALE,
    tiltX: getAng(dv, 12),
    tiltY: getAng(dv, 14),
    tiltZ: getAng(dv, 16),
    verticalAcceleration: dv.getInt16(18, true) / ACC_SCALE,
    handOffsetY: dv.getInt16(20, true) / POS_SCALE,
    handVelocityY: dv.getInt16(22, true) / POS_SCALE,
    liftPeakAccel: dv.getInt16(24, true) / ACC_SCALE,
  };
};

export const packetSizes = { FISH_HEADER, FISH_STRIDE, POI_HEADER, POI_STRIDE, INPUT_SIZE };
