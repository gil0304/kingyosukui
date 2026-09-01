/**
 * The authoritative goldfish simulation (spec §70–§77).
 *
 * [PURE] This ticks at 60 Hz inside the Node.js game server, so it must stay
 * free of 'three', React and browser globals. Storage is structure-of-arrays
 * over typed arrays sized once to 'GAME.maxFishCount', and 'update()' performs
 * zero allocations — at 200 fish the GC must never be the reason a frame is
 * late.
 *
 * Orientation convention: a fish model faces **+Z**. 'yaw' is the three.js
 * Y-Euler ('atan2(vx, vz)'), 'pitch' is the X-Euler — which means a *rising*
 * fish has a *negative* pitch — and 'roll' is the Z-Euler, negative when the
 * fish banks to its right. Renderers can feed these straight into
 * 'Euler(pitch, yaw, roll, 'YXZ')'.
 */

import { FISH_BOUNDS, GAME, POI_BOUNDS } from '@/game/core/constants';
import {
  clamp,
  clamp01,
  createRng,
  damp,
  lerp,
  noise1,
  rotateTowards,
  smoothstep,
  wrapAngle,
  vset,
  TAU,
  type Rng,
  type Vec3,
} from '@/game/core/math';
import {
  FISH_CATALOG,
  buildSpawnList,
  getFishData,
  isRare,
  pickFishType,
} from '@/game/fish/fishTypes';
import { DEFAULT_BOID_WEIGHTS, SpatialHash, type BoidWeights } from '@/game/fish/boids';
import {
  FISH_TYPE_ORDER,
  fishAnimFromIndex,
  fishAnimIndex,
  fishTypeFromIndex,
  fishTypeIndex,
  type FishAnimState,
  type FishData,
  type FishType,
} from '@/types';
import type { FishWireSource } from '@/network/protocol/codec';

/** One poi as the fish care about it: a moving thing to be scared of. */
export interface PoiQuery {
  playerNumber: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  inWater: boolean;
  active: boolean;
  speed: number;
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Fixed capacity: every buffer is allocated once at this size (spec §76). */
const CAPACITY = GAME.maxFishCount;

/** Wire ids are uint16 (see 'encodeFishPacket'), so ids must wrap inside 16 bits. */
const MAX_ID = 0xffff;

/** Grid cell for the neighbour hash; comfortably above 'neighborRadius'. */
const CELL_SIZE = 1.2;

const ANIM_IDLE = fishAnimIndex('IdleSwim');
const ANIM_FAST = fishAnimIndex('FastSwim');
const ANIM_ESCAPE = fishAnimIndex('Escape');
const ANIM_CAPTURED = fishAnimIndex('Captured');
const ANIM_DROP = fishAnimIndex('Drop');

/** Catalogue lookup by wire type index — avoids a string hop in the hot loop. */
const DATA_BY_INDEX: readonly FishData[] = FISH_TYPE_ORDER.map((t) => FISH_CATALOG[t]);

/** A long server hitch must never teleport the whole school. */
const MAX_STEP = 0.05;

/** Exponential velocity drag; with the steering forces this sets cruise speed. */
const DRAG = 1.35;
/** Wander steering, scaled by the species cruise speed. */
const WANDER_GAIN = 1.2;
/**
 * Pull toward the fish's personal preferred depth. Deliberately weak: a firm pull
 * flattens all 120 fish onto one plane, and from the screen's low camera a flat
 * layer reads as a solid carpet of fish instead of a tank with depth in it.
 * The species preference should bias a fish, not pin it.
 */
const DEPTH_GAIN = 0.5;
const DEPTH_CLAMP = 0.8;
/** How far a fish slowly drifts above and below its preferred depth. */
const DEPTH_ROAM = 0.55;
/** Distance from a side wall at which repulsion starts. */
const WALL_MARGIN = 0.9;
const WALL_GAIN = 9.0;
/**
 * The fish volume is only ~2 units tall, so the floor/surface margin has to be
 * much tighter — otherwise the repulsion would swallow every depthPreference
 * and the whole school would flatten into one mid-water sheet.
 */
const WALL_MARGIN_Y = 0.32;
const WALL_GAIN_Y = 7.0;
/** Ceiling on the boids term so a dense pocket cannot launch a fish. */
const BOID_MAX_FORCE = 6.0;
/** Ceiling on the total steering force — the last line of defence against NaN. */
const MAX_ACCEL = 26.0;
/**
 * Forward thrust gain. A fish is not a particle pushed around by steering
 * forces — it propels itself along its heading toward a target speed, and the
 * boids/wander/fear terms only decide *where* that heading points. Without
 * this the school drifts at a fraction of its catalogue speed and looks dead.
 */
const THRUST_GAIN = 6.0;
/**
 * Cruise target as a fraction of 'data.speed', and the fraction it rises to
 * under full panic. The idle value sits deliberately below the FastSwim
 * threshold so that only fish actually working — dodging a wall, squeezed by
 * neighbours, chased — switch to the faster tail beat.
 */
const CRUISE_TARGET = 0.78;
const PANIC_TARGET = 2.55;
/** Top speed multiplier while fleeing a poi. */
const ESCAPE_SPEED_MULT = 1.7;
/** How fast the panic level bleeds off once the poi is gone. */
const ESCAPE_DECAY = 1.4;
/** Panic level above which the Escape animation is used. */
const ESCAPE_ANIM = 0.42;
/** Fraction of the current speed ceiling above which FastSwim is used. */
const FAST_ANIM = 0.72;
/** Safety net only; the thrust term is what normally sets the speed. */
const MIN_SPEED_FRACTION = 0.15;
/** Bank angle per rad/s of turn rate, and its ceiling. */
const BANK_PER_RATE = 0.3;
const MAX_ROLL = 0.75;
const MAX_PITCH = 0.62;
/** Gravity for a fish that has been dropped above the water line. */
const GRAVITY = 9.0;
/** Seconds a dropped fish stays dazed once it is back under water. */
const DROP_RECOVERY = 0.9;
/** Panic given to a dropped fish so it bolts instead of loitering. */
const DROP_PANIC = 0.85;
/** Upward drift applied to everyone at TIME UP (spec §102). */
const CALM_RISE = 0.85;
const CALM_SPEED_SCALE = 0.5;
/** Above this school size the neighbour query is staggered over two ticks (§77). */
const STAGGER_THRESHOLD = 80;
/**
 * Slow drift the fish simply do not count as movement. Below this the poi is
 * as good as motionless, which stops a hand tremor from flipping the whole
 * school between "curious" and "terrified".
 */
const STILL_TOLERANCE = 1.35;
/** Poi speed at which the fear multiplier starts climbing at all. */
const FEAR_SPEED_FLOOR = 0.35;
/** Curiosity attraction gain — what makes the 出目金 catchable (spec §73). */
const CURIOSITY_GAIN = 2.6;
/**
 * How much an investigating fish throttles back. Attraction alone is not
 * enough: a fish cruising at speed simply arcs past the poi. Slowing down is
 * what produces the moment the whole game hangs on — a fish hovering just over
 * the paper while the player decides when to lift.
 */
const CURIOSITY_SLOWDOWN = 0.6;
/**
 * Poi speed (units/s) at which it stops counting as "still". Deliberately
 * generous: nobody holds a phone perfectly steady, and a hand-tremor cliff
 * between "catchable" and "not" would feel broken rather than difficult.
 */
const STILL_SPEED = 2.0;

export interface RareSpawn {
  id: number;
  type: FishType;
  x: number;
  y: number;
  z: number;
}

// ---------------------------------------------------------------------------

export class FishSimulation {
  // --- structure of arrays, all sized CAPACITY -----------------------------
  private readonly px = new Float32Array(CAPACITY);
  private readonly py = new Float32Array(CAPACITY);
  private readonly pz = new Float32Array(CAPACITY);
  private readonly vx = new Float32Array(CAPACITY);
  private readonly vy = new Float32Array(CAPACITY);
  private readonly vz = new Float32Array(CAPACITY);
  private readonly yaw = new Float32Array(CAPACITY);
  private readonly pitch = new Float32Array(CAPACITY);
  private readonly roll = new Float32Array(CAPACITY);
  private readonly speed01 = new Float32Array(CAPACITY);

  /** Cached boids force, reused on the ticks the neighbour query is skipped. */
  private readonly steerX = new Float32Array(CAPACITY);
  private readonly steerY = new Float32Array(CAPACITY);
  private readonly steerZ = new Float32Array(CAPACITY);

  private readonly wanderPhase = new Float32Array(CAPACITY);
  /** Personal preferred depth (world y) derived from 'data.depthPreference'. */
  private readonly targetY = new Float32Array(CAPACITY);
  /** Personality seeds: no two fish of a species behave identically. */
  private readonly speedScale = new Float32Array(CAPACITY);
  private readonly fearScale = new Float32Array(CAPACITY);
  private readonly curiosityScale = new Float32Array(CAPACITY);
  /** 0..1 panic level, drives the Escape animation and the speed ceiling. */
  private readonly panic = new Float32Array(CAPACITY);
  /** Seconds left of the dazed period after being dropped. */
  private readonly recovery = new Float32Array(CAPACITY);

  private readonly typeIdx = new Uint8Array(CAPACITY);
  private readonly anim = new Uint8Array(CAPACITY);
  private readonly carriedBy = new Uint8Array(CAPACITY);
  private readonly alive = new Uint8Array(CAPACITY);
  /** 0 or 1 — which tick parity runs this fish's neighbour query (spec §77). */
  private readonly stagger = new Uint8Array(CAPACITY);

  private readonly fishId = new Int32Array(CAPACITY);
  /** uint16 id -> slot, or -1. O(1) getters without a Map. */
  private readonly idToSlot = new Int32Array(MAX_ID + 1);

  /** Scratch for neighbour / cylinder queries. Never escapes the class. */
  private readonly neighbors = new Int32Array(CAPACITY);

  private readonly hash = new SpatialHash(
    FISH_BOUNDS.minX - 0.6,
    FISH_BOUNDS.minY - 0.6,
    FISH_BOUNDS.minZ - 0.6,
    FISH_BOUNDS.maxX + 0.6,
    // Dropped fish briefly live above the water line; keep them inside the grid.
    POI_BOUNDS.maxY + 0.6,
    FISH_BOUNDS.maxZ + 0.6,
    CELL_SIZE,
  );

  private readonly weights: BoidWeights = { ...DEFAULT_BOID_WEIGHTS };

  /** Reused wire objects — 'getWire()' mutates these in place. */
  private readonly wirePool: FishWireSource[] = [];
  private readonly wire: FishWireSource[] = [];

  private rng: Rng = createRng(1);
  private liveCount = 0;
  private nextId = 1;
  private time = 0;
  private tickIndex = 0;
  private calm = false;
  private rareSpawns: RareSpawn[] = [];

  constructor(count: number, seed: number) {
    for (let i = 0; i < CAPACITY; i++) {
      this.wirePool.push({
        id: 0,
        typeIndex: 0,
        x: 0,
        y: 0,
        z: 0,
        yaw: 0,
        pitch: 0,
        roll: 0,
        speed01: 0,
        animIndex: 0,
        carriedBy: 0,
      });
    }
    this.reset(count, seed);
  }

  get count(): number {
    return this.liveCount;
  }

  reset(count: number, seed: number): void {
    this.rng = createRng(seed >>> 0);
    const n = clamp(Math.floor(count) || 0, 0, CAPACITY);

    this.idToSlot.fill(-1);
    this.alive.fill(0);
    this.liveCount = n;
    this.nextId = 1;
    this.time = 0;
    this.tickIndex = 0;
    this.calm = false;
    this.rareSpawns = [];

    // buildSpawnList honours the FISH_CATALOG spawn rates and is deterministic
    // for a given seed, so a replay of the same round produces the same school.
    const types = buildSpawnList(n, this.rng);
    for (let i = 0; i < n; i++) this.spawnInto(i, types[i], false);

    this.wire.length = n;
    for (let i = 0; i < n; i++) this.wire[i] = this.wirePool[i];

    this.rebuildHash();
  }

  // -------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------

  update(dt: number, poi: readonly PoiQuery[]): void {
    const step = clamp(dt, 0, MAX_STEP);
    if (!(step > 0)) return;

    this.time += step;
    this.tickIndex = (this.tickIndex + 1) & 0xffff;

    const t = this.time;
    const n = this.liveCount;
    const calm = this.calm;
    const parity = this.tickIndex & 1;
    const staggered = n > STAGGER_THRESHOLD;
    const poiCount = poi.length;

    for (let i = 0; i < n; i++) {
      if (this.alive[i] === 0) continue;
      const anim = this.anim[i];
      // A carried fish is driven entirely by 'placeCarried' (spec §80).
      if (anim === ANIM_CAPTURED) continue;

      const data = DATA_BY_INDEX[this.typeIdx[i]];
      let px = this.px[i];
      let py = this.py[i];
      let pz = this.pz[i];
      let vx = this.vx[i];
      let vy = this.vy[i];
      let vz = this.vz[i];

      // --- airborne after a tear: pure ballistics until it splashes back in --
      if (anim === ANIM_DROP && py > FISH_BOUNDS.maxY) {
        vy -= GRAVITY * step;
        vx *= 0.985;
        vz *= 0.985;
        px += vx * step;
        py += vy * step;
        pz += vz * step;
        px = clamp(px, FISH_BOUNDS.minX, FISH_BOUNDS.maxX);
        pz = clamp(pz, FISH_BOUNDS.minZ, FISH_BOUNDS.maxZ);
        // A falling fish tumbles; that reads as helpless, which is the point.
        const wp = this.wanderPhase[i];
        this.roll[i] = noise1(t * 6.5 + wp) * 0.55;
        this.pitch[i] = clamp(-Math.atan2(vy, 0.6), -1.1, 1.1);
        this.px[i] = px;
        this.py[i] = py;
        this.pz[i] = pz;
        this.vx[i] = vx;
        this.vy[i] = vy;
        this.vz[i] = vz;
        this.speed01[i] = 0.9;
        continue;
      }

      let ax = 0;
      let ay = 0;
      let az = 0;

      // --- 1. Boids (spec §72) ---------------------------------------------
      // Above ~80 fish the neighbour query runs on alternate ticks per fish and
      // the previous force is reused; at 60 Hz the difference is invisible.
      if (!staggered || this.stagger[i] === parity) {
        this.computeBoids(i, data, px, py, pz, vx, vy, vz);
      }
      ax += this.steerX[i];
      ay += this.steerY[i];
      az += this.steerZ[i];

      // --- 2. Wander: a private idle path per fish --------------------------
      const wander = WANDER_GAIN * data.speed;
      const wp = this.wanderPhase[i];
      ax += noise1(t * 0.4 + wp) * wander;
      ay += noise1(t * 0.29 + wp + 41.3) * wander * 0.42;
      az += noise1(t * 0.36 + wp + 87.9) * wander;

      // --- 3. Depth preference ---------------------------------------------
      if (calm) {
        ay += CALM_RISE;
      } else {
        // The preferred depth itself wanders on a slow personal cycle, so the school
        // keeps rearranging through the whole water column rather than settling.
        const roam = noise1(t * 0.05 + wp * 2.7 + 19.4) * DEPTH_ROAM;
        const want = clamp(
          this.targetY[i] + roam,
          FISH_BOUNDS.minY + 0.05,
          FISH_BOUNDS.maxY - 0.05,
        );
        ay += clamp((want - py) * DEPTH_GAIN, -DEPTH_CLAMP, DEPTH_CLAMP);
      }

      // --- 4. Boundary avoidance (smooth, plus a hard clamp below) ----------
      const dxLo = px - FISH_BOUNDS.minX;
      if (dxLo < WALL_MARGIN) ax += (1 - dxLo / WALL_MARGIN) * WALL_GAIN;
      const dxHi = FISH_BOUNDS.maxX - px;
      if (dxHi < WALL_MARGIN) ax -= (1 - dxHi / WALL_MARGIN) * WALL_GAIN;
      const dzLo = pz - FISH_BOUNDS.minZ;
      if (dzLo < WALL_MARGIN) az += (1 - dzLo / WALL_MARGIN) * WALL_GAIN;
      const dzHi = FISH_BOUNDS.maxZ - pz;
      if (dzHi < WALL_MARGIN) az -= (1 - dzHi / WALL_MARGIN) * WALL_GAIN;
      const dyLo = py - FISH_BOUNDS.minY;
      if (dyLo < WALL_MARGIN_Y) ay += (1 - dyLo / WALL_MARGIN_Y) * WALL_GAIN_Y;
      const dyHi = FISH_BOUNDS.maxY - py;
      if (dyHi < WALL_MARGIN_Y) ay -= (1 - dyHi / WALL_MARGIN_Y) * WALL_GAIN_Y;

      // --- 5/6. Poi fear and curiosity (spec §73) --------------------------
      let panic = 0;
      let investigate = 0;
      if (!calm && poiCount > 0) {
        const fear = clamp01(data.fear * this.fearScale[i]);
        const curiosity = clamp01(data.curiosity * this.curiosityScale[i]);
        // Higher-fear fish notice a poi from much further away, which is why
        // the black and gold fish are genuinely hard to catch.
        // Festival tuning: fish notice the poi late and close. The rare fish
        // still flee first (fear scales the radius), but nobody outruns a
        // patient player any more.
        const detectBase = 0.95 + fear * 1.55;

        for (let k = 0; k < poiCount; k++) {
          const p = poi[k];
          if (!p.active) continue;
          const detect = p.inWater ? detectBase : detectBase * 0.55;
          const dx = px - p.x;
          const dy = py - p.y;
          const dz = pz - p.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (!(d2 < detect * detect)) continue;
          const d = Math.max(Math.sqrt(d2), 1e-3);
          const inv = 1 / d;
          const closeness = 1 - d / detect;
          const still = 1 - clamp01(p.speed / STILL_SPEED);
          const stillSoft = clamp01(still * STILL_TOLERANCE);

          // Curiosity (spec §73). Resolved first because an interested fish
          // discounts the threat: without that, fear puts a repulsive shell
          // exactly where the capture cylinder is and nothing is ever
          // catchable by holding the poi still — which is the whole game.
          let interest = 0;
          if (p.inWater && stillSoft > 0.05 && curiosity > 0.05) {
            // Inner cutoff only stops the pull collapsing to a point; it is
            // well inside the paper so the fish can sit right on top of it.
            const near = smoothstep(p.radius * 0.08, p.radius * 0.55, d);
            const far = 1 - smoothstep(detect * 0.75, detect * 1.05, d);
            interest = curiosity * stillSoft * near * far;
            if (interest > investigate) investigate = interest;
          }

          // A poi swept through the water is far scarier than one resting.
          let f = closeness * closeness * (1.1 + fear * 2.6);
          f *= 0.5 + clamp01((p.speed - FEAR_SPEED_FLOOR) / 3.0) * 1.5;
          if (!p.inWater) f *= 0.28;
          f *= 1 - 0.9 * interest;
          // Close range: a resting poi is just scenery, a moving one is a wall
          // of paper coming at you.
          if (d < p.radius + 0.25) f *= 1 + (1 - still);

          ax += dx * inv * f;
          // Never launch a fish out of the water: damp the upward component.
          ay += dy * inv * f * (dy > 0 ? 0.45 : 0.85);
          az += dz * inv * f;

          // A fish that is investigating is not fleeing, so it keeps its idle
          // animation instead of flickering into Escape.
          const seen = closeness * (p.inWater ? 1 : 0.35) * (1 - interest);
          if (seen > panic) panic = seen;

          if (interest > 0) {
            const g = interest * CURIOSITY_GAIN;
            ax -= dx * inv * g;
            ay -= dy * inv * g * 0.7;
            az -= dz * inv * g;
          }
        }
      }

      // Panic decays smoothly so a fish keeps bolting after the poi withdraws.
      const decayed = this.panic[i] - step * ESCAPE_DECAY;
      const esc = clamp01(panic > decayed ? panic : decayed);
      this.panic[i] = esc;

      // --- 7. Thrust + integrate --------------------------------------------
      // Swim drive: push along the current heading toward the target speed.
      const sp0 = Math.sqrt(vx * vx + vy * vy + vz * vz);
      const cruise = data.speed * this.speedScale[i];
      let target = cruise * lerp(CRUISE_TARGET, PANIC_TARGET, esc);
      // An interested fish throttles back so it can hang over the paper.
      if (investigate > 0) target *= 1 - CURIOSITY_SLOWDOWN * clamp01(investigate);
      if (calm) target *= CALM_SPEED_SCALE;
      const deficit = (target - sp0) * THRUST_GAIN;
      if (sp0 > 1e-4) {
        const inv0 = 1 / sp0;
        ax += vx * inv0 * deficit;
        ay += vy * inv0 * deficit * 0.6;
        az += vz * inv0 * deficit;
      } else {
        const h = this.yaw[i];
        ax += Math.sin(h) * deficit;
        az += Math.cos(h) * deficit;
      }

      const a2 = ax * ax + ay * ay + az * az;
      if (!(a2 >= 0)) {
        ax = 0;
        ay = 0;
        az = 0;
      } else if (a2 > MAX_ACCEL * MAX_ACCEL) {
        const s = MAX_ACCEL / Math.sqrt(a2);
        ax *= s;
        ay *= s;
        az *= s;
      }

      vx = (vx + ax * step) * Math.exp(-step * DRAG);
      vy = (vy + ay * step) * Math.exp(-step * DRAG);
      vz = (vz + az * step) * Math.exp(-step * DRAG);
      if (!(vx * vx + vy * vy + vz * vz >= 0)) {
        vx = 0;
        vy = 0;
        vz = 0;
      }

      let maxSpeed = cruise * lerp(1, ESCAPE_SPEED_MULT, esc);
      if (calm) maxSpeed *= CALM_SPEED_SCALE;

      let sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (sp > maxSpeed) {
        const s = maxSpeed / sp;
        vx *= s;
        vy *= s;
        vz *= s;
        sp = maxSpeed;
      }
      const minSpeed = maxSpeed * MIN_SPEED_FRACTION;
      if (sp < minSpeed) {
        if (sp > 1e-4) {
          const s = minSpeed / sp;
          vx *= s;
          vy *= s;
          vz *= s;
        } else {
          // Dead stop: nudge it forward along its current heading.
          const y = this.yaw[i];
          vx = Math.sin(y) * minSpeed;
          vy = 0;
          vz = Math.cos(y) * minSpeed;
        }
        sp = minSpeed;
      }

      px += vx * step;
      py += vy * step;
      pz += vz * step;

      // Hard clamp: whatever the forces did, a fish never leaves the tank.
      if (!(px >= FISH_BOUNDS.minX)) {
        px = FISH_BOUNDS.minX;
        if (vx < 0) vx = -vx * 0.35;
      } else if (px > FISH_BOUNDS.maxX) {
        px = FISH_BOUNDS.maxX;
        if (vx > 0) vx = -vx * 0.35;
      }
      if (!(pz >= FISH_BOUNDS.minZ)) {
        pz = FISH_BOUNDS.minZ;
        if (vz < 0) vz = -vz * 0.35;
      } else if (pz > FISH_BOUNDS.maxZ) {
        pz = FISH_BOUNDS.maxZ;
        if (vz > 0) vz = -vz * 0.35;
      }
      if (!(py >= FISH_BOUNDS.minY)) {
        py = FISH_BOUNDS.minY;
        if (vy < 0) vy = -vy * 0.35;
      } else if (py > FISH_BOUNDS.maxY) {
        py = FISH_BOUNDS.maxY;
        if (vy > 0) vy = -vy * 0.35;
      }

      this.px[i] = px;
      this.py[i] = py;
      this.pz[i] = pz;
      this.vx[i] = vx;
      this.vy[i] = vy;
      this.vz[i] = vz;

      // --- heading, pitch and bank ------------------------------------------
      const prevYaw = this.yaw[i];
      const targetYaw = Math.atan2(vx, vz);
      const turnLimit = data.turnSpeed * (1 + esc * 0.7) * step;
      const newYaw = rotateTowards(prevYaw, targetYaw, turnLimit);
      this.yaw[i] = newYaw;

      const turnRate = wrapAngle(newYaw - prevYaw) / step;
      // A fish leans into a turn — that lean is what reads as alive from
      // across a room, far more than the tail beat does.
      const targetRoll = clamp(-turnRate * BANK_PER_RATE, -MAX_ROLL, MAX_ROLL);
      this.roll[i] = damp(this.roll[i], targetRoll, 0.13, step);

      const horiz = Math.sqrt(vx * vx + vz * vz);
      const targetPitch = clamp(-Math.atan2(vy, Math.max(horiz, 1e-3)), -MAX_PITCH, MAX_PITCH);
      this.pitch[i] = damp(this.pitch[i], targetPitch, 0.1, step);

      // --- 8. Animation state (spec §75) ------------------------------------
      if (anim === ANIM_DROP) {
        const left = this.recovery[i] - step;
        this.recovery[i] = left;
        if (left <= 0) this.anim[i] = esc > ESCAPE_ANIM ? ANIM_ESCAPE : ANIM_IDLE;
      } else if (esc > ESCAPE_ANIM) {
        this.anim[i] = ANIM_ESCAPE;
      } else if (sp > maxSpeed * FAST_ANIM) {
        this.anim[i] = ANIM_FAST;
      } else {
        this.anim[i] = ANIM_IDLE;
      }

      this.speed01[i] = clamp01(sp / (data.speed * ESCAPE_SPEED_MULT));
    }

    // Rebuilt at the END of the tick so both the boids pass on the next tick
    // and the capture system's 'queryCylinder' this tick see current positions.
    this.rebuildHash();
  }

  /**
   * Separation / alignment / cohesion for one fish, written into the cached
   * steering arrays. Alignment and cohesion scale with the species 'schooling'
   * value; separation never does.
   */
  private computeBoids(
    i: number,
    data: FishData,
    px: number,
    py: number,
    pz: number,
    vx: number,
    vy: number,
    vz: number,
  ): void {
    const w = this.weights;
    const found = this.hash.query(px, py, pz, w.neighborRadius, this.neighbors);
    const nr2 = w.neighborRadius * w.neighborRadius;
    const sr = w.separationRadius;
    const sr2 = sr * sr;
    const myType = this.typeIdx[i];

    let sepX = 0;
    let sepY = 0;
    let sepZ = 0;
    let avX = 0;
    let avY = 0;
    let avZ = 0;
    let avW = 0;
    let coX = 0;
    let coY = 0;
    let coZ = 0;
    let coW = 0;

    for (let k = 0; k < found; k++) {
      const j = this.neighbors[k];
      if (j === i || this.alive[j] === 0) continue;
      if (this.anim[j] === ANIM_CAPTURED) continue;

      const dx = px - this.px[j];
      const dy = py - this.py[j];
      const dz = pz - this.pz[j];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > nr2 || d2 < 1e-9) continue;

      if (d2 < sr2) {
        const d = Math.sqrt(d2);
        // 1/d falloff that reaches exactly zero at the separation radius, so
        // there is no discontinuity as a neighbour drifts out of range.
        const push = (sr - d) / (sr * d);
        sepX += dx * push;
        sepY += dy * push;
        sepZ += dz * push;
      }

      // Same species school tightly; mixed species only loosely acknowledge
      // each other, which keeps the five types visually distinguishable.
      const kin = this.typeIdx[j] === myType ? 1 : 0.3;
      avX += this.vx[j] * kin;
      avY += this.vy[j] * kin;
      avZ += this.vz[j] * kin;
      avW += kin;
      coX += this.px[j] * kin;
      coY += this.py[j] * kin;
      coZ += this.pz[j] * kin;
      coW += kin;
    }

    let fx = sepX * w.separation;
    let fy = sepY * w.separation;
    let fz = sepZ * w.separation;

    const school = data.schooling;
    if (avW > 0 && school > 0) {
      const al = (w.alignment * school) / avW;
      fx += (avX - vx * avW) * al;
      fy += (avY - vy * avW) * al * 0.7;
      fz += (avZ - vz * avW) * al;
    }
    if (coW > 0 && school > 0) {
      const invW = 1 / coW;
      const cx = coX * invW - px;
      const cy = coY * invW - py;
      const cz = coZ * invW - pz;
      const cd = Math.sqrt(cx * cx + cy * cy + cz * cz);
      if (cd > 1e-4) {
        const co = (w.cohesion * school * Math.min(cd, 1)) / cd;
        fx += cx * co;
        fy += cy * co * 0.7;
        fz += cz * co;
      }
    }

    const m2 = fx * fx + fy * fy + fz * fz;
    if (!(m2 >= 0)) {
      fx = 0;
      fy = 0;
      fz = 0;
    } else if (m2 > BOID_MAX_FORCE * BOID_MAX_FORCE) {
      const s = BOID_MAX_FORCE / Math.sqrt(m2);
      fx *= s;
      fy *= s;
      fz *= s;
    }

    this.steerX[i] = fx;
    this.steerY[i] = fy;
    this.steerZ[i] = fz;
  }

  private rebuildHash(): void {
    this.hash.clear();
    const n = this.liveCount;
    for (let i = 0; i < n; i++) {
      if (this.alive[i] === 0) continue;
      // Carried fish are glued to a poi; they are not neighbours and they are
      // not catchable, so they stay out of the grid entirely.
      if (this.anim[i] === ANIM_CAPTURED) continue;
      this.hash.insert(i, this.px[i], this.py[i], this.pz[i]);
    }
  }

  // -------------------------------------------------------------------------
  // Wire
  // -------------------------------------------------------------------------

  /** Reused array — do not retain across ticks. */
  getWire(): FishWireSource[] {
    const n = this.liveCount;
    for (let i = 0; i < n; i++) {
      const w = this.wire[i];
      w.id = this.fishId[i];
      w.typeIndex = this.typeIdx[i];
      w.x = this.px[i];
      w.y = this.py[i];
      w.z = this.pz[i];
      w.yaw = this.yaw[i];
      w.pitch = this.pitch[i];
      w.roll = this.roll[i];
      w.speed01 = this.speed01[i];
      w.animIndex = this.anim[i];
      w.carriedBy = this.carriedBy[i];
    }
    return this.wire;
  }

  // -------------------------------------------------------------------------
  // Lookups
  // -------------------------------------------------------------------------

  has(id: number): boolean {
    return this.slotOf(id) >= 0;
  }

  isSwimming(id: number): boolean {
    const s = this.slotOf(id);
    if (s < 0) return false;
    const a = this.anim[s];
    return a === ANIM_IDLE || a === ANIM_FAST || a === ANIM_ESCAPE;
  }

  getType(id: number): FishType {
    const s = this.slotOf(id);
    return s < 0 ? 'red' : fishTypeFromIndex(this.typeIdx[s]);
  }

  getData(id: number): FishData {
    const s = this.slotOf(id);
    return s < 0 ? getFishData('red') : DATA_BY_INDEX[this.typeIdx[s]];
  }

  getWeight(id: number): number {
    return this.getData(id).weight;
  }

  getPosition(id: number, out: Vec3): Vec3 {
    const s = this.slotOf(id);
    if (s < 0) return vset(out, 0, 0, 0);
    return vset(out, this.px[s], this.py[s], this.pz[s]);
  }

  /** Animation state as seen by the screen, useful for debugging and tests. */
  getAnim(id: number): FishAnimState {
    const s = this.slotOf(id);
    return fishAnimFromIndex(s < 0 ? ANIM_IDLE : this.anim[s]);
  }

  getCarriedBy(id: number): number {
    const s = this.slotOf(id);
    return s < 0 ? 0 : this.carriedBy[s];
  }

  setAnim(id: number, anim: FishAnimState): void {
    const s = this.slotOf(id);
    if (s < 0) return;
    this.anim[s] = fishAnimIndex(anim);
  }

  // -------------------------------------------------------------------------
  // Carrying
  // -------------------------------------------------------------------------

  /** Mark a fish as sitting on a poi ('playerNumber' 0 releases it). */
  setCarried(id: number, playerNumber: number): void {
    const s = this.slotOf(id);
    if (s < 0) return;
    if (playerNumber > 0) {
      this.carriedBy[s] = playerNumber & 0xff;
      this.anim[s] = ANIM_CAPTURED;
      this.vx[s] = 0;
      this.vy[s] = 0;
      this.vz[s] = 0;
      this.steerX[s] = 0;
      this.steerY[s] = 0;
      this.steerZ[s] = 0;
      this.panic[s] = 0;
      this.recovery[s] = 0;
    } else {
      this.carriedBy[s] = 0;
      if (this.anim[s] === ANIM_CAPTURED) this.anim[s] = ANIM_IDLE;
    }
  }

  /**
   * The paper tore or the poi tilted too far: the fish falls. It keeps its
   * position and falls from there — never a teleport back into the school
   * (spec §80) — and stays dazed for a moment before swimming off.
   */
  releaseCarried(id: number, dropVelocityY = -1.6): void {
    const s = this.slotOf(id);
    if (s < 0) return;
    this.carriedBy[s] = 0;
    this.anim[s] = ANIM_DROP;
    // Deterministic scatter from the fish's own phase — no rng draw here, so
    // gameplay events cannot desynchronise the spawn stream.
    const wp = this.wanderPhase[s];
    this.vx[s] = noise1(this.time * 3.1 + wp) * 0.55;
    this.vz[s] = noise1(this.time * 2.7 + wp + 55.5) * 0.55;
    this.vy[s] = dropVelocityY;
    this.recovery[s] = DROP_RECOVERY;
    this.panic[s] = DROP_PANIC;
    this.steerX[s] = 0;
    this.steerY[s] = 0;
    this.steerZ[s] = 0;
  }

  /** Drive a carried fish's transform from the poi. */
  placeCarried(id: number, x: number, y: number, z: number, yaw: number): void {
    const s = this.slotOf(id);
    if (s < 0) return;
    this.px[s] = x;
    this.py[s] = y;
    this.pz[s] = z;
    this.yaw[s] = yaw;
    this.vx[s] = 0;
    this.vy[s] = 0;
    this.vz[s] = 0;
    // A fish on wet paper flops rather than swims.
    const wp = this.wanderPhase[s];
    this.roll[s] = noise1(this.time * 5.5 + wp) * 0.22;
    this.pitch[s] = noise1(this.time * 4.1 + wp + 13.7) * 0.14;
    this.speed01[s] = 0.85;
  }

  /** Remove after a successful capture and spawn a replacement (school stays full). */
  captureAndReplace(id: number): void {
    const s = this.slotOf(id);
    if (s < 0) return;
    this.idToSlot[id & MAX_ID] = -1;
    const type = pickFishType(this.rng);
    this.spawnInto(s, type, true);
    if (isRare(type)) {
      this.rareSpawns.push({
        id: this.fishId[s],
        type,
        x: this.px[s],
        y: this.py[s],
        z: this.pz[s],
      });
    }
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /** Fish ids currently swimming inside the cylinder (centre, radius, +height). */
  queryCylinder(
    x: number,
    y: number,
    z: number,
    radius: number,
    height: number,
    out: number[],
  ): number[] {
    out.length = 0;
    const yLo = Math.min(y, y + height);
    const yHi = Math.max(y, y + height);
    const halfH = (yHi - yLo) * 0.5;
    const cy = yLo + halfH;
    // A sphere that fully encloses the cylinder — the grid only ever gives us
    // candidates, the exact test below decides.
    const sphere = Math.sqrt(radius * radius + halfH * halfH);
    const found = this.hash.query(x, cy, z, sphere, this.neighbors);
    const r2 = radius * radius;

    for (let k = 0; k < found; k++) {
      const i = this.neighbors[k];
      if (this.alive[i] === 0) continue;
      const a = this.anim[i];
      if (a !== ANIM_IDLE && a !== ANIM_FAST && a !== ANIM_ESCAPE) continue;
      const fy = this.py[i];
      if (fy < yLo || fy > yHi) continue;
      const dx = this.px[i] - x;
      const dz = this.pz[i] - z;
      if (dx * dx + dz * dz > r2) continue;
      out.push(this.fishId[i]);
    }
    return out;
  }

  /** Everyone rises and calms down at TIME UP (spec §102). */
  setCalmMode(v: boolean): void {
    this.calm = v;
    if (v) this.panic.fill(0);
  }

  /**
   * Rare fish that appeared since the last call, for the screen's subtle glint
   * (spec §108 — deliberately NOT a giant banner). Only mid-round replacements
   * are reported; the initial school is a bulk spawn and would flood this.
   */
  drainRareSpawns(): RareSpawn[] {
    if (this.rareSpawns.length === 0) return [];
    const out = this.rareSpawns;
    this.rareSpawns = [];
    return out;
  }

  // -------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------

  private slotOf(id: number): number {
    if (!(id >= 0) || id > MAX_ID) return -1;
    const s = this.idToSlot[id | 0];
    return s >= 0 && s < this.liveCount && this.alive[s] === 1 ? s : -1;
  }

  /** Ids stay inside 16 bits for the wire codec and skip any id still in use. */
  private allocId(): number {
    for (let guard = 0; guard <= MAX_ID; guard++) {
      const id = this.nextId;
      this.nextId = this.nextId >= MAX_ID ? 1 : this.nextId + 1;
      if (this.idToSlot[id] === -1) return id;
    }
    // Unreachable: at most GAME.maxFishCount ids are ever live at once.
    return 1;
  }

  /**
   * Initialise one slot. 'edge' spawns the fish sliding in from a side wall so
   * a replacement never pops into existence in the middle of the tank.
   */
  private spawnInto(slot: number, type: FishType, edge: boolean): void {
    const rng = this.rng;
    const data = getFishData(type);
    const id = this.allocId();

    this.fishId[slot] = id;
    this.idToSlot[id] = slot;
    this.typeIdx[slot] = fishTypeIndex(type);
    this.anim[slot] = ANIM_IDLE;
    this.carriedBy[slot] = 0;
    this.alive[slot] = 1;
    this.recovery[slot] = 0;
    this.panic[slot] = 0;
    this.stagger[slot] = slot & 1;
    this.steerX[slot] = 0;
    this.steerY[slot] = 0;
    this.steerZ[slot] = 0;

    this.wanderPhase[slot] = rng.range(0, 1000);
    this.speedScale[slot] = rng.range(0.86, 1.16);
    this.fearScale[slot] = rng.range(0.85, 1.2);
    this.curiosityScale[slot] = rng.range(0.7, 1.3);

    // depthPreference is 0 (surface) .. 1 (floor).
    const base = lerp(FISH_BOUNDS.maxY, FISH_BOUNDS.minY, clamp01(data.depthPreference));
    const ty = clamp(
      base + rng.range(-0.5, 0.5),
      FISH_BOUNDS.minY + 0.05,
      FISH_BOUNDS.maxY - 0.05,
    );
    this.targetY[slot] = ty;

    let x: number;
    let z: number;
    let hx: number;
    let hz: number;
    if (edge) {
      const side = rng.next() < 0.5 ? -1 : 1;
      x = side < 0 ? FISH_BOUNDS.minX + 0.12 : FISH_BOUNDS.maxX - 0.12;
      z = rng.range(FISH_BOUNDS.minZ + 0.3, FISH_BOUNDS.maxZ - 0.3);
      hx = -side;
      hz = rng.range(-0.4, 0.4);
    } else {
      x = rng.range(FISH_BOUNDS.minX + 0.4, FISH_BOUNDS.maxX - 0.4);
      z = rng.range(FISH_BOUNDS.minZ + 0.3, FISH_BOUNDS.maxZ - 0.3);
      const a = rng.range(0, TAU);
      hx = Math.sin(a);
      hz = Math.cos(a);
    }

    const hl = Math.sqrt(hx * hx + hz * hz) || 1;
    hx /= hl;
    hz /= hl;
    const sp = data.speed * this.speedScale[slot];

    this.px[slot] = x;
    this.py[slot] = ty;
    this.pz[slot] = z;
    this.vx[slot] = hx * sp;
    this.vy[slot] = 0;
    this.vz[slot] = hz * sp;
    this.yaw[slot] = Math.atan2(hx, hz);
    this.pitch[slot] = 0;
    this.roll[slot] = 0;
    this.speed01[slot] = 0.4;
  }
}
