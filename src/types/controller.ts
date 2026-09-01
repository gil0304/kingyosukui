import type { PlayerId } from './ids';

/** Raw sample straight off the browser events, before any processing. */
export interface SensorSample {
  /** DeviceOrientation, degrees. */
  alpha: number;
  beta: number;
  gamma: number;
  /** True when the browser supplied an absolute (compass-referenced) alpha. */
  absolute: boolean;

  /** DeviceMotion linear acceleration (gravity removed), m/s². Device axes. */
  ax: number;
  ay: number;
  az: number;

  /** DeviceMotion acceleration including gravity, m/s². Device axes. */
  gx: number;
  gy: number;
  gz: number;

  /** Rotation rate, deg/s. */
  rotA: number;
  rotB: number;
  rotG: number;

  /** performance.now()-based timestamp, seconds. */
  t: number;
}

/** Spec §28 — the neutral pose captured while the player holds the phone naturally. */
export interface CalibrationData {
  alpha: number;
  beta: number;
  gamma: number;
  /** Estimated device-frame gravity direction at rest (normalised). */
  gravityX: number;
  gravityY: number;
  gravityZ: number;
  capturedAt: number;
  /** Number of samples averaged. */
  samples: number;
}

/**
 * Spec §27 — the ONLY shape the game logic is allowed to consume.
 * Device differences are erased by the SensorAdapter before this is produced.
 */
export interface ControllerState {
  playerId: PlayerId;

  /** Normalised lateral target, -1 (left) .. +1 (right). */
  x: number;
  /** Normalised depth target, -1 (far / 奥) .. +1 (near / 手前). */
  y: number;

  /** Calibrated roll (left/right tilt), radians. */
  tiltX: number;
  /** Calibrated pitch (front/back tilt), radians. */
  tiltY: number;

  /** World-up component of linear acceleration, m/s². Positive = lifting. */
  verticalAcceleration: number;

  isSubmerging: boolean;
  isLifting: boolean;

  /** performance.now()-based timestamp, seconds. */
  timestamp: number;
}

/**
 * Everything else the poi simulation and the durability model need.
 * Kept as an extension so 'ControllerState' stays exactly as specified.
 */
export interface ControllerStateExt extends ControllerState {
  /** Calibrated yaw delta, radians — spins the poi visually. */
  tiltZ: number;
  /** Leaky-integrated vertical hand displacement, metres. Positive = raised. */
  handOffsetY: number;
  /** Leaky-integrated vertical hand velocity, m/s. Positive = lifting. */
  handVelocityY: number;
  /** Peak |verticalAcceleration| observed during the current lift, m/s². */
  liftPeakAccel: number;
  /** Shake magnitude 0..1 — used only for feedback, never for capturing. */
  shake: number;
}

export type GesturePhase = 'Idle' | 'Descending' | 'Submerged' | 'Lifting' | 'Raised';

export interface GestureEvent {
  type: 'SUBMERGE' | 'LIFT' | 'SETTLE' | 'SHAKE';
  strength: number;
  t: number;
}

export interface ControllerStatus {
  supported: boolean;
  permission: 'unknown' | 'granted' | 'denied' | 'unsupported';
  /** Effective sample rate observed, Hz. */
  sampleRate: number;
  hasOrientation: boolean;
  hasMotion: boolean;
  /** True when accelerationIncludingGravity is present but acceleration is not. */
  gravityOnly: boolean;
}
