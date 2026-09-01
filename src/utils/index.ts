/**
 * Shared helpers that do not belong to a single subsystem.
 *
 * Most utility code lives closer to where it is used — vectors and easing in
 * `@/game/core/math`, filters in `@/controller/filtering` — so this stays small
 * on purpose.
 */

/** Formats a duration for the on-screen clock: 12.4 under ten seconds, else 0:12. */
export const formatClock = (seconds: number): string => {
  const s = Math.max(0, seconds);
  if (s < 10) return s.toFixed(1);
  const m = Math.floor(s / 60);
  const rem = Math.floor(s % 60);
  return m > 0 ? `${m}:${String(rem).padStart(2, '0')}` : String(rem);
};

/** 1st / 2nd / 3rd / 4th — used on the result screen alongside the Japanese 「n位」. */
export const ordinal = (n: number): string => {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
};

/** Room ids travel in URLs and must match the server's normalisation exactly. */
export const normalizeRoomId = (raw: string): string =>
  (raw || 'DEFAULT')
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '')
    .slice(0, 24) || 'DEFAULT';

/** True when the page can actually use the motion sensors (spec §20, iOS/Chrome). */
export const canUseMotionSensors = (): boolean =>
  typeof window !== 'undefined' && window.isSecureContext;
