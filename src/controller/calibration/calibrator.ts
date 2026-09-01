/**
 * Neutral-pose calibration (spec §28, §29).
 *
 * While the giant screen counts「スマホを自然に構えてください 3・2・1」the phone
 * keeps handing us samples; we average them into a NeutralOrientation and from
 * then on every tilt is expressed relative to it. There is deliberately NO
 * calibration button on the phone (§29) — the countdown IS the interaction.
 *
 * [PURE] — no 'three', no React, no browser globals.
 */

import type { CalibrationData, SensorSample } from '@/types';
import { DEG2RAD, RAD2DEG, wrapAngle } from '@/game/core/math';

/**
 * Neutral drift correction time constant, seconds.
 *
 * Very long on purpose: it only exists so a tired wrist slowly re-centres over
 * a whole round. Anything faster would fight the player's real input — the poi
 * would creep back to the middle while they are holding a deliberate tilt.
 */
export const DRIFT_TIME_CONSTANT = 25;

/** Hard cap on collected samples so a stuck calibration cannot grow without bound. */
const MAX_COLLECTED = 900;

const normalizeDegrees360 = (deg: number): number => {
  const r = deg % 360;
  return r < 0 ? r + 360 : r;
};

const isFiniteOrientation = (s: SensorSample): boolean =>
  Number.isFinite(s.alpha) && Number.isFinite(s.beta) && Number.isFinite(s.gamma);

/**
 * Direction the accelerometer reports at rest, derived from the orientation
 * angles: R(alpha,beta,gamma)ᵀ · worldUp. Used when the device exposes
 * DeviceOrientation but no usable DeviceMotion at all.
 */
const gravityFromAngles = (betaDeg: number, gammaDeg: number): [number, number, number] => {
  const b = betaDeg * DEG2RAD;
  const g = gammaDeg * DEG2RAD;
  return [-Math.cos(b) * Math.sin(g), Math.sin(b), Math.cos(b) * Math.cos(g)];
};

/**
 * Averages a set of samples into a neutral pose.
 *
 * alpha and gamma are averaged CIRCULARLY (mean of unit vectors). A naive
 * arithmetic mean is wrong for wrapping angles: samples straddling 359°/1°
 * would average to 180° and point the poi at the opposite wall. beta is
 * averaged arithmetically — a hand-held phone never straddles its ±180° seam.
 */
export function averageCalibration(samples: readonly SensorSample[]): CalibrationData | null {
  let n = 0;
  let sinA = 0;
  let cosA = 0;
  let sinG = 0;
  let cosG = 0;
  let sumBeta = 0;
  let gx = 0;
  let gy = 0;
  let gz = 0;
  let gn = 0;
  let capturedAt = 0;

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (!s || !isFiniteOrientation(s)) continue;
    n++;
    const a = s.alpha * DEG2RAD;
    const g = s.gamma * DEG2RAD;
    sinA += Math.sin(a);
    cosA += Math.cos(a);
    sinG += Math.sin(g);
    cosG += Math.cos(g);
    sumBeta += s.beta;
    if (Number.isFinite(s.t)) capturedAt = s.t;
    if (Number.isFinite(s.gx) && Number.isFinite(s.gy) && Number.isFinite(s.gz)) {
      gx += s.gx;
      gy += s.gy;
      gz += s.gz;
      gn++;
    }
  }

  if (n === 0) return null;

  const alpha = normalizeDegrees360(Math.atan2(sinA / n, cosA / n) * RAD2DEG);
  const beta = sumBeta / n;
  const gamma = Math.atan2(sinG / n, cosG / n) * RAD2DEG;

  let ux = 0;
  let uy = 0;
  let uz = 0;
  if (gn > 0) {
    const mx = gx / gn;
    const my = gy / gn;
    const mz = gz / gn;
    const len = Math.hypot(mx, my, mz);
    // A phone at rest reads ~9.8 m/s²; anything near zero means the device has
    // no usable accelerometer, so fall back to the orientation angles.
    if (len > 0.5) {
      ux = mx / len;
      uy = my / len;
      uz = mz / len;
    }
  }
  if (ux === 0 && uy === 0 && uz === 0) {
    [ux, uy, uz] = gravityFromAngles(beta, gamma);
  }

  return {
    alpha,
    beta,
    gamma,
    gravityX: ux,
    gravityY: uy,
    gravityZ: uz,
    capturedAt,
    samples: n,
  };
}

export class Calibrator {
  private collected: SensorSample[] = [];
  private isCollecting = false;
  private d: CalibrationData | null = null;
  /**
   * Neutral captured lazily from the first sample seen before a real
   * calibration exists, so the phone's bowl-water effect (§93) has something
   * sensible to show in the lobby instead of a wildly off-centre tilt.
   */
  private provisional: CalibrationData | null = null;
  private readonly tilt = { tiltX: 0, tiltY: 0, tiltZ: 0 };

  begin(): void {
    this.collected.length = 0;
    this.isCollecting = true;
  }

  addSample(s: SensorSample): void {
    if (!this.isCollecting || !s || !isFiniteOrientation(s)) return;
    if (this.collected.length >= MAX_COLLECTED) return;
    // Copy: the adapter reuses one mutable sample object at 60 Hz.
    this.collected.push({ ...s });
  }

  finish(): CalibrationData | null {
    this.isCollecting = false;
    const d = averageCalibration(this.collected);
    this.collected.length = 0;
    if (d) {
      this.d = d;
      this.provisional = null;
    }
    return d;
  }

  cancel(): void {
    this.isCollecting = false;
    this.collected.length = 0;
  }

  get collecting(): boolean {
    return this.isCollecting;
  }

  get sampleCount(): number {
    return this.collected.length;
  }

  get data(): CalibrationData | null {
    return this.d;
  }

  setData(d: CalibrationData | null): void {
    this.d = d;
    this.provisional = null;
  }

  /**
   * Very slow neutral drift correction. 'moving' suppresses it entirely so a
   * held tilt is never eaten; only a hand that has gone quiet re-centres.
   */
  updateDrift(s: SensorSample, dt: number, moving: boolean): void {
    const d = this.d;
    if (!d || moving || this.isCollecting) return;
    if (!s || !isFiniteOrientation(s)) return;
    if (!Number.isFinite(dt) || dt <= 0) return;

    const k = 1 - Math.exp(-dt / DRIFT_TIME_CONSTANT);
    d.alpha = normalizeDegrees360(
      d.alpha + wrapAngle((s.alpha - d.alpha) * DEG2RAD) * RAD2DEG * k,
    );
    d.beta += wrapAngle((s.beta - d.beta) * DEG2RAD) * RAD2DEG * k;
    d.gamma += wrapAngle((s.gamma - d.gamma) * DEG2RAD) * RAD2DEG * k;

    if (Number.isFinite(s.gx) && Number.isFinite(s.gy) && Number.isFinite(s.gz)) {
      const len = Math.hypot(s.gx, s.gy, s.gz);
      if (len > 0.5) {
        d.gravityX += (s.gx / len - d.gravityX) * k;
        d.gravityY += (s.gy / len - d.gravityY) * k;
        d.gravityZ += (s.gz / len - d.gravityZ) * k;
        const l2 = Math.hypot(d.gravityX, d.gravityY, d.gravityZ);
        if (l2 > 1e-6) {
          d.gravityX /= l2;
          d.gravityY /= l2;
          d.gravityZ /= l2;
        }
      }
    }
  }

  /**
   * Calibrated tilt in RADIANS, relative to the neutral pose.
   *
   * tiltX = roll   — the phone's right edge dips  → positive → poi moves right (+X).
   * tiltY = pitch  — the top of the phone tips away from the player → NEGATIVE
   *                  → poi moves to −Z, deeper into the tank (奥へ).
   * tiltZ = yaw delta — purely visual, spins the poi (§32).
   *
   * Every difference goes through 'wrapAngle' because alpha wraps at 360° and
   * beta/gamma wrap at their own seams.
   */
  apply(s: SensorSample): { tiltX: number; tiltY: number; tiltZ: number } {
    const out = this.tilt;
    if (!s || !isFiniteOrientation(s)) return out;

    let n = this.d;
    if (!n) {
      if (!this.provisional) {
        this.provisional = {
          alpha: s.alpha,
          beta: s.beta,
          gamma: s.gamma,
          gravityX: 0,
          gravityY: 0,
          gravityZ: 1,
          capturedAt: s.t,
          samples: 0,
        };
      }
      n = this.provisional;
    }

    out.tiltX = wrapAngle((s.gamma - n.gamma) * DEG2RAD);
    out.tiltY = wrapAngle((s.beta - n.beta) * DEG2RAD);
    out.tiltZ = wrapAngle((s.alpha - n.alpha) * DEG2RAD);
    return out;
  }
}
