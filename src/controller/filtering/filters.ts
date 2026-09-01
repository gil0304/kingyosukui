/**
 * Signal conditioning primitives for the smartphone controller (spec §36–§38).
 *
 * [PURE] — no 'three', no React, no browser globals. These run in unit tests and
 * (potentially) inside the Node game server, so they must stay dependency free.
 *
 * Every filter here is deliberately NaN-safe. DeviceMotion on several Android
 * builds emits a null/NaN sample when the sensor pipeline re-batches, and a
 * single NaN reaching an IIR filter would poison its state permanently — the
 * poi would freeze for the rest of the round with no way to recover.
 */

import { clamp01 } from '@/game/core/math';

/** Variance below this (in the unit of the pushed signal, squared) counts as "still". */
export const STILLNESS_VARIANCE_THRESHOLD = 0.035;

/** Classic exponential moving average. 'alpha' is the weight of the NEW sample. */
export class LowPassFilter {
  private readonly a: number;
  private y = 0;
  private init = false;

  constructor(alpha: number) {
    this.a = Number.isFinite(alpha) ? clamp01(alpha) : 1;
  }

  next(v: number): number {
    if (!Number.isFinite(v)) return this.y;
    if (!this.init) {
      this.y = v;
      this.init = true;
      return this.y;
    }
    this.y += this.a * (v - this.y);
    return this.y;
  }

  reset(v?: number): void {
    if (v !== undefined && Number.isFinite(v)) {
      this.y = v;
      this.init = true;
    } else {
      this.y = 0;
      this.init = false;
    }
  }

  get value(): number {
    return this.y;
  }

  get initialized(): boolean {
    return this.init;
  }
}

/**
 * 1€ filter (Casiez et al.). Adaptive cutoff: heavy smoothing while the signal
 * is slow (kills hand tremor) and almost none while it moves fast (kills lag).
 * This is what makes the tilt feel both steady and immediate.
 */
export class OneEuroFilter {
  private readonly minCutoff: number;
  private readonly beta: number;
  private readonly dCutoff: number;
  private x = 0;
  private dx = 0;
  private init = false;

  constructor(opts?: { minCutoff?: number; beta?: number; dCutoff?: number }) {
    this.minCutoff = opts?.minCutoff !== undefined && opts.minCutoff > 0 ? opts.minCutoff : 1.0;
    this.beta = opts?.beta !== undefined && Number.isFinite(opts.beta) ? opts.beta : 0.012;
    this.dCutoff = opts?.dCutoff !== undefined && opts.dCutoff > 0 ? opts.dCutoff : 1.0;
  }

  /** Smoothing factor for a first-order low pass at 'cutoff' Hz sampled at 'dt'. */
  private static alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  next(v: number, dt: number): number {
    if (!Number.isFinite(v)) return this.x;
    if (!this.init) {
      this.x = v;
      this.dx = 0;
      this.init = true;
      return this.x;
    }
    // A zero/absurd dt would divide by zero; treat it as "no time passed".
    if (!Number.isFinite(dt) || dt <= 0) return this.x;

    const dRaw = (v - this.x) / dt;
    this.dx += OneEuroFilter.alpha(this.dCutoff, dt) * (dRaw - this.dx);

    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuroFilter.alpha(cutoff, dt) * (v - this.x);
    return this.x;
  }

  reset(): void {
    this.x = 0;
    this.dx = 0;
    this.init = false;
  }

  get value(): number {
    return this.x;
  }
}

/** Three independent low passes sharing one alpha — used for gravity estimation. */
export class Vec3LowPass {
  private readonly a: number;
  private _x = 0;
  private _y = 0;
  private _z = 0;
  private init = false;
  private readonly out = { x: 0, y: 0, z: 0 };

  constructor(alpha: number) {
    this.a = Number.isFinite(alpha) ? clamp01(alpha) : 1;
  }

  next(x: number, y: number, z: number): { x: number; y: number; z: number } {
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      if (!this.init) {
        this._x = x;
        this._y = y;
        this._z = z;
        this.init = true;
      } else {
        this._x += this.a * (x - this._x);
        this._y += this.a * (y - this._y);
        this._z += this.a * (z - this._z);
      }
    }
    // Reused object: this is called at 60 Hz on a phone, allocation would churn GC.
    this.out.x = this._x;
    this.out.y = this._y;
    this.out.z = this._z;
    return this.out;
  }

  reset(): void {
    this._x = 0;
    this._y = 0;
    this._z = 0;
    this.init = false;
  }

  get x(): number {
    return this._x;
  }

  get y(): number {
    return this._y;
  }

  get z(): number {
    return this._z;
  }

  get initialized(): boolean {
    return this.init;
  }
}

/**
 * Zero inside 'dz', then ramps smoothly to ±1 at 'max' (spec §37).
 *
 * A plain "subtract the dead zone" would leave a slope discontinuity at the edge:
 * the poi would visibly jump into motion the instant the tremor threshold is
 * crossed. The smoothstep ramp leaves the derivative at zero on both ends, so
 * the poi eases away from centre and eases into the tank wall.
 */
export function softDeadZone(v: number, dz: number, max = 1): number {
  if (!Number.isFinite(v)) return 0;
  const lo = Number.isFinite(dz) && dz > 0 ? dz : 0;
  const hi = Number.isFinite(max) ? Math.max(max, lo + 1e-6) : lo + 1e-6;
  const a = Math.abs(v);
  if (a <= lo) return 0;
  const t = clamp01((a - lo) / (hi - lo));
  return (v < 0 ? -1 : 1) * t * t * (3 - 2 * t);
}

/** Minimum spacing between two triggers of the same gesture. */
export class Cooldown {
  private readonly seconds: number;
  private last = Number.NEGATIVE_INFINITY;

  constructor(seconds: number) {
    this.seconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  }

  ready(t: number): boolean {
    if (!Number.isFinite(t)) return false;
    return t - this.last >= this.seconds;
  }

  trigger(t: number): void {
    if (Number.isFinite(t)) this.last = t;
  }

  tryTrigger(t: number): boolean {
    if (!this.ready(t)) return false;
    this.trigger(t);
    return true;
  }

  reset(): void {
    this.last = Number.NEGATIVE_INFINITY;
  }
}

/**
 * Tracks the max |value| seen since the last reset, with optional decay.
 * The durability model reads this to tell a gentle scoop from a violent yank (§55).
 */
export class PeakTracker {
  private readonly decay: number;
  private p = 0;

  constructor(decayPerSecond = 0) {
    this.decay = Number.isFinite(decayPerSecond) && decayPerSecond > 0 ? decayPerSecond : 0;
  }

  push(v: number, dt: number): number {
    if (this.decay > 0 && Number.isFinite(dt) && dt > 0) {
      this.p = Math.max(0, this.p - this.decay * dt);
    }
    if (Number.isFinite(v)) {
      const a = Math.abs(v);
      if (a > this.p) this.p = a;
    }
    return this.p;
  }

  reset(): void {
    this.p = 0;
  }

  get peak(): number {
    return this.p;
  }
}

/**
 * Rolling variance over the last N samples — "is the hand still?".
 * The gesture detector uses this for the zero-velocity update that stops the
 * double integration from drifting away.
 */
export class Stillness {
  private readonly buf: Float64Array;
  private n = 0;
  private head = 0;

  constructor(windowSize = 12) {
    const size = Number.isFinite(windowSize) ? Math.max(2, Math.floor(windowSize)) : 12;
    this.buf = new Float64Array(size);
  }

  push(v: number): void {
    if (!Number.isFinite(v)) return;
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.buf.length;
    if (this.n < this.buf.length) this.n++;
  }

  get variance(): number {
    // Fewer than two samples: nothing to compare, treat as "not yet known".
    if (this.n < 2) return Number.POSITIVE_INFINITY;
    let mean = 0;
    for (let i = 0; i < this.n; i++) mean += this.buf[i];
    mean /= this.n;
    let acc = 0;
    for (let i = 0; i < this.n; i++) {
      const d = this.buf[i] - mean;
      acc += d * d;
    }
    return acc / this.n;
  }

  get isStill(): boolean {
    return this.variance < STILLNESS_VARIANCE_THRESHOLD;
  }

  get filled(): boolean {
    return this.n >= this.buf.length;
  }

  reset(): void {
    this.buf.fill(0);
    this.n = 0;
    this.head = 0;
  }
}
