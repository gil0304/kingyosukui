/**
 * Authoritative poi simulation (spec §30-§35, §46-§57).
 *
 * One instance per player, ticked at 60 Hz inside the Node game server. The
 * phone IS the poi: horizontal motion is an ABSOLUTE position mapping of the
 * phone tilt (§133) — levelling the phone recentres the poi, so there is never
 * any drift to fight — and the vertical axis is a small state machine driven by
 * the gesture detector's estimate of the hand's motion.
 *
 * [PURE] no 'three', no react, no browser globals.
 */

import {
  CAPTURE,
  POI,
  POI_BOUNDS,
  TANK,
} from '@/game/core/constants';
import { TAU, clamp, clamp01, damp, wrapAngle } from '@/game/core/math';
import { durabilityDamage, liftDanger, tearAmount, updateWetness, type DurabilityContext } from '@/game/poi/durability';
import type { PoiWire } from '@/network/protocol/codec';
import type { PoiVerticalState } from '@/types';

export interface PoiInput {
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
  connected: boolean;
}

export type PoiEventType =
  | 'ENTER_WATER'
  | 'EXIT_WATER'
  | 'LIFT_START'
  | 'LIFT_RESOLVED'
  | 'BROKE'
  | 'RESPAWNED'
  | 'COLLIDE';

export interface PoiEvent {
  type: PoiEventType;
  strength: number;
}

// --- tuning that only matters inside this module ---------------------------

/** Half-extents of the reachable area; the tilt mapping spans exactly this. */
const HALF_X = (POI_BOUNDS.maxX - POI_BOUNDS.minX) / 2;
const HALF_Z = (POI_BOUNDS.maxZ - POI_BOUNDS.minZ) / 2;
const CENTER_X = (POI_BOUNDS.maxX + POI_BOUNDS.minX) / 2;
const CENTER_Z = (POI_BOUNDS.maxZ + POI_BOUNDS.minZ) / 2;

/** The paper is considered under water once it is this far below the surface. */
const SUBMERGE_ENTER_Y = -0.05;
/** Never let the submerged paper poke back through the surface. */
const SUBMERGED_MAX_Y = -0.08;

/** How long a successful scoop is held up for the audience to see. */
const RAISED_HOLD_SECONDS = 0.7;
const RAISED_Y = Math.min(POI.liftResolveY + 0.35, POI_BOUNDS.maxY);
const RAISED_SMOOTHING = 0.22;

/** A torn poi is pulled out of the water while the player waits for a new one. */
const BROKEN_Y = Math.min(POI.hoverY + 0.45, POI_BOUNDS.maxY);
const BROKEN_SMOOTHING = 0.3;
/** Above this the broken poi is clear of the water and just waiting. */
const BROKEN_CLEAR_Y = 0.15;

const TILT_SMOOTHING = 0.055;
const SPIN_SMOOTHING = 0.11;
/** The poi tilts with the phone, but never past a physically silly angle. */
const MAX_TILT = 0.95;
const MAX_SPIN = 1.2;

/** Hand velocity is amplified a little: a 0.3 m/s wrist lift is a real scoop. */
const LIFT_SPEED_GAIN = 1.35;
const MAX_LIFT_SPEED = 4.2;
const LIFT_SPEED_SMOOTHING = 0.09;
/** Pushing the phone back down before the surface aborts the lift. */
const LIFT_ABORT_VELOCITY = -0.18;
/** Time constant the remembered lift acceleration decays with once idle. */
const LIFT_PEAK_DECAY = 0.35;
/** Holding the phone back up this long lifts the paper even without a LIFT gesture. */
const RELEASE_TO_LIFT_SECONDS = 0.15;
/** How strongly the estimated hand height moves the poi while above the water. */
const HAND_FOLLOW_GAIN = 1.6;

/**
 * Width of the soft outer bumper around a poi body: inside it neighbours ease
 * each other away at 'POI.separationStrength', so contact is felt a moment
 * before anything is actually blocked (§49).
 */
const SEPARATION_CUSHION = 0.18;
/** Vertical reach of a poi body: above this they are not touching at all. */
const CONTACT_HEIGHT = 0.45;

/** A carried fish sits just above the paper surface, not inside it. */
const PAPER_SIT_HEIGHT = 0.045;

const VY_SMOOTHING = 0.03;
const MAX_DT = 0.1;

const num = (v: number): number => (Number.isFinite(v) ? v : 0);

const IDLE_INPUT: PoiInput = {
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
  connected: false,
};

export class PoiSimulation {
  readonly playerNumber: number;

  x: number;
  y: number;
  z: number;

  tiltX = 0;
  tiltZ = 0;
  spin = 0;
  vy = 0;

  private horizontalSpeed = 0;

  wetness = 0;
  durability = POI.maxDurability;
  tear = 0;

  state: PoiVerticalState = 'Above';

  /** Fish ids currently resting on the paper — owned by the capture system. */
  readonly carried: number[] = [];
  /** Sum of the weights of 'carried', refreshed by the capture system each tick. */
  carriedWeight = 0;

  private readonly input: PoiInput = { ...IDLE_INPUT, connected: true };
  /** A freshly created poi belongs to a player who just joined. */
  private connected = true;
  /** True while the input is frozen (disconnect §84, or TIME UP §102). */
  private frozen = false;
  private parked = false;

  private targetX: number;
  private targetZ: number;

  private liftVy = 0;
  private liftPeak = 0;
  private liftReadyAt = 0;
  /** Seconds the hand has been held back up while the paper is submerged. */
  private releaseFor = 0;
  private raisedUntil = 0;
  private respawnAt = 0;

  private pendingBreak = false;
  private pendingCollision = 0;

  private readonly events: PoiEvent[] = [];
  private readonly eventPool: PoiEvent[] = [];
  private eventCount = 0;

  private readonly ctx: DurabilityContext = {
    inWater: false,
    lifting: false,
    liftAccel: 0,
    carriedWeight: 0,
    wetness: 0,
  };

  private readonly wire: PoiWire;

  constructor(playerNumber: number, startX: number) {
    this.playerNumber = playerNumber;
    this.x = clamp(startX, POI_BOUNDS.minX, POI_BOUNDS.maxX);
    this.y = POI.hoverY;
    this.z = CENTER_Z;
    this.targetX = this.x;
    this.targetZ = this.z;
    this.wire = {
      playerNumber,
      state: 'Above',
      x: this.x,
      y: this.y,
      z: this.z,
      tiltX: 0,
      tiltZ: 0,
      spin: 0,
      wetness: 0,
      durability: POI.maxDurability,
      carriedFish: 0,
      tear: 0,
      vy: 0,
    };
  }

  /** Geometric test: the paper is below the still water line. */
  get inWater(): boolean {
    return this.y < TANK.surfaceY;
  }

  /** A poi that can catch fish: intact, connected, and not parked at TIME UP. */
  get active(): boolean {
    return (
      this.connected &&
      !this.parked &&
      this.state !== 'Broken' &&
      this.state !== 'Respawning'
    );
  }

  /** Peak upward acceleration of the current lift, m/s² — feeds the paper model. */
  get liftAccel(): number {
    return this.liftPeak;
  }

  /** Horizontal speed, world units/s — used for fish fear and water wake. */
  get speed(): number {
    return this.horizontalSpeed;
  }

  setInput(i: PoiInput): void {
    if (!i.connected) {
      this.setDisconnected();
      return;
    }
    const inp = this.input;
    inp.x = clamp(num(i.x), -1, 1);
    inp.y = clamp(num(i.y), -1, 1);
    inp.tiltX = num(i.tiltX);
    inp.tiltY = num(i.tiltY);
    inp.tiltZ = num(i.tiltZ);
    inp.verticalAcceleration = num(i.verticalAcceleration);
    inp.handOffsetY = num(i.handOffsetY);
    inp.handVelocityY = num(i.handVelocityY);
    inp.liftPeakAccel = num(i.liftPeakAccel);
    inp.isSubmerging = i.isSubmerging;
    inp.isLifting = i.isLifting;
    inp.connected = true;
    this.connected = true;
    this.frozen = false;
  }

  /**
   * Spec §84: the player dropped off the network. Their poi simply stops where
   * it is — it does not snap home and it does not disturb anyone else.
   */
  setDisconnected(): void {
    this.connected = false;
    this.frozen = true;
    this.targetX = this.x;
    this.targetZ = this.z;
    this.input.isSubmerging = false;
    this.input.isLifting = false;
    this.input.handVelocityY = 0;
    this.input.handOffsetY = 0;
    this.input.connected = false;
  }

  /** Spec §102: TIME UP — every poi rises out of the water and stops reacting. */
  parkForTimeUp(): void {
    this.parked = true;
    this.frozen = true;
    this.targetX = this.x;
    this.targetZ = this.z;
    this.input.isSubmerging = false;
    this.input.isLifting = false;
    this.liftVy = 0;
    if (this.state !== 'Broken' && this.state !== 'Respawning') {
      this.state = 'Raised';
      this.raisedUntil = Number.POSITIVE_INFINITY;
    }
  }

  /** Full reset between rounds. Keeps the connection state. */
  reset(startX: number): void {
    this.x = clamp(startX, POI_BOUNDS.minX, POI_BOUNDS.maxX);
    this.y = POI.hoverY;
    this.z = CENTER_Z;
    this.targetX = this.x;
    this.targetZ = this.z;
    this.tiltX = 0;
    this.tiltZ = 0;
    this.spin = 0;
    this.vy = 0;
    this.horizontalSpeed = 0;
    this.wetness = 0;
    this.durability = POI.maxDurability;
    this.tear = 0;
    this.state = 'Above';
    this.carried.length = 0;
    this.carriedWeight = 0;
    this.liftVy = 0;
    this.liftPeak = 0;
    this.liftReadyAt = 0;
    this.releaseFor = 0;
    this.raisedUntil = 0;
    this.respawnAt = 0;
    this.pendingBreak = false;
    this.pendingCollision = 0;
    this.parked = false;
    this.frozen = !this.connected;
    this.events.length = 0;
    this.eventCount = 0;
  }

  /** Tear the paper on the next update (admin command, or a hard landing). */
  forceBreak(): void {
    this.pendingBreak = true;
  }

  /**
   * Advance one tick. 't' is a monotonic seconds clock (the room's game time).
   * The returned array is REUSED — read it before the next 'update()'.
   */
  update(dt: number, t: number): readonly PoiEvent[] {
    this.events.length = 0;
    this.eventCount = 0;
    if (!(dt > 0)) return this.events;
    const step = Math.min(dt, MAX_DT);

    // A collision registered by 'separate()' since the last tick.
    if (this.pendingCollision > 0) {
      this.emit('COLLIDE', this.pendingCollision);
      this.pendingCollision = 0;
    }

    const inp = this.input;
    const intact = this.state !== 'Broken' && this.state !== 'Respawning';
    const controllable = intact && this.connected && !this.frozen && !this.parked;
    const prevY = this.y;

    this.updateHorizontal(inp, controllable, step);
    this.updateTilt(inp, controllable, step);

    // Remember how hard this lift was; decay it once the lift is over so the
    // danger readout on the phone falls back to calm.
    if (this.state === 'Lifting' && controllable) {
      this.liftPeak = Math.max(
        this.liftPeak,
        Math.abs(inp.liftPeakAccel),
        inp.verticalAcceleration,
      );
    } else {
      this.liftPeak = damp(this.liftPeak, 0, LIFT_PEAK_DECAY, step);
    }

    this.updateVertical(inp, controllable, step, t);
    this.y = clamp(this.y, POI_BOUNDS.minY, POI_BOUNDS.maxY);
    this.vy = damp(this.vy, (this.y - prevY) / step, VY_SMOOTHING, step);

    // Surface crossings drive the splash / drip effects on the screen.
    if (prevY > TANK.surfaceY && this.y <= TANK.surfaceY) {
      this.emit('ENTER_WATER', clamp01(Math.abs(this.vy) / 3));
    } else if (prevY <= TANK.surfaceY && this.y > TANK.surfaceY) {
      this.emit('EXIT_WATER', clamp01(Math.abs(this.vy) / 3));
    }

    this.updatePaper(intact, step, t);
    return this.events;
  }

  // -------------------------------------------------------------------------

  /**
   * ABSOLUTE position mapping (§30, §133). 'input.x' −1..+1 spans the tank left
   * to right and 'input.y' −1 (far / 奥) .. +1 (near / 手前) spans it back to
   * front: +Z is toward the viewer, so tilting the phone forward — which the
   * sensor adapter reports as a negative 'y' — drives the poi to −Z, deeper
   * into the tank. Levelling the phone puts the poi back in the middle.
   */
  private updateHorizontal(inp: PoiInput, controllable: boolean, dt: number): void {
    if (controllable) {
      this.targetX = CENTER_X + inp.x * HALF_X;
      this.targetZ = CENTER_Z + inp.y * HALF_Z;
    }

    // Water resistance: a submerged poi drags. This is both realism — pushing a
    // paper scoop through water is slow, heavy work — and the thing that makes
    // fine aiming possible right where it matters, over the fish.
    const smoothing = this.inWater ? POI.horizontalSmoothing * 2.2 : POI.horizontalSmoothing;
    const nextX = damp(this.x, this.targetX, smoothing, dt);
    const nextZ = damp(this.z, this.targetZ, smoothing, dt);
    let dx = nextX - this.x;
    let dz = nextZ - this.z;

    // Even a snap of the wrist cannot teleport the poi across the tank.
    const dist = Math.hypot(dx, dz);
    const maxStep = (this.inWater ? POI.maxSpeed * 0.55 : POI.maxSpeed) * dt;
    if (dist > maxStep && dist > 1e-9) {
      const s = maxStep / dist;
      dx *= s;
      dz *= s;
    }

    this.x = clamp(this.x + dx, POI_BOUNDS.minX, POI_BOUNDS.maxX);
    this.z = clamp(this.z + dz, POI_BOUNDS.minZ, POI_BOUNDS.maxZ);
    this.horizontalSpeed = Math.hypot(dx, dz) / dt;
  }

  /**
   * Spec §32: the poi tilts exactly the way the phone does — it is a physical
   * object in the water, not a flat 2D cursor. Pitching the phone forward dips
   * the far edge of the paper (rotation about +X), rolling it right dips the
   * right edge (negative rotation about Z), and the yaw delta spins it.
   */
  private updateTilt(inp: PoiInput, controllable: boolean, dt: number): void {
    // Sign convention, pinned by tests/controlChain (venue regression 2026-08-26):
    // three.js rotates +X so that a POSITIVE angle lifts the FAR (−Z) edge.
    // Phone nose down ⇒ tiltY < 0 ⇒ tiltX must be NEGATIVE so the far edge of
    // the paper dips down too — the poi mirrors the phone. The first version
    // negated this and every player saw their poi tip the wrong way.
    const tx = controllable ? clamp(inp.tiltY, -MAX_TILT, MAX_TILT) : 0;
    const tz = controllable ? clamp(-inp.tiltX, -MAX_TILT, MAX_TILT) : 0;
    const sp = controllable ? clamp(wrapAngle(inp.tiltZ), -MAX_SPIN, MAX_SPIN) : 0;

    this.tiltX = damp(this.tiltX, tx, TILT_SMOOTHING, dt);
    this.tiltZ = damp(this.tiltZ, tz, TILT_SMOOTHING, dt);
    this.spin = this.spin + wrapAngle(sp - this.spin) * (1 - Math.exp(-dt / SPIN_SMOOTHING));
  }

  private updateVertical(inp: PoiInput, controllable: boolean, dt: number, t: number): void {
    switch (this.state) {
      case 'Above': {
        // The poi hangs from the hand: raising or lowering the phone visibly
        // raises or lowers the paper even before it touches the water. This is
        // most of the "my phone IS the poi" illusion (§133) — without it the
        // vertical axis only exists at the moment of a gesture.
        const hover = controllable
          ? clamp(POI.hoverY + inp.handOffsetY * HAND_FOLLOW_GAIN, 0.1, POI_BOUNDS.maxY)
          : POI.hoverY;
        this.y = damp(this.y, hover, POI.verticalSmoothing, dt);
        if (controllable && inp.isSubmerging) this.state = 'Entering';
        break;
      }

      case 'Entering': {
        // Committed: once the hand goes down the paper goes into the water.
        this.y = damp(this.y, POI.restDepth, POI.verticalSmoothing, dt);
        if (this.y <= SUBMERGE_ENTER_Y) this.state = 'Submerged';
        break;
      }

      case 'Submerged': {
        // 'handOffsetY' is leaky-integrated, so it springs back to zero: fine
        // depth control that can never drift the poi into the gravel.
        const target = clamp(
          POI.restDepth + (controllable ? inp.handOffsetY : 0),
          POI_BOUNDS.minY,
          SUBMERGED_MAX_Y,
        );
        this.y = damp(this.y, target, POI.verticalSmoothing, dt);

        // Two ways out of the water, and BOTH must be able to land a catch.
        //
        //  * a deliberate scoop  — the LIFT gesture, fast and dramatic
        //  * simply raising the hand — no gesture fires, but the paper still
        //    rises, slowly. Spec §55 makes the gentle lift the *reliable* one,
        //    so it cannot be a dead end: a player who lifts too softly to trip
        //    the detector must still get their fish out of the water.
        if (!controllable || inp.isSubmerging) this.releaseFor = 0;
        else this.releaseFor += dt;

        const deliberate = controllable && inp.isLifting && t >= this.liftReadyAt;
        const gentle = this.releaseFor >= RELEASE_TO_LIFT_SECONDS;

        if (deliberate || gentle) {
          this.state = 'Lifting';
          this.releaseFor = 0;
          this.liftVy = clamp(
            Math.max(CAPTURE.minLiftSpeed, inp.handVelocityY * LIFT_SPEED_GAIN),
            CAPTURE.minLiftSpeed,
            MAX_LIFT_SPEED,
          );
          // A lift nobody asked for is by definition a calm one: record almost
          // no acceleration so the paper takes almost no load.
          this.liftPeak = deliberate
            ? Math.max(Math.abs(inp.liftPeakAccel), inp.verticalAcceleration)
            : Math.max(0, inp.verticalAcceleration);
          this.emit('LIFT_START', deliberate ? clamp01(inp.handVelocityY / 1.6) : 0.2);
        }
        break;
      }

      case 'Lifting': {
        // Floored at 'minLiftSpeed' so even a modest, careful lift completes —
        // gentleness must never mean failure (§55).
        const desired = clamp(
          Math.max(CAPTURE.minLiftSpeed, (controllable ? inp.handVelocityY : 0) * LIFT_SPEED_GAIN),
          CAPTURE.minLiftSpeed,
          MAX_LIFT_SPEED,
        );
        this.liftVy = damp(this.liftVy, desired, LIFT_SPEED_SMOOTHING, dt);
        this.y += this.liftVy * dt;

        if (
          controllable &&
          inp.isSubmerging &&
          inp.handVelocityY < LIFT_ABORT_VELOCITY &&
          this.y < TANK.surfaceY
        ) {
          // The player changed their mind and pushed back down.
          this.state = 'Submerged';
          this.releaseFor = 0;
          this.liftVy = 0;
          this.liftReadyAt = t + CAPTURE.liftCooldownSeconds;
        } else if (this.y >= POI.liftResolveY) {
          this.y = POI.liftResolveY;
          this.state = 'Raised';
          this.raisedUntil = t + RAISED_HOLD_SECONDS;
          this.liftReadyAt = t + CAPTURE.liftCooldownSeconds;
          this.emit('LIFT_RESOLVED', clamp01(this.liftVy / 2.5));
        }
        break;
      }

      case 'Raised': {
        // Hold the catch up where the player and the audience can see it.
        this.y = damp(this.y, RAISED_Y, RAISED_SMOOTHING, dt);
        if (!this.parked && t >= this.raisedUntil) this.state = 'Above';
        break;
      }

      case 'Broken':
      case 'Respawning': {
        this.y = damp(this.y, BROKEN_Y, BROKEN_SMOOTHING, dt);
        if (this.state === 'Broken' && this.y > BROKEN_CLEAR_Y) this.state = 'Respawning';
        if (t >= this.respawnAt) this.respawn(t);
        break;
      }
    }
  }

  private updatePaper(intact: boolean, dt: number, t: number): void {
    if (!intact) {
      // No paper left to soak — it just drips while the new one is prepared.
      this.wetness = updateWetness(this.wetness, false, dt);
      this.pendingBreak = false;
      return;
    }

    this.wetness = updateWetness(this.wetness, this.inWater, dt);

    const ctx = this.ctx;
    ctx.inWater = this.inWater;
    ctx.lifting = this.state === 'Lifting';
    ctx.liftAccel = this.liftPeak;
    ctx.carriedWeight = this.carriedWeight;
    ctx.wetness = this.wetness;

    this.durability = Math.max(0, this.durability - durabilityDamage(ctx, dt));
    this.tear = tearAmount(this.durability);

    if (this.pendingBreak || this.durability <= 0) {
      this.pendingBreak = false;
      this.breakPaper(t);
    }
  }

  /** §56: the paper gives way. The fish fall — the player is never eliminated. */
  private breakPaper(t: number): void {
    this.durability = 0;
    this.tear = 1;
    this.state = 'Broken';
    this.respawnAt = t + POI.respawnSeconds;
    this.liftVy = 0;
    this.liftReadyAt = t + POI.respawnSeconds;
    // A torn poi rises straight up out of the water rather than sliding away.
    this.targetX = this.x;
    this.targetZ = this.z;
    this.emit('BROKE', clamp01(0.4 + 0.6 * liftDanger(this.liftPeak)));
  }

  /** §57: a brand new poi, three seconds later. */
  private respawn(t: number): void {
    this.durability = POI.maxDurability;
    this.wetness = 0;
    this.tear = 0;
    this.liftPeak = 0;
    this.liftVy = 0;
    this.releaseFor = 0;
    this.carried.length = 0;
    this.carriedWeight = 0;
    this.liftReadyAt = t;
    this.state = this.parked ? 'Raised' : 'Above';
    this.raisedUntil = this.parked ? Number.POSITIVE_INFINITY : t;
    this.emit('RESPAWNED', 1);
  }

  private emit(type: PoiEventType, strength: number): void {
    let e = this.eventPool[this.eventCount];
    if (e === undefined) {
      e = { type, strength };
      this.eventPool.push(e);
    } else {
      e.type = type;
      e.strength = strength;
    }
    this.eventCount++;
    this.events.push(e);
  }

  /** Fills and returns a reused 'PoiWire' — copy it if you need to keep it. */
  toWire(): PoiWire {
    const w = this.wire;
    w.state = this.state;
    w.x = this.x;
    w.y = this.y;
    w.z = this.z;
    w.tiltX = this.tiltX;
    w.tiltZ = this.tiltZ;
    w.spin = this.spin;
    w.wetness = this.wetness;
    w.durability = this.durability;
    w.carriedFish = this.carried.length;
    w.tear = this.tear;
    w.vy = this.vy;
    return w;
  }

  /**
   * Spec §49: poi never pass through each other, but they are paper on bamboo —
   * the response is a soft mutual nudge, capped so it can never be used as a
   * weapon. Neither poi is damaged, and neither loses its fish.
   * Returns true when they were touching, so the caller can ripple the water.
   * (A 'COLLIDE' event is also queued and surfaces on the next 'update()';
   * use one signal or the other, not both, or the ripple will double up.)
   */
  static separate(a: PoiSimulation, b: PoiSimulation, dt: number): boolean {
    if (!(dt > 0)) return false;
    // A poi held high in the air is simply not in the way of a submerged one.
    if (Math.abs(a.y - b.y) >= CONTACT_HEIGHT) return false;
    const minDist = POI.bodyRadius * 2;
    const cushion = minDist + SEPARATION_CUSHION;
    let dx = b.x - a.x;
    let dz = b.z - a.z;
    const distSq = dx * dx + dz * dz;
    if (distSq >= cushion * cushion) return false;

    let dist = Math.sqrt(distSq);
    if (dist < 1e-4) {
      // Exactly stacked: push apart along X, deterministically by seat order.
      dx = a.playerNumber <= b.playerNumber ? 1 : -1;
      dz = 0;
      dist = 1e-4;
    } else {
      dx /= dist;
      dz /= dist;
    }

    let push: number;
    let touching: boolean;
    if (dist >= minDist) {
      // Outer cushion: a gentle, velocity-shaped nudge — you feel your
      // neighbour before either of you is stopped.
      push = (cushion - dist) * POI.separationStrength * dt * 0.5;
      touching = false;
    } else {
      // Contact: a positional constraint, never an impulse. The overlap is
      // simply removed, half from each poi — no bounce, nothing stored for
      // later, no damage. Limited to the poi's own top speed so that even a
      // deep overlap unwinds over a frame or two instead of teleporting, and
      // never further than the overlap itself, so the worst a player can do to
      // a neighbour is deny them the water they are standing in.
      push = Math.min((minDist - dist) * 0.5, POI.maxSpeed * dt);
      touching = true;
    }

    a.x = clamp(a.x - dx * push, POI_BOUNDS.minX, POI_BOUNDS.maxX);
    a.z = clamp(a.z - dz * push, POI_BOUNDS.minZ, POI_BOUNDS.maxZ);
    b.x = clamp(b.x + dx * push, POI_BOUNDS.minX, POI_BOUNDS.maxX);
    b.z = clamp(b.z + dz * push, POI_BOUNDS.minZ, POI_BOUNDS.maxZ);

    if (!touching) return false;
    const strength = clamp01((minDist - dist) / minDist);
    a.pendingCollision = Math.max(a.pendingCollision, strength);
    b.pendingCollision = Math.max(b.pendingCollision, strength);
    return true;
  }

  /**
   * World position of the paper surface where carried fish number 'index' of
   * 'count' sits: the centre for a single fish, a small ring for a crowd. The
   * poi's own rotation is applied (spin about Y, then roll about Z, then pitch
   * about X — Euler order 'XZY') so a fish visibly rides the tilted paper.
   */
  paperPoint(index: number, count: number, out: { x: number; y: number; z: number }): void {
    const n = Math.max(1, Math.floor(count));
    const i = clamp(Math.floor(index), 0, n - 1);

    let lx = 0;
    let lz = 0;
    if (n > 1) {
      const r = POI.paperRadius * (n <= 4 ? 0.42 : 0.56);
      // Offset every other ring by half a step so pairs sit left/right, not front/back.
      const a = (i / n) * TAU + (n % 2 === 0 ? Math.PI / n : 0);
      lx = Math.cos(a) * r;
      lz = Math.sin(a) * r;
    }
    const ly = PAPER_SIT_HEIGHT;

    const cs = Math.cos(this.spin);
    const sn = Math.sin(this.spin);
    const sx = lx * cs + lz * sn;
    const sz = -lx * sn + lz * cs;

    const cz = Math.cos(this.tiltZ);
    const szn = Math.sin(this.tiltZ);
    const rx = sx * cz - ly * szn;
    const ry = sx * szn + ly * cz;

    const cx = Math.cos(this.tiltX);
    const sxn = Math.sin(this.tiltX);

    out.x = this.x + rx;
    out.y = this.y + (ry * cx - sz * sxn);
    out.z = this.z + (ry * sxn + sz * cx);
  }
}
