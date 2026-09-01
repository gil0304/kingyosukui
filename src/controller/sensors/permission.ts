/**
 * Motion sensor capability detection and permission request (spec §20).
 *
 * iOS 13+ hides DeviceOrientation/DeviceMotion behind a permission prompt that
 * may ONLY be raised from inside a user gesture, and only over HTTPS. That is
 * the entire reason the phone's first screen is a single「参加する」button.
 *
 * Every 'window' access is guarded so this module can be imported during SSR.
 */

export type PermissionResult = 'granted' | 'denied' | 'unsupported' | 'unknown';

export interface MotionCapabilities {
  hasOrientation: boolean;
  hasMotion: boolean;
  needsPermission: boolean;
  secureContext: boolean;
}

/** iOS-only static on the event constructors; absent everywhere else. */
type PermissionCapable = {
  requestPermission?: () => Promise<string>;
};

const hasWindow = (): boolean => typeof window !== 'undefined';

const orientationCtor = (): PermissionCapable | null => {
  if (!hasWindow() || typeof DeviceOrientationEvent === 'undefined') return null;
  return DeviceOrientationEvent as unknown as PermissionCapable;
};

const motionCtor = (): PermissionCapable | null => {
  if (!hasWindow() || typeof DeviceMotionEvent === 'undefined') return null;
  return DeviceMotionEvent as unknown as PermissionCapable;
};

export function detectMotionCapabilities(): MotionCapabilities {
  if (!hasWindow()) {
    return {
      hasOrientation: false,
      hasMotion: false,
      needsPermission: false,
      secureContext: false,
    };
  }

  const orientation = orientationCtor();
  const motion = motionCtor();

  return {
    hasOrientation: orientation !== null,
    hasMotion: motion !== null,
    // iOS 13+ gates both events; DeviceMotionEvent is the canonical probe, but a
    // browser that gates only one of the two still needs the prompt.
    needsPermission:
      typeof motion?.requestPermission === 'function' ||
      typeof orientation?.requestPermission === 'function',
    secureContext: window.isSecureContext === true,
  };
}

/**
 * MUST be called from inside a user gesture (iOS 13+).
 *
 * iOS gates DeviceOrientation and DeviceMotion SEPARATELY, and a poi that tilts
 * but never scoops is worse than no poi at all — so both have to be asked for.
 *
 * The subtle part, and the bug this function was written wrong for once: iOS
 * consumes the page's user activation at the FIRST call. Requesting the two in
 * sequence —
 *
 *     await askOrientation();   // fine: still inside the gesture
 *     await askMotion();        // NotAllowedError: the gesture is gone
 *
 * — means the player taps 参加する, grants the first prompt, and is then told
 * permission was denied. So both requests are STARTED synchronously, inside the
 * gesture, and only then awaited together. Never rewrite this as a for-await.
 */
export async function requestMotionPermission(): Promise<PermissionResult> {
  const orientation = orientationCtor();
  const motion = motionCtor();

  if (!orientation && !motion) return 'unsupported';

  const askOrientation = orientation?.requestPermission;
  const askMotion = motion?.requestPermission;

  // Start every request NOW, before the first await. Wrapping each in its own
  // try keeps a constructor that throws synchronously from taking the other down.
  const pending: Array<Promise<string>> = [];
  if (typeof askOrientation === 'function') {
    try {
      pending.push(Promise.resolve(askOrientation.call(orientation)));
    } catch {
      pending.push(Promise.resolve('denied'));
    }
  }
  if (typeof askMotion === 'function') {
    try {
      pending.push(Promise.resolve(askMotion.call(motion)));
    } catch {
      pending.push(Promise.resolve('denied'));
    }
  }

  // Browsers without the gate (Android Chrome, desktop) expose the events freely.
  if (pending.length === 0) return 'granted';

  const settled = await Promise.allSettled(pending);

  let granted = 0;
  let denied = 0;
  for (const r of settled) {
    if (r.status === 'rejected') {
      denied++;
      continue;
    }
    if (r.value === 'granted') granted++;
    else if (r.value === 'denied') denied++;
    // 'default' / 'prompt': the sheet was dismissed without a decision.
  }

  // One granted sensor is enough to play: the SensorAdapter derives the up
  // direction from orientation alone when motion is unavailable. Refusing to
  // start because the *other* prompt was awkward would strand the player.
  if (granted > 0) return 'granted';
  if (denied > 0) return 'denied';
  return 'unknown';
}
