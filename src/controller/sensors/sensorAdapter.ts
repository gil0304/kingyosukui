/**
 * SensorAdapter (spec §26) — the ONLY place in the app that touches raw sensors.
 *
 *   DeviceOrientationEvent ─┐
 *   DeviceMotionEvent ──────┴─> SensorAdapter ─> Calibration ─> Filtering ─> Gestures ─> ControllerState
 *
 * Everything downstream consumes 'ControllerState(Ext)' and nothing else, so all
 * device differences — screen rotation, iOS vs Android accelerometer sign
 * conventions, phones that only expose 'accelerationIncludingGravity' — are
 * erased here.
 *
 * Browser module: guarded so it can be imported during SSR, but 'start()' only
 * does anything in a real window.
 */

import type { CalibrationData, ControllerStateExt, ControllerStatus, SensorSample } from '@/types';
import { Calibrator } from '@/controller/calibration/calibrator';
import { OneEuroFilter, Vec3LowPass } from '@/controller/filtering/filters';
import { GestureDetector } from '@/controller/gestures/gestureDetector';

import { detectMotionCapabilities } from '@/controller/sensors/permission';
import { DEG2RAD, RAD2DEG, clamp, damp, nowSeconds, wrapAngle } from '@/game/core/math';

export interface SensorAdapterOptions {
  playerId: string;
  /** Debug mode: drive the state from keyboard/mouse instead of sensors. */
  debug?: boolean;
}

/** Used only by the debug keyboard path to synthesise plausible tilt values. */
const FULL_SCALE_RAD = 40 * DEG2RAD;

/** Full-press glide speed, in normalised units (−1..1 space) per second. */
const TOUCH_MAX_SPEED = 0.85;
/** Presses this close to the centre are ignored (resting thumbs). */
const TOUCH_DEAD_ZONE = 0.12;

/**
 * Touch offset → glide speed fraction. Dead zone, then a gentle square curve:
 * the edge of the screen is full speed, half-way is about a quarter.
 */
export const touchCurve = (v: number): number => {
  const a = Math.abs(v);
  if (a <= TOUCH_DEAD_ZONE) return 0;
  const t = Math.min(1, (a - TOUCH_DEAD_ZONE) / (1 - TOUCH_DEAD_ZONE));
  return Math.sign(v) * t * t;
};

/** Gravity estimator smoothing (§6.3). ~0.2 s time constant at 60 Hz. */
const GRAVITY_ALPHA = 0.08;
/** Drift correction is suppressed above either of these. */
const MOVING_SHAKE = 0.06;
const MOVING_TILT_RATE = 2 * DEG2RAD; // rad/s
/** Consecutive exactly-zero 'acceleration' readings before we call it broken. */
const ZERO_ACCEL_STREAK = 40;

/** Keys the debug scheme owns; swallowed so the page does not scroll. */
const DEBUG_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'Space',
  'ShiftLeft',
  'ShiftRight',
]);

const EMPTY_SAMPLE = (): SensorSample => ({
  alpha: 0,
  beta: 0,
  gamma: 0,
  absolute: false,
  ax: 0,
  ay: 0,
  az: 0,
  gx: 0,
  gy: 0,
  gz: 0,
  rotA: 0,
  rotB: 0,
  rotG: 0,
  t: 0,
});

const num = (v: number | null | undefined): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;

/** Current screen rotation in degrees, normalised to [0, 360). */
const screenAngle = (): number => {
  if (typeof window === 'undefined') return 0;
  const angle = window.screen?.orientation?.angle;
  if (typeof angle === 'number' && Number.isFinite(angle)) return ((angle % 360) + 360) % 360;
  // Safari < 16.4 and old Android only have the deprecated window.orientation.
  const legacy = (window as unknown as { orientation?: number }).orientation;
  if (typeof legacy === 'number' && Number.isFinite(legacy)) return ((legacy % 360) + 360) % 360;
  return 0;
};

const normalizeDegrees360 = (deg: number): number => {
  const r = deg % 360;
  return r < 0 ? r + 360 : r;
};

/**
 * Re-express a (alpha, beta, gamma) triple in the SCREEN frame.
 *
 * The device orientation matrix is R = Rz(α)·Rx(β)·Ry(γ) (W3C). A screen rotated
 * by θ means the frame the player actually sees is R' = R·Rz(−θ); decomposing R'
 * back into ZXY Euler angles gives the tilt of the *screen*, which is what the
 * player is aiming with. Without this the poi flies sideways in landscape.
 *
 * Done as a full matrix round-trip rather than the usual small-angle axis swap so
 * beta keeps its ±180° range and nothing snaps when the phone is held steeply.
 *
 * Exported for tests: landscape play is easy to break and impossible to notice
 * on a desktop.
 */
export const rotateOrientationToScreen = (
  alphaDeg: number,
  betaDeg: number,
  gammaDeg: number,
  angleDeg: number,
  out: { alpha: number; beta: number; gamma: number },
): void => {
  if (angleDeg === 0) {
    out.alpha = alphaDeg;
    out.beta = betaDeg;
    out.gamma = gammaDeg;
    return;
  }

  const a = alphaDeg * DEG2RAD;
  const b = betaDeg * DEG2RAD;
  const g = gammaDeg * DEG2RAD;
  const sA = Math.sin(a);
  const cA = Math.cos(a);
  const sB = Math.sin(b);
  const cB = Math.cos(b);
  const sG = Math.sin(g);
  const cG = Math.cos(g);

  const m00 = cA * cG - sA * sB * sG;
  const m01 = -cB * sA;
  const m10 = sA * cG + cA * sB * sG;
  const m11 = cA * cB;
  const m20 = -cB * sG;
  const m21 = sB;
  const m22 = cB * cG;

  const s = Math.sin(angleDeg * DEG2RAD);
  const c = Math.cos(angleDeg * DEG2RAD);
  const n00 = m00 * c - m01 * s;
  const n01 = m00 * s + m01 * c;
  const n10 = m10 * c - m11 * s;
  const n11 = m10 * s + m11 * c;
  const n20 = m20 * c - m21 * s;
  const n21 = m20 * s + m21 * c;
  const n22 = m22;

  // |cos β'| = hypot(n20, n22) because gamma is constrained to [-90°, 90°]
  // (so cos γ' ≥ 0), which also makes sign(cos β') = sign(n22).
  const mag = Math.hypot(n20, n22);
  const cBeta = n22 < 0 ? -mag : mag;

  if (mag < 1e-7) {
    // Gimbal lock: the screen is exactly edge-on, yaw and roll are the same axis.
    out.alpha = normalizeDegrees360(Math.atan2(n10, n00) * RAD2DEG);
    out.beta = n21 >= 0 ? 90 : -90;
    out.gamma = 0;
    return;
  }

  const sgn = cBeta < 0 ? -1 : 1;
  out.alpha = normalizeDegrees360(Math.atan2(-n01 * sgn, n11 * sgn) * RAD2DEG);
  out.beta = Math.atan2(n21, cBeta) * RAD2DEG;
  out.gamma = Math.atan2(-n20 * sgn, n22 * sgn) * RAD2DEG;
};

/**
 * Roll/pitch of the device derived from the smoothed gravity direction.
 *
 * This is deliberately NOT the DeviceOrientation beta/gamma pair: those Euler
 * angles come from a sensor-fusion stack that some Androids feed with the
 * compass (venues are full of speakers and steel), and their conventions vary
 * by platform. The accelerometer's gravity vector is the one thing every phone
 * agrees on, and it has no singularity anywhere near a scoop grip.
 *
 * 'sZ' fixes the platform sign convention (+1 when the resting gravity unit has
 * a negative Z in screen axes — the W3C convention — and −1 on iOS-style
 * inverted reports). It is captured once at calibration.
 *
 *   roll  > 0 : right edge of the phone dips
 *   pitch > 0 : top edge tips away from the player
 */
export const gravityAngles = (
  gx: number,
  gy: number,
  gz: number,
  sZ: number,
): { roll: number; pitch: number } => {
  const x = gx * sZ;
  const y = gy * sZ;
  const z = gz * sZ;
  return { roll: Math.atan2(x, -z), pitch: Math.atan2(y, -z) };
};

/** Which sign puts the resting gravity unit into the canonical (z<0) hemisphere. */
export const gravityHemisphere = (gz: number): number => (gz <= 0 ? 1 : -1);




export class SensorAdapter {
  private playerId: string;
  private running = false;
  private readonly debug: boolean;

  private readonly calibrator = new Calibrator();
  private readonly gestures = new GestureDetector();
  private readonly gravityLP = new Vec3LowPass(GRAVITY_ALPHA);

  /** Neutral grip captured at calibration, in gravity-angle space (radians). */
  private neutralRoll = 0;
  private neutralPitch = 0;
  /** Platform sign of the resting gravity unit (see 'gravityHemisphere'). */
  private gravSign = 1;
  private hasNeutral = false;

  /** Where the player is pressing, −1..1 each axis; (0,0) when not touching. */
  private readonly touchVec = { x: 0, y: 0 };
  /** The virtual poi position the touch drives. */
  private readonly touchPos = { x: 0, y: 0 };
  private prevTiltYForFlick = 0;
  private flickRate = 0;
  private readonly euroX = new OneEuroFilter({ minCutoff: 1.0, beta: 0.012 });
  private readonly euroY = new OneEuroFilter({ minCutoff: 1.0, beta: 0.012 });
  private readonly euroZ = new OneEuroFilter({ minCutoff: 0.8, beta: 0.008 });

  private readonly raw: SensorSample = EMPTY_SAMPLE();
  private hasSample = false;
  private hasOrientationData = false;
  private hasMotionData = false;
  private usedAbsoluteFallback = false;
  private zeroAccelStreak = 0;

  /** Unit vector pointing ALONG gravity (downwards), in screen-corrected axes. */
  private gravUnitX = 0;
  private gravUnitY = 0;
  private gravUnitZ = -1;
  /** World-up component of linear acceleration, m/s². Positive = lifting. */
  private vAcc = 0;

  private poiInWater = false;
  private lastSampleT = 0;
  private prevTiltX = 0;
  private prevTiltY = 0;
  private tiltRate = 0;

  private rateCount = 0;
  private rateWindowStart = 0;

  private readonly oriented = { alpha: 0, beta: 0, gamma: 0 };

  private readonly statusObj: ControllerStatus = {
    supported: false,
    permission: 'unknown',
    sampleRate: 0,
    hasOrientation: false,
    hasMotion: false,
    gravityOnly: false,
  };

  private readonly stateObj: ControllerStateExt = {
    playerId: '',
    x: 0,
    y: 0,
    tiltX: 0,
    tiltY: 0,
    verticalAcceleration: 0,
    isSubmerging: false,
    isLifting: false,
    timestamp: 0,
    tiltZ: 0,
    handOffsetY: 0,
    handVelocityY: 0,
    liftPeakAccel: 0,
    shake: 0,
  };

  // --- debug (§120: development input only, never the finished control scheme)
  private readonly keys = new Set<string>();
  private debugX = 0;
  private debugY = 0;
  private debugSubmergeUntil = 0;
  private debugLiftUntil = 0;
  private debugHeldSpace = false;
  private debugPitch = 0;

  private readonly onOrientation = (e: DeviceOrientationEvent): void => {
    this.hasOrientationData = true;
    this.ingestOrientation(e, false);
  };

  // 'deviceorientationabsolute' is not in the DOM lib's event map, so this one
  // is typed as a plain Event listener and narrowed on the way in.
  private readonly onOrientationAbsolute = (e: Event): void => {
    // Only a fallback: if the plain event fires we ignore this one entirely.
    if (this.hasOrientationData) return;
    this.usedAbsoluteFallback = true;
    this.ingestOrientation(e as DeviceOrientationEvent, true);
  };

  private readonly onMotion = (e: DeviceMotionEvent): void => {
    this.hasMotionData = true;
    this.ingestMotion(e);
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!DEBUG_KEYS.has(e.code)) return;
    e.preventDefault();
    this.keys.add(e.code);
    if (e.repeat) return;
    const t = nowSeconds();
    if (e.code === 'Space') {
      this.debugHeldSpace = true;
      this.debugSubmergeUntil = t + 0.16;
    } else if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
      this.debugLiftUntil = t + 0.16;
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (!DEBUG_KEYS.has(e.code)) return;
    e.preventDefault();
    this.keys.delete(e.code);
    if (e.code === 'Space' && this.debugHeldSpace) {
      this.debugHeldSpace = false;
      // Releasing space = raising the hand out of the water.
      this.debugLiftUntil = nowSeconds() + 0.16;
    }
  };

  private readonly onBlur = (): void => {
    this.keys.clear();
    this.debugHeldSpace = false;
  };

  constructor(opts: SensorAdapterOptions) {
    this.playerId = opts.playerId;
    this.debug = opts.debug === true;
    this.stateObj.playerId = opts.playerId;
  }

  /** Attaches listeners. Assumes permission is already granted. */
  start(): void {
    if (this.running || typeof window === 'undefined') return;
    this.running = true;

    if (this.debug) {
      this.statusObj.supported = true;
      this.statusObj.permission = 'granted';
      this.statusObj.hasOrientation = true;
      this.statusObj.hasMotion = true;
      this.statusObj.gravityOnly = false;
      window.addEventListener('keydown', this.onKeyDown);
      window.addEventListener('keyup', this.onKeyUp);
      window.addEventListener('blur', this.onBlur);
      return;
    }

    const caps = detectMotionCapabilities();
    this.statusObj.supported = caps.hasOrientation || caps.hasMotion;
    this.statusObj.hasOrientation = caps.hasOrientation;
    this.statusObj.hasMotion = caps.hasMotion;
    this.statusObj.permission = this.statusObj.supported ? 'unknown' : 'unsupported';

    if (caps.hasOrientation) {
      window.addEventListener('deviceorientation', this.onOrientation);
      window.addEventListener('deviceorientationabsolute', this.onOrientationAbsolute);
    }
    if (caps.hasMotion) {
      window.addEventListener('devicemotion', this.onMotion);
    }
  }

  stop(): void {
    if (!this.running || typeof window === 'undefined') {
      this.running = false;
      return;
    }
    this.running = false;
    window.removeEventListener('deviceorientation', this.onOrientation);
    window.removeEventListener('deviceorientationabsolute', this.onOrientationAbsolute);
    window.removeEventListener('devicemotion', this.onMotion);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.keys.clear();
    this.debugHeldSpace = false;
  }

  get status(): ControllerStatus {
    return this.statusObj;
  }

  get state(): ControllerStateExt {
    return this.stateObj;
  }

  get lastSample(): SensorSample | null {
    return this.hasSample ? this.raw : null;
  }

  get calibration(): CalibrationData | null {
    return this.calibrator.data;
  }

  /** True while a plain 'deviceorientation' never arrived and we fell back. */
  get usingAbsoluteOrientation(): boolean {
    return this.usedAbsoluteFallback;
  }

  beginCalibration(): void {
    if (this.debug) return;
    this.calibrator.begin();
  }

  /**
   * Ends the 3・2・1 window. Returns false when not a single usable sample
   * arrived, so the UI can tell the player their sensors are dead.
   */
  finishCalibration(): boolean {
    // Keyboard play has no neutral pose to capture; never block the countdown.
    if (this.debug) {
      this.gestures.reset();
      return true;
    }
    const d = this.calibrator.finish();
    if (!d) return false;
    this.captureNeutral();
    // The poi returns to centre with the fresh neutral — same as a real player
    // stepping back up to the tank.
    this.touchPos.x = 0;
    this.touchPos.y = 0;
    this.flickRate = 0;
    // Start the round from a clean filter/gesture state.
    this.euroX.reset();
    this.euroY.reset();
    this.euroZ.reset();
    this.gestures.reset();
    this.prevTiltX = 0;
    this.prevTiltY = 0;
    this.tiltRate = 0;
    return true;
  }

  /** Server tells us whether our poi is actually in the water (§34). */
  setPoiInWater(v: boolean): void {
    this.poiInWater = v;
  }

  /**
   * The touch steering input from the phone UI (owner redesign of §23):
   * x = +1 pressing at the right edge, y = +1 pressing at the top edge.
   * (0, 0) whenever no finger is down.
   */
  setTouchVector(x: number, y: number): void {
    this.touchVec.x = clamp(Number.isFinite(x) ? x : 0, -1, 1);
    this.touchVec.y = clamp(Number.isFinite(y) ? y : 0, -1, 1);
  }

  setPlayerId(id: string): void {
    this.playerId = id;
    this.stateObj.playerId = id;
  }

  /** Compute a fresh ControllerStateExt. Call once per animation frame. */
  sample(now: number): ControllerStateExt {
    const t = Number.isFinite(now) ? now : nowSeconds();
    const dt = this.lastSampleT > 0 ? clamp(t - this.lastSampleT, 1 / 240, 0.1) : 1 / 60;
    this.lastSampleT = t;

    if (this.debug) return this.sampleDebug(t, dt);

    const s = this.raw;
    s.t = t;

    // With no motion events at all we can still derive the up direction from the
    // orientation angles, so tilt keeps working on sensor-poor devices.
    if (!this.hasMotionData) {
      const b = s.beta * DEG2RAD;
      const g = s.gamma * DEG2RAD;
      this.gravUnitX = Math.cos(b) * Math.sin(g);
      this.gravUnitY = -Math.sin(b);
      this.gravUnitZ = -Math.cos(b) * Math.cos(g);
      this.vAcc = 0;
    }

    // Never average the all-zero placeholder: without a real event yet, a
    // "successful" calibration would neutral out to a pose nobody is holding.
    if (this.calibrator.collecting && this.hasSample) this.calibrator.addSample(s);

    // Drift correction uses the PREVIOUS frame's motion estimate — one frame of
    // lag is nothing against a 25 s time constant.
    const moving = this.stateObj.shake > MOVING_SHAKE || this.tiltRate > MOVING_TILT_RATE;
    this.calibrator.updateDrift(s, dt, moving);

    // Tilt comes from the GRAVITY VECTOR, not from beta/gamma. The Euler pair is
    // platform-dependent and, on many Androids, compass-fused — at a venue full
    // of speakers and scaffolding it visibly wanders. Gravity does not.
    if (!this.hasNeutral && this.hasSample) this.captureNeutral();
    const ang = gravityAngles(this.gravUnitX, this.gravUnitY, this.gravUnitZ, this.gravSign);
    const rawTiltX = wrapAngle(ang.roll - this.neutralRoll);
    const rawTiltY = -wrapAngle(ang.pitch - this.neutralPitch);

    // A tired wrist slowly becomes the new neutral — but only while still, so
    // real steering is never fought (§6.2).
    if (!moving && this.hasNeutral) {
      const k = dt / 25;
      this.neutralRoll += wrapAngle(ang.roll - this.neutralRoll) * k;
      this.neutralPitch += wrapAngle(ang.pitch - this.neutralPitch) * k;
    }

    const tiltX = this.euroX.next(rawTiltX, dt);
    const tiltY = this.euroY.next(rawTiltY, dt);
    // Yaw is invisible to gravity; the orientation event still supplies the spin.
    const tiltZ = this.euroZ.next(this.calibrator.apply(s).tiltZ, dt);

    const rate = Math.hypot(tiltX - this.prevTiltX, tiltY - this.prevTiltY) / dt;
    this.tiltRate = damp(this.tiltRate, rate, 0.15, dt);
    this.prevTiltX = tiltX;
    this.prevTiltY = tiltY;

    // Pitch rate for the violence measure: how fast the face of the phone is
    // swinging. Gravity-derived, so it is platform-safe.
    const rawRate = (tiltY - this.prevTiltYForFlick) / dt;
    this.prevTiltYForFlick = tiltY;
    this.flickRate = damp(this.flickRate, rawRate, 0.045, dt);

    // Angle-based gesture model (owner redesign): pitch down = into the water,
    // pitch up = scoop. Nothing here integrates acceleration, so no device
    // sign convention can invert it and nothing can drift.
    const g = this.gestures.update(
      { tiltY, pitchRate: this.flickRate, verticalAcceleration: this.vAcc },
      dt,
      t,
    );

    // Horizontal control = TOUCH (owner redesign, replacing phone translation):
    // pressing toward the right edge of the screen glides the poi right, etc.
    // The virtual position this integrates IS what the server receives.
    this.touchPos.x = clamp(
      this.touchPos.x + touchCurve(this.touchVec.x) * TOUCH_MAX_SPEED * dt,
      -1,
      1,
    );
    this.touchPos.y = clamp(
      this.touchPos.y - touchCurve(this.touchVec.y) * TOUCH_MAX_SPEED * dt,
      -1,
      1,
    );

    const st = this.stateObj;
    st.playerId = this.playerId;
    st.x = this.touchPos.x;
    st.y = this.touchPos.y;
    st.tiltX = tiltX;
    st.tiltY = tiltY;
    st.tiltZ = tiltZ;
    st.verticalAcceleration = this.vAcc;
    st.isSubmerging = g.isSubmerging;
    st.isLifting = g.isLifting;
    st.handOffsetY = g.handOffsetY;
    st.handVelocityY = g.handVelocityY;
    st.liftPeakAccel = g.liftPeakAccel;
    st.shake = g.shake;
    st.timestamp = t;
    return st;
  }

  // -------------------------------------------------------------------------
  // raw event ingestion
  // -------------------------------------------------------------------------

  private ingestOrientation(e: DeviceOrientationEvent, absolute: boolean): void {
    this.noteEvent();
    this.statusObj.permission = 'granted';
    this.hasSample = true;

    rotateOrientationToScreen(
      num(e.alpha),
      num(e.beta),
      num(e.gamma),
      screenAngle(),
      this.oriented,
    );
    const s = this.raw;
    s.alpha = this.oriented.alpha;
    s.beta = this.oriented.beta;
    s.gamma = this.oriented.gamma;
    s.absolute = absolute || e.absolute === true;
  }

  private ingestMotion(e: DeviceMotionEvent): void {
    this.noteEvent();
    this.statusObj.permission = 'granted';
    this.hasSample = true;

    const angle = screenAngle();
    const rad = angle * DEG2RAD;
    const c = Math.cos(rad);
    const sn = Math.sin(rad);
    const s = this.raw;

    const incl = e.accelerationIncludingGravity;
    // Screen frame = device frame rotated by +angle about Z.
    const igx = num(incl?.x) * c - num(incl?.y) * sn;
    const igy = num(incl?.x) * sn + num(incl?.y) * c;
    const igz = num(incl?.z);
    s.gx = igx;
    s.gy = igy;
    s.gz = igz;

    const rot = e.rotationRate;
    const rb = num(rot?.beta);
    const rg = num(rot?.gamma);
    s.rotA = num(rot?.alpha);
    s.rotB = rb * c - rg * sn;
    s.rotG = rb * sn + rg * c;

    const acc = e.acceleration;
    let lx: number;
    let ly: number;
    let lz: number;

    if (acc && typeof acc.x === 'number' && typeof acc.y === 'number' && typeof acc.z === 'number') {
      const rx = num(acc.x);
      const ry = num(acc.y);
      const rz = num(acc.z);
      // Some Android builds expose 'acceleration' but never populate it. A live
      // accelerometer never reads exactly 0.0 on all three axes for long.
      if (rx === 0 && ry === 0 && rz === 0) {
        this.zeroAccelStreak++;
        if (this.zeroAccelStreak >= ZERO_ACCEL_STREAK) this.statusObj.gravityOnly = true;
      } else {
        this.zeroAccelStreak = 0;
      }
      lx = rx * c - ry * sn;
      ly = rx * sn + ry * c;
      lz = rz;
    } else {
      this.statusObj.gravityOnly = true;
      lx = 0;
      ly = 0;
      lz = 0;
    }

    // Gravity estimate: a slow low pass over includingGravity keeps only the
    // steady 1 g component.
    const grav = this.gravityLP.next(igx, igy, igz);
    const len = Math.hypot(grav.x, grav.y, grav.z);

    if (this.statusObj.gravityOnly) {
      lx = igx - grav.x;
      ly = igy - grav.y;
      lz = igz - grav.z;
    }

    s.ax = lx;
    s.ay = ly;
    s.az = lz;

    if (len > 1e-3) {
      // 'accelerationIncludingGravity' reports the REACTION to gravity, so the
      // gravity direction itself is the negated low pass.
      this.gravUnitX = -grav.x / len;
      this.gravUnitY = -grav.y / len;
      this.gravUnitZ = -grav.z / len;
    }

    // World-vertical linear acceleration. Since the angle-based redesign this
    // feeds only the shake/violence measures, which use its MAGNITUDE — so the
    // notorious per-platform sign conventions cannot break anything here.
    this.vAcc = -(lx * this.gravUnitX + ly * this.gravUnitY + lz * this.gravUnitZ);
  }

  /** Freeze the current grip as "phone level ⇒ poi centred" (§28). */
  private captureNeutral(): void {
    const len = Math.hypot(this.gravUnitX, this.gravUnitY, this.gravUnitZ);
    if (len < 0.5) return; // no believable gravity yet
    this.gravSign = gravityHemisphere(this.gravUnitZ);
    const ang = gravityAngles(this.gravUnitX, this.gravUnitY, this.gravUnitZ, this.gravSign);
    this.neutralRoll = ang.roll;
    this.neutralPitch = ang.pitch;
    this.hasNeutral = true;
  }

  /** Rolling observed sample rate for 'status.sampleRate'. */
  private noteEvent(): void {
    const t = nowSeconds();
    if (this.rateWindowStart === 0) {
      this.rateWindowStart = t;
      this.rateCount = 0;
    }
    this.rateCount++;
    const elapsed = t - this.rateWindowStart;
    if (elapsed >= 0.5) {
      this.statusObj.sampleRate = Math.round(this.rateCount / elapsed);
      this.rateCount = 0;
      this.rateWindowStart = t;
    }
  }

  // -------------------------------------------------------------------------
  // debug input (§120) — desktop development only, NOT the finished control scheme
  // -------------------------------------------------------------------------

  private sampleDebug(t: number, dt: number): ControllerStateExt {
    this.noteEvent();
    const k = this.keys;
    const left = k.has('ArrowLeft') || k.has('KeyA') ? 1 : 0;
    const right = k.has('ArrowRight') || k.has('KeyD') ? 1 : 0;
    const up = k.has('ArrowUp') || k.has('KeyW') ? 1 : 0;
    const down = k.has('ArrowDown') || k.has('KeyS') ? 1 : 0;

    // ArrowUp pushes the poi away from the player (奥へ, −Z) → y = −1.
    this.debugX = damp(this.debugX, right - left, 0.12, dt);
    this.debugY = damp(this.debugY, down - up, 0.12, dt);

    // Synthesise a plausible PITCH trace and run the REAL angle-based detector,
    // so debug play exercises the same state machine: holding Space = the phone
    // pitched down (in the water); tapping Shift = a quick tilt-up (the scoop).
    const targetPitch = this.debugHeldSpace
      ? -20 * DEG2RAD
      : t < this.debugLiftUntil
        ? 22 * DEG2RAD
        : 0;
    const prevPitch = this.debugPitch;
    this.debugPitch = damp(this.debugPitch, targetPitch, 0.07, dt);
    const pitchRate = (this.debugPitch - prevPitch) / Math.max(dt, 1e-4);

    const g = this.gestures.update(
      { tiltY: this.debugPitch, pitchRate, verticalAcceleration: 0 },
      dt,
      t,
    );

    const st = this.stateObj;
    st.playerId = this.playerId;
    st.x = clamp(this.debugX, -1, 1);
    st.y = clamp(this.debugY, -1, 1);
    st.tiltX = st.x * FULL_SCALE_RAD;
    st.tiltY = this.debugPitch;
    st.tiltZ = 0;
    st.verticalAcceleration = 0;
    st.isSubmerging = g.isSubmerging;
    st.isLifting = g.isLifting;
    st.handOffsetY = g.handOffsetY;
    st.handVelocityY = g.handVelocityY;
    st.liftPeakAccel = g.liftPeakAccel;
    st.shake = g.shake;
    st.timestamp = t;

    // Keep 'lastSample' meaningful in debug too (the bowl water effect reads it).
    const s = this.raw;
    s.t = t;
    s.beta = st.tiltY * RAD2DEG;
    s.gamma = st.tiltX * RAD2DEG;
    s.az = 0;
    this.hasSample = true;

    return st;
  }
}
