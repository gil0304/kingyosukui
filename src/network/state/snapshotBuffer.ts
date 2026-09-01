'use client';

/**
 * Turns the server's discrete snapshots into something smooth to render.
 *
 * Fish arrive at 30 Hz and are interpolated with a small delay
 * (NET.fishInterpolationDelay) so there are always two samples to blend.
 * Poi arrive at 60 Hz and are only lightly smoothed — the delay a player feels
 * between moving their phone and seeing their poi move is the single most
 * important quality of the piece (spec §39), so it must not be buffered.
 */

import { NET, TANK } from '@/game/core/constants';
import { angleLerp, clamp, damp, lerp } from '@/game/core/math';
import { decodeFishPacket, decodePoiPacket, type PoiWire } from '@/network/protocol/codec';
import type { FishSnapshot } from '@/types';

export interface InterpolatedFish extends FishSnapshot {}

interface FishFrame {
  /** Client clock (seconds) when this frame was received. */
  t: number;
  tick: number;
  byId: Map<number, FishSnapshot>;
  list: FishSnapshot[];
}

/**
 * Deep enough to hold ~1.3 s of 30 Hz history. The screen briefly slows its fish
 * clock for the capture beat (spec §79), which walks the sample point backwards —
 * a shallow buffer would run dry mid-effect.
 */
const MAX_FRAMES = 40;

export class FishSnapshotBuffer {
  private frames: FishFrame[] = [];
  private out: InterpolatedFish[] = [];
  private lastTickSeen = 0;
  private rateWindow: number[] = [];
  private observedFps = 0;

  push(buf: ArrayBuffer, nowSeconds: number): void {
    const packet = decodeFishPacket(buf);
    if (!packet) return;
    // Out-of-order delivery is possible over polling transport; drop stale frames.
    if (packet.tick <= this.lastTickSeen && this.frames.length > 0) return;
    this.lastTickSeen = packet.tick;

    const byId = new Map<number, FishSnapshot>();
    for (const f of packet.fish) byId.set(f.id, f);
    this.frames.push({ t: nowSeconds, tick: packet.tick, byId, list: packet.fish });
    if (this.frames.length > MAX_FRAMES) this.frames.shift();

    this.rateWindow.push(nowSeconds);
    while (this.rateWindow.length > 1 && nowSeconds - this.rateWindow[0]! > 1) {
      this.rateWindow.shift();
    }
    this.observedFps = this.rateWindow.length;
  }

  sample(nowSeconds: number): InterpolatedFish[] {
    if (this.frames.length === 0) {
      this.out.length = 0;
      return this.out;
    }

    const renderTime = nowSeconds - NET.fishInterpolationDelay;

    // Find the pair that brackets renderTime.
    let older: FishFrame | null = null;
    let newer: FishFrame | null = null;
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i]!;
      if (f.t <= renderTime) {
        older = f;
        newer = this.frames[i + 1] ?? null;
        break;
      }
    }

    // Not enough history yet (or we fell behind): show the newest frame straight.
    if (!older) {
      const latest = this.frames[0]!;
      return this.copyInto(latest.list);
    }
    if (!newer) {
      const latest = this.frames[this.frames.length - 1]!;
      return this.copyInto(latest.list);
    }

    const span = newer.t - older.t;
    const t = span > 1e-5 ? clamp((renderTime - older.t) / span, 0, 1) : 1;

    this.ensure(newer.list.length);
    let n = 0;
    for (const b of newer.list) {
      const a = older.byId.get(b.id);
      const dst = this.out[n]!;
      if (!a) {
        assign(dst, b);
      } else {
        dst.id = b.id;
        dst.type = b.type;
        dst.state = b.state;
        dst.carriedBy = b.carriedBy;
        dst.x = lerp(a.x, b.x, t);
        dst.y = lerp(a.y, b.y, t);
        dst.z = lerp(a.z, b.z, t);
        dst.yaw = angleLerp(a.yaw, b.yaw, t);
        dst.pitch = lerp(a.pitch, b.pitch, t);
        dst.roll = lerp(a.roll, b.roll, t);
        dst.speed01 = lerp(a.speed01, b.speed01, t);
      }
      n++;
    }
    this.out.length = n;

    // Prune frames we can no longer need.
    while (this.frames.length > 2 && nowSeconds - this.frames[0]!.t > NET.snapshotBufferSeconds) {
      this.frames.shift();
    }
    return this.out;
  }

  private copyInto(list: FishSnapshot[]): InterpolatedFish[] {
    this.ensure(list.length);
    for (let i = 0; i < list.length; i++) assign(this.out[i]!, list[i]!);
    this.out.length = list.length;
    return this.out;
  }

  private ensure(n: number): void {
    while (this.out.length < n) {
      this.out.push({
        id: 0,
        type: 'red',
        x: 0,
        y: 0,
        z: 0,
        yaw: 0,
        pitch: 0,
        roll: 0,
        speed01: 0,
        state: 'IdleSwim',
        carriedBy: 0,
      });
    }
  }

  clear(): void {
    this.frames.length = 0;
    this.out.length = 0;
    this.lastTickSeen = 0;
  }

  get lastTick(): number {
    return this.lastTickSeen;
  }

  get fps(): number {
    return this.observedFps;
  }
}

const assign = (dst: FishSnapshot, src: FishSnapshot): void => {
  dst.id = src.id;
  dst.type = src.type;
  dst.x = src.x;
  dst.y = src.y;
  dst.z = src.z;
  dst.yaw = src.yaw;
  dst.pitch = src.pitch;
  dst.roll = src.roll;
  dst.speed01 = src.speed01;
  dst.state = src.state;
  dst.carriedBy = src.carriedBy;
};

// ---------------------------------------------------------------------------

const clonePoi = (src: PoiWire): PoiWire => ({ ...src });

export class PoiStateBuffer {
  /** Latest authoritative values. */
  private target = new Map<number, PoiWire>();
  /** What we actually draw — chases the target with a very short time constant. */
  private smoothed = new Map<number, PoiWire>();
  private out: PoiWire[] = [];
  private lastTickSeen = 0;

  push(buf: ArrayBuffer, _nowSeconds: number): void {
    const packet = decodePoiPacket(buf);
    if (!packet) return;
    if (packet.tick < this.lastTickSeen) return;
    this.lastTickSeen = packet.tick;

    const seen = new Set<number>();
    for (const p of packet.poi) {
      seen.add(p.playerNumber);
      const existing = this.target.get(p.playerNumber);
      if (existing) Object.assign(existing, p);
      else this.target.set(p.playerNumber, clonePoi(p));
    }
    for (const key of [...this.target.keys()]) {
      if (!seen.has(key)) {
        this.target.delete(key);
        this.smoothed.delete(key);
      }
    }
  }

  sample(_nowSeconds: number, dt: number): PoiWire[] {
    const k = NET.poiSmoothing;
    this.out.length = 0;
    for (const [num, tgt] of this.target) {
      let cur = this.smoothed.get(num);
      if (!cur) {
        cur = clonePoi(tgt);
        this.smoothed.set(num, cur);
      } else {
        cur.x = damp(cur.x, tgt.x, k, dt);
        cur.y = damp(cur.y, tgt.y, k, dt);
        cur.z = damp(cur.z, tgt.z, k, dt);
        cur.tiltX = damp(cur.tiltX, tgt.tiltX, k, dt);
        cur.tiltZ = damp(cur.tiltZ, tgt.tiltZ, k, dt);
        cur.spin = angleLerp(cur.spin, tgt.spin, 1 - Math.exp(-dt / k));
        // Paper condition is authoritative: no smoothing, it must read instantly.
        cur.wetness = tgt.wetness;
        cur.durability = tgt.durability;
        cur.tear = tgt.tear;
        cur.state = tgt.state;
        cur.carriedFish = tgt.carriedFish;
        cur.vy = damp(cur.vy, tgt.vy, 0.06, dt);
        cur.playerNumber = num;
      }
      // A malformed packet must never fling a poi outside the tank.
      cur.x = clamp(cur.x, -TANK.halfWidth, TANK.halfWidth);
      cur.z = clamp(cur.z, -TANK.halfDepth, TANK.halfDepth);
      this.out.push(cur);
    }
    this.out.sort((a, b) => a.playerNumber - b.playerNumber);
    return this.out;
  }

  get(playerNumber: number): PoiWire | undefined {
    return this.smoothed.get(playerNumber);
  }

  clear(): void {
    this.target.clear();
    this.smoothed.clear();
    this.out.length = 0;
    this.lastTickSeen = 0;
  }
}
