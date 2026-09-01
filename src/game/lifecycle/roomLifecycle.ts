/**
 * Room phase machine (spec §42, §43, §97, §98, §107).
 *
 *   WAITING ──(admin / everyone ready)──> CALIBRATION ──> COUNTDOWN
 *   ──> PLAYING ──(time up)──> RESULT ──> WAITING
 *
 * Driven by absolute epoch milliseconds ('Date.now()') so every client can be
 * told exactly when the current phase ends and run its own countdown without
 * asking again. Only WAITING is open-ended — it waits for people, not a clock.
 *
 * [PURE] no 'three', no react, no browser globals.
 */

import { GAME } from '@/game/core/constants';
import { clamp } from '@/game/core/math';
import type { RoomState } from '@/types';

export interface PhaseInfo {
  state: RoomState;
  startedAt: number;
  endsAt: number | null;
}

export interface LifecycleCallbacks {
  onEnter?(s: RoomState): void;
  onExit?(s: RoomState): void;
}

/** The phase that follows automatically once the current one expires. */
export function nextAutoState(s: RoomState): RoomState | null {
  switch (s) {
    // WAITING never expires: it ends when the room is started, not on a clock.
    case 'WAITING':
      return null;
    case 'CALIBRATION':
      return 'COUNTDOWN';
    case 'COUNTDOWN':
      return 'PLAYING';
    case 'PLAYING':
      return 'RESULT';
    case 'RESULT':
      return 'WAITING';
    default:
      return null;
  }
}

/**
 * The screen shows 3 · 2 · 1, never 4 — the phases are a touch longer than
 * three seconds so the last number has room to breathe before the cut.
 */
const MAX_COUNT = 3;

export class RoomLifecycle {
  private readonly cb: LifecycleCallbacks;

  private current: RoomState = 'WAITING';
  private phaseStart: number;
  private phaseEnd: number | null = null;

  /** Round length for an auto-advance into PLAYING; set from room settings. */
  private playingDuration = GAME.defaultDurationSeconds;

  constructor(cb: LifecycleCallbacks = {}) {
    this.cb = cb;
    this.phaseStart = Date.now();
  }

  get state(): RoomState {
    return this.current;
  }

  get startedAt(): number {
    return this.phaseStart;
  }

  get endsAt(): number | null {
    return this.phaseEnd;
  }

  /** Length of the next PLAYING phase, seconds. */
  get playingSeconds(): number {
    return this.playingDuration;
  }

  /**
   * Tell the lifecycle how long the round is, so an automatic
   * COUNTDOWN -> PLAYING transition uses the room's own setting (§97).
   */
  setPlayingDuration(seconds: number): void {
    if (!Number.isFinite(seconds)) return;
    this.playingDuration = clamp(seconds, GAME.minDurationSeconds, GAME.maxDurationSeconds);
  }

  /** Seconds left in the current phase; 0 for an open-ended phase. */
  timeRemaining(nowMs: number): number {
    if (this.phaseEnd === null) return 0;
    const left = (this.phaseEnd - nowMs) / 1000;
    return left > 0 ? left : 0;
  }

  /** Integer countdown during CALIBRATION / COUNTDOWN, else null (§98). */
  countdown(nowMs: number): number | null {
    if (this.current !== 'CALIBRATION' && this.current !== 'COUNTDOWN') return null;
    const left = this.timeRemaining(nowMs);
    if (left <= 0) return 0;
    return Math.min(MAX_COUNT, Math.ceil(left));
  }

  /**
   * Enter 'state' now. 'durationSeconds' overrides the phase default; pass the
   * room's configured round length when entering PLAYING. Callbacks fire only
   * on a real change of state, 'onExit(old)' before 'onEnter(new)'.
   */
  to(state: RoomState, nowMs: number, durationSeconds?: number): void {
    const previous = this.current;
    const seconds = durationSeconds ?? this.defaultDuration(state);

    if (state === 'PLAYING' && durationSeconds !== undefined) {
      this.setPlayingDuration(durationSeconds);
    }

    this.current = state;
    this.phaseStart = nowMs;
    this.phaseEnd = seconds === null || !(seconds > 0) ? null : nowMs + seconds * 1000;

    if (previous !== state) {
      this.cb.onExit?.(previous);
      this.cb.onEnter?.(state);
    }
  }

  /** Advance automatically when the current phase expires. True on a change. */
  tick(nowMs: number): boolean {
    if (this.phaseEnd === null || nowMs < this.phaseEnd) return false;
    const next = nextAutoState(this.current);
    if (next === null) return false;
    this.to(next, nowMs);
    return true;
  }

  phase(nowMs: number): PhaseInfo {
    // 'nowMs' is accepted for symmetry with the rest of the API; the phase
    // window itself is absolute and does not depend on when it is read.
    void nowMs;
    return { state: this.current, startedAt: this.phaseStart, endsAt: this.phaseEnd };
  }

  private defaultDuration(state: RoomState): number | null {
    switch (state) {
      case 'CALIBRATION':
        return GAME.calibrationSeconds;
      case 'COUNTDOWN':
        return GAME.countdownSeconds;
      case 'PLAYING':
        return this.playingDuration;
      case 'RESULT':
        return GAME.resultSeconds;
      // WAITING has no clock — the room leaves it when a game is started.
      default:
        return null;
    }
  }
}
