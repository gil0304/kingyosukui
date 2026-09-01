import type { PlayerId } from './ids';
import type { GameResult, PlayerPublicState } from './player';

/** Spec §42. */
export type RoomState = 'WAITING' | 'CALIBRATION' | 'COUNTDOWN' | 'PLAYING' | 'RESULT';

export interface RoomSettings {
  /** 60..90 (spec §97). */
  durationSeconds: number;
  /** 10..200 (spec §76). */
  fishCount: number;
  maxPlayers: number;
  /** Apply a score penalty when the poi tears (spec §57). */
  poiBreakPenalty: boolean;
  /** Master audio enable for the screen client. */
  audioEnabled: boolean;
  /** Enable heavy post-processing (bloom / DOF). */
  highQuality: boolean;
}

/** Everything a client needs to render the room shell. Sent as JSON on change. */
export interface RoomPublicState {
  id: string;
  state: RoomState;
  players: PlayerPublicState[];
  settings: RoomSettings;
  /** Server timestamp (ms) when the current phase started. */
  phaseStartedAt: number;
  /** Server timestamp (ms) when the current phase ends, or null if open-ended. */
  phaseEndsAt: number | null;
  /** Seconds left in PLAYING, mirrored for convenience. */
  timeRemaining: number;
  /** Result of the most recent round, when state === 'RESULT'. */
  result: GameResult | null;
  /** Players queued for the next round (spec §85). */
  waitingPlayers: PlayerId[];
  /** Server clock at send time, for offset estimation. */
  serverTime: number;
  screenConnected: boolean;
}

/** Spec §41. */
export interface Room {
  id: string;
  state: RoomState;
  players: PlayerPublicState[];
}
