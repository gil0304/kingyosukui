/**
 * Capture arbitration (spec §78, §81, §82).
 *
 * Server-authoritative and deliberately conservative: a fish belongs to nobody
 * until a lift actually resolves above the water line. Two poi can reach for the
 * same fish, but only one can be holding it, and the holder is decided by who
 * touched it first — never by a client.
 *
 * [PURE] — no three, no react. Runs inside the Node game server.
 */

import { CAPTURE, POI } from '@/game/core/constants';
import { clamp, createRng, vec3, type Rng, type Vec3 } from '@/game/core/math';
import type { FishSimulation } from '@/game/fish/fishSimulation';
import type { PoiSimulation } from '@/game/poi/poiSimulation';
import type { FishType } from '@/types';

export interface CaptureActor {
  playerNumber: number;
  poi: PoiSimulation;
  /** The poi crossed the lift resolve line this tick. */
  liftResolved: boolean;
  /** The paper tore this tick. */
  broke: boolean;
}

export type DropReason = 'TILT' | 'BREAK' | 'TOO_FAST' | 'TIMEUP' | 'ESCAPE';

export interface CaptureCallbacks {
  onCapture(
    playerNumber: number,
    fishId: number,
    fishType: FishType,
    score: number,
    at: Vec3,
    capturedAt: number,
  ): void;
  onDrop(
    playerNumber: number,
    fishId: number,
    fishType: FishType,
    reason: DropReason,
    at: Vec3,
  ): void;
  onContact(playerNumber: number, fishId: number, at: Vec3): void;
}

interface Claim {
  playerNumber: number;
  /** Server time (seconds) the fish first touched this paper. */
  since: number;
  /** How long it has been riding the paper. */
  age: number;
}

/** A fish that has been sitting on a submerged paper this long may wriggle off. */
const DWELL_BEFORE_ESCAPE = 4.0;
/** Sweeping the poi sideways under water shakes fish off. */
const MAX_SWEEP_SPEED = 5.6;

export class CaptureSystem {
  private readonly fish: FishSimulation;
  private readonly claims = new Map<number, Claim>();
  private readonly candidates: number[] = [];
  private readonly prevX = new Map<number, number>();
  private readonly prevZ = new Map<number, number>();
  private readonly tmp: Vec3 = vec3();
  private readonly point = { x: 0, y: 0, z: 0 };
  private readonly toRelease: number[] = [];
  private rng: Rng;
  /** Monotonic capture sequence — the tie-break of last resort (spec §82). */
  private sequence = 0;
  private enabled = true;

  constructor(fish: FishSimulation, seed = 0x5eed) {
    this.fish = fish;
    this.rng = createRng(seed);
  }

  reset(seed = 0x5eed): void {
    this.claims.clear();
    this.prevX.clear();
    this.prevZ.clear();
    this.sequence = 0;
    this.rng = createRng(seed);
  }

  /** Captures only count during PLAYING; poi may still be moved around otherwise. */
  setEnabled(v: boolean): void {
    this.enabled = v;
  }

  /** Everything currently on a paper falls back into the tank. */
  releaseAll(actors: readonly CaptureActor[], reason: DropReason, cb: CaptureCallbacks): void {
    for (const a of actors) {
      this.releaseCarried(a, reason, cb);
    }
  }

  update(dt: number, t: number, actors: readonly CaptureActor[], cb: CaptureCallbacks): void {
    // 1. Resolve lifts first so a fish that made it out of the water this tick is
    //    scored before anything can knock it off.
    for (const a of actors) {
      if (a.liftResolved && a.poi.carried.length > 0) {
        this.resolveLift(a, t, cb);
      }
    }

    // 2. A torn paper drops everything (spec §56).
    for (const a of actors) {
      if (a.broke && a.poi.carried.length > 0) {
        this.releaseCarried(a, 'BREAK', cb);
      }
    }

    // 3. New contacts. Actors are visited in a stable order, and an existing claim
    //    is never stolen, so "first to touch it" wins deterministically.
    if (this.enabled) {
      for (const a of actors) {
        this.collect(a, t, cb);
      }
    }

    // 4. Carry, stress and shake-off.
    for (const a of actors) {
      this.carry(a, dt, t, cb);
    }
  }

  private collect(a: CaptureActor, t: number, cb: CaptureCallbacks): void {
    const poi = a.poi;
    if (!poi.active || !poi.inWater) return;
    if (poi.state !== 'Submerged' && poi.state !== 'Entering' && poi.state !== 'Lifting') return;
    // A paper already full stops scooping — real poi hold two or three fish at most.
    if (poi.carried.length >= 3) return;

    const found = this.fish.queryCylinder(
      poi.x,
      poi.y - 0.04,
      poi.z,
      POI.captureRadius,
      POI.captureHeight,
      this.candidates,
    );

    for (let i = 0; i < found.length; i++) {
      const id = found[i]!;
      if (this.claims.has(id)) continue;
      if (!this.fish.isSwimming(id)) continue;

      this.claims.set(id, { playerNumber: a.playerNumber, since: t, age: 0 });
      this.fish.setCarried(id, a.playerNumber);
      poi.carried.push(id);
      this.fish.getPosition(id, this.tmp);
      cb.onContact(a.playerNumber, id, this.tmp);
      // Impact softens the paper a little (spec §53 FishWeight).
      if (poi.carried.length >= 3) break;
    }
  }

  private carry(a: CaptureActor, dt: number, t: number, cb: CaptureCallbacks): void {
    const poi = a.poi;
    const carried = poi.carried;
    if (carried.length === 0) {
      poi.carriedWeight = 0;
      this.prevX.set(a.playerNumber, poi.x);
      this.prevZ.set(a.playerNumber, poi.z);
      return;
    }

    // Horizontal sweep speed — dragging the poi sideways under water throws fish off.
    const px = this.prevX.get(a.playerNumber) ?? poi.x;
    const pz = this.prevZ.get(a.playerNumber) ?? poi.z;
    const sweep = dt > 1e-5 ? Math.hypot(poi.x - px, poi.z - pz) / dt : 0;
    this.prevX.set(a.playerNumber, poi.x);
    this.prevZ.set(a.playerNumber, poi.z);

    const tilt = Math.hypot(poi.tiltX, poi.tiltZ);
    this.toRelease.length = 0;

    let weight = 0;
    for (let i = 0; i < carried.length; i++) {
      const id = carried[i]!;
      if (!this.fish.has(id)) {
        this.toRelease.push(id);
        continue;
      }
      const claim = this.claims.get(id);
      if (claim) claim.age += dt;

      weight += this.fish.getWeight(id);

      // Sit the fish on the paper, fanned out and facing along the poi.
      poi.paperPoint(i, carried.length, this.point);
      const yaw = poi.spin + (i - (carried.length - 1) * 0.5) * 0.7;
      this.fish.placeCarried(id, this.point.x, this.point.y, this.point.z, yaw);

      // --- shake-off conditions -------------------------------------------
      if (tilt > CAPTURE.maxTiltBeforeSlide) {
        this.toRelease.push(id);
        continue;
      }
      if (poi.inWater && sweep > MAX_SWEEP_SPEED) {
        this.toRelease.push(id);
        continue;
      }
      // A fish left sitting on a submerged paper eventually wriggles free; the
      // more skittish the fish, the sooner. This is what stops "park the poi
      // under a fish and wait" from being a strategy.
      if (poi.state === 'Submerged' && claim && claim.age > DWELL_BEFORE_ESCAPE) {
        const fear = this.fish.getData(id).fear;
        if (this.rng.next() < fear * 0.26 * dt) {
          this.toRelease.push(id);
          continue;
        }
      }
    }

    poi.carriedWeight = weight;

    for (const id of this.toRelease) {
      const reason: DropReason =
        tilt > CAPTURE.maxTiltBeforeSlide ? 'TILT' : sweep > MAX_SWEEP_SPEED ? 'TOO_FAST' : 'ESCAPE';
      this.detach(a, id, reason, cb);
    }
  }

  private resolveLift(a: CaptureActor, t: number, cb: CaptureCallbacks): void {
    const poi = a.poi;
    // Copy: capture mutates poi.carried.
    const ids = poi.carried.slice();
    for (const id of ids) {
      if (!this.fish.has(id)) {
        this.removeFrom(poi, id);
        this.claims.delete(id);
        continue;
      }
      const data = this.fish.getData(id);
      this.fish.getPosition(id, this.tmp);
      this.sequence++;
      // capturedAt carries the authoritative ordering used to settle any dispute.
      cb.onCapture(a.playerNumber, id, data.type, data.score, this.tmp, t);
      this.claims.delete(id);
      this.removeFrom(poi, id);
      this.fish.captureAndReplace(id);
    }
    poi.carriedWeight = 0;
  }

  private releaseCarried(a: CaptureActor, reason: DropReason, cb: CaptureCallbacks): void {
    const ids = a.poi.carried.slice();
    for (const id of ids) this.detach(a, id, reason, cb);
    a.poi.carriedWeight = 0;
  }

  private detach(a: CaptureActor, id: number, reason: DropReason, cb: CaptureCallbacks): void {
    this.removeFrom(a.poi, id);
    this.claims.delete(id);
    if (!this.fish.has(id)) return;
    const data = this.fish.getData(id);
    this.fish.getPosition(id, this.tmp);
    // Falls with a little of the poi's own downward motion so it reads as physical.
    this.fish.releaseCarried(id, clamp(a.poi.vy, -1.5, 0.4) - 0.35);
    cb.onDrop(a.playerNumber, id, data.type, reason, this.tmp);
  }

  private removeFrom(poi: PoiSimulation, id: number): void {
    const i = poi.carried.indexOf(id);
    if (i >= 0) poi.carried.splice(i, 1);
  }

  /** Total weight riding a paper — the poi simulation needs it for the load model. */
  carriedWeightOf(poi: PoiSimulation): number {
    let w = 0;
    for (const id of poi.carried) {
      if (this.fish.has(id)) w += this.fish.getWeight(id);
    }
    return w;
  }
}
