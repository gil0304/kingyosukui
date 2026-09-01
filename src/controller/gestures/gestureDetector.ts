/**
 * Scoop gesture detection v3 — ANGLE-based (owner redesign, 2026-08-26).
 *
 * Two rounds of venue testing killed the accelerometer-integration approach:
 * double-integrated hand motion was device-convention-dependent (inverted on
 * the test iPhone), drift-prone, and unreliable for the one thing that matters
 * most. The owner's replacement is simpler and matches the physical metaphor
 * of a poi on a handle:
 *
 *   pitch the phone DOWN  → the poi goes into the water (further = deeper)
 *   pitch the phone UP    → the poi scoops up out of the water
 *   roll (left/right)     → no effect on entering or scooping
 *
 * Pitch is derived from the GRAVITY DIRECTION, which every phone reports
 * unambiguously — there is no sign convention to guess and nothing to
 * integrate, so this cannot invert or drift on any device.
 *
 * §55 survives intact: the SPEED of the tilt-up is the violence of the scoop.
 * A slow, deliberate tilt is a gentle lift the paper forgives; a snap of the
 * wrist is billed at its full rate and tears wet paper.
 *
 * The class name and output shape are unchanged; the input to update() is now
 * the calibrated pitch and its rate. [PURE] — no three, no react, no browser.
 */

import type { GestureEvent, GesturePhase } from '@/types';
import { Cooldown, Stillness } from '@/controller/filtering/filters';
import { clamp, clamp01, damp } from '@/game/core/math';

export interface GestureOutput {
  phase: GesturePhase;
  isSubmerging: boolean;
  isLifting: boolean;
  handOffsetY: number; // metres-equivalent height lever derived from pitch
  handVelocityY: number; // m/s-equivalent, + = rising
  liftPeakAccel: number; // violence of the current/last scoop, m/s²-equivalent
  shake: number; // 0..1
  events: GestureEvent[]; // reused array, valid until next update()
}

/** What update() consumes now. All angles in radians, rates in rad/s. */
export interface GestureInput {
  /** Calibrated pitch: 0 = the grip captured at calibration, − = nose down. */
  tiltY: number;
  /** Smoothed d(tiltY)/dt. + = tipping up. */
  pitchRate: number;
  /** World-vertical linear acceleration; only its MAGNITUDE is used. */
  verticalAcceleration: number;
}

export interface GestureTuning {
  /** Pitch below this (nose down) puts the poi in the water. */
  submergeAngle: number;
  /** Rising back past this leaves the water (hysteresis gap). */
  submergeExitAngle: number;
  /** Pitch above this (nose up) is the scoop. */
  liftAngle: number;
  /** Falling back past this ends the lift. */
  liftEndAngle: number;
  /** Pitch → height-lever gain (m per rad). */
  offsetGain: number;
  cooldown: number;
}

const DEG = Math.PI / 180;

export const DEFAULT_GESTURE_TUNING: GestureTuning = {
  submergeAngle: -11 * DEG,
  submergeExitAngle: -5 * DEG,
  liftAngle: 12 * DEG,
  liftEndAngle: 5 * DEG,
  offsetGain: 0.5,
  cooldown: 0.45,
};

/** How pitch rate converts into scoop violence (m/s²-equivalent per rad/s). */
const RATE_TO_VIOLENCE = 1.15;
/** Exit-crossing speed that separates a deliberate scoop from a passive drift. */
const LIFT_MIN_RATE = 0.5; // rad/s ≈ 29°/s
/** Time the upswing gets to pass through the end angle before it can end a lift. */
const LIFT_SWING_GRACE = 0.28;
/** Raised falls back to Idle after this. */
const RAISED_HOLD = 0.5;
/** Lift ends by angle, or by this ceiling so it can never latch on. */
const LIFT_MAX_TIME = 1.4;
/** Acceleration jitter (m/s²) that maps to shake = 1. */
const SHAKE_FULL_SCALE = 6.0;
const SHAKE_EVENT_LEVEL = 0.55;
const SHAKE_EVENT_COOLDOWN = 0.5;

export class GestureDetector {
  private readonly tune: GestureTuning;
  private readonly still = new Stillness(12);
  private readonly liftCooldown: Cooldown;
  private readonly shakeCooldown = new Cooldown(SHAKE_EVENT_COOLDOWN);

  private phase: GesturePhase = 'Idle';
  private phaseTime = 0;
  private offset = 0;
  private offsetVel = 0;
  private peak = 0;

  private base = 0; // low-frequency accel component, for the shake measure
  private hf = 0;

  private readonly out: GestureOutput = {
    phase: 'Idle',
    isSubmerging: false,
    isLifting: false,
    handOffsetY: 0,
    handVelocityY: 0,
    liftPeakAccel: 0,
    shake: 0,
    events: [],
  };

  constructor(opts?: Partial<GestureTuning>) {
    this.tune = { ...DEFAULT_GESTURE_TUNING, ...(opts ?? {}) };
    this.liftCooldown = new Cooldown(this.tune.cooldown);
  }

  update(input: GestureInput, dt: number, t: number): GestureOutput {
    const events = this.out.events;
    events.length = 0;

    const step = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;
    if (step <= 0) return this.writeOut();

    const tiltY = Number.isFinite(input.tiltY) ? input.tiltY : 0;
    const rate = Number.isFinite(input.pitchRate) ? input.pitchRate : 0;
    const aMag = Math.abs(Number.isFinite(input.verticalAcceleration) ? input.verticalAcceleration : 0);

    // ---- shake (feedback only) -------------------------------------------
    this.base = damp(this.base, aMag, 0.28, step);
    this.hf = damp(this.hf, Math.abs(aMag - this.base), 0.12, step);
    const shake = clamp01(this.hf / SHAKE_FULL_SCALE);
    this.still.push(aMag);
    if (shake > SHAKE_EVENT_LEVEL && this.shakeCooldown.tryTrigger(t)) {
      events.push({ type: 'SHAKE', strength: shake, t });
    }

    // ---- the height lever -------------------------------------------------
    // The pitch IS the poi's height: a continuous, drift-free control. The poi
    // simulation reads offset for its depth while submerged and its bob above.
    const targetOffset = clamp(tiltY * this.tune.offsetGain, -0.4, 0.3);
    const prevOffset = this.offset;
    this.offset = damp(this.offset, targetOffset, 0.06, step);
    this.offsetVel = damp(this.offsetVel, (this.offset - prevOffset) / step, 0.05, step);

    // ---- violence of the gesture in flight --------------------------------
    const violence = Math.max(aMag, Math.abs(rate) * RATE_TO_VIOLENCE);

    this.phaseTime += step;

    switch (this.phase) {
      case 'Idle':
      case 'Descending': {
        if (tiltY <= this.tune.submergeAngle) {
          this.phase = 'Submerged';
          this.phaseTime = 0;
          this.peak = 0;
          events.push({ type: 'SUBMERGE', strength: clamp01(Math.abs(rate) / 4), t });
        }
        break;
      }

      case 'Submerged': {
        // Any upward tilt eventually crosses the exit angle, so the LIFT/SETTLE
        // decision is made by the SPEED of that crossing (§55, in angle form):
        //   drifting back up  → SETTLE, and the simulation raises the poi on
        //                        its slow, forgiving release path;
        //   swinging up       → LIFT, billed at the rate of the swing — a calm
        //                        scoop costs little, a snap tears wet paper.
        if (tiltY >= this.tune.submergeExitAngle) {
          const scooping = rate >= LIFT_MIN_RATE || tiltY >= this.tune.liftAngle;
          if (scooping && this.liftCooldown.tryTrigger(t)) {
            this.phase = 'Lifting';
            this.phaseTime = 0;
            this.peak = Math.max(violence, 0.8);
            events.push({ type: 'LIFT', strength: clamp01(Math.abs(rate) / 5), t });
          } else {
            this.phase = 'Idle';
            this.phaseTime = 0;
            events.push({ type: 'SETTLE', strength: clamp01(Math.abs(rate) / 2), t });
          }
        }
        break;
      }

      case 'Lifting': {
        this.peak = Math.max(this.peak, violence);
        // The swing STARTS below liftEndAngle (it fires at the exit crossing),
        // so the end test only arms once the swing has had time to pass through
        // — otherwise a lift died on its very next frame.
        if (
          (this.phaseTime > LIFT_SWING_GRACE && tiltY <= this.tune.liftEndAngle) ||
          this.phaseTime >= LIFT_MAX_TIME
        ) {
          this.phase = 'Raised';
          this.phaseTime = 0;
        }
        break;
      }

      case 'Raised': {
        if (this.phaseTime >= RAISED_HOLD) {
          this.phase = 'Idle';
          this.phaseTime = 0;
        }
        // Straight back down for another go.
        if (tiltY <= this.tune.submergeAngle) {
          this.phase = 'Submerged';
          this.phaseTime = 0;
          this.peak = 0;
          events.push({ type: 'SUBMERGE', strength: clamp01(Math.abs(rate) / 4), t });
        }
        break;
      }
    }

    return this.writeOut();
  }

  private writeOut(): GestureOutput {
    const o = this.out;
    o.phase = this.phase;
    o.isSubmerging = this.phase === 'Submerged';
    o.isLifting = this.phase === 'Lifting';
    o.handOffsetY = this.offset;
    o.handVelocityY = this.offsetVel;
    o.liftPeakAccel = this.peak;
    o.shake = clamp01(this.hf / SHAKE_FULL_SCALE);
    return o;
  }

  reset(): void {
    this.phase = 'Idle';
    this.phaseTime = 0;
    this.offset = 0;
    this.offsetVel = 0;
    this.peak = 0;
    this.base = 0;
    this.hf = 0;
    this.still.reset();
    this.liftCooldown.reset();
    this.shakeCooldown.reset();
    this.out.events.length = 0;
    this.writeOut();
  }

  get output(): GestureOutput {
    return this.out;
  }
}
