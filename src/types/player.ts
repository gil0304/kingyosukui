import type { FishType } from './fish';
import type { PlayerId, PlayerNumber } from './ids';

/** Spec §52. */
export type PoiWetnessStage = 'Dry' | 'Wet' | 'VeryWet' | 'Tearing';

/** Vertical / lifecycle state of a poi. */
export type PoiVerticalState =
  | 'Above'
  | 'Entering'
  | 'Submerged'
  | 'Lifting'
  | 'Raised'
  | 'Broken'
  | 'Respawning';

/** Spec §94. */
export interface CapturedFish {
  id: string;
  fishType: FishType;
  score: number;
  capturedAt: number;
}

/** Spec §44. */
export interface Player {
  id: PlayerId;
  number: PlayerNumber;

  connected: boolean;
  controllerReady: boolean;

  score: number;

  poiDurability: number;

  capturedFish: CapturedFish[];

  /** --- extras beyond the minimum spec shape --- */
  name: string;
  color: string;
  calibrated: boolean;
  /** True while waiting for the next round (spec §85 late joiners). */
  spectating: boolean;
  poiBreaks: number;
  joinedAt: number;
}

/** Spec §95. */
export interface PlayerBowlState {
  playerId: PlayerId;
  score: number;
  capturedFish: CapturedFish[];
}

/** Public per-player state pushed to every client. */
export interface PlayerPublicState {
  id: PlayerId;
  number: PlayerNumber;
  name: string;
  color: string;
  connected: boolean;
  controllerReady: boolean;
  calibrated: boolean;
  spectating: boolean;
  score: number;
  fishCount: number;
  poiDurability: number;
  poiWetness: number;
  poiStage: PoiWetnessStage;
  poiState: PoiVerticalState;
  poiBreaks: number;
}

export interface RankedPlayer extends PlayerPublicState {
  rank: number;
  bestFish: CapturedFish | null;
}

export type AwardKind = 'MOST_FISH' | 'RARE_HUNTER' | 'GENTLE_SCOOP' | 'BEST_FISH';

/** Spec §105. */
export interface Award {
  kind: AwardKind;
  label: string;
  playerId: PlayerId;
  playerNumber: PlayerNumber;
  detail: string;
}

export interface GameResult {
  roomId: string;
  rankings: RankedPlayer[];
  awards: Award[];
  durationSeconds: number;
  finishedAt: number;
}

/** Wire ordering for PoiVerticalState. NEVER reorder — the binary codec depends on it. */
export const POI_VERTICAL_STATES: readonly PoiVerticalState[] = [
  'Above',
  'Entering',
  'Submerged',
  'Lifting',
  'Raised',
  'Broken',
  'Respawning',
];

export const poiStateIndex = (s: PoiVerticalState): number => {
  const i = POI_VERTICAL_STATES.indexOf(s);
  return i < 0 ? 0 : i;
};

export const poiStateFromIndex = (i: number): PoiVerticalState =>
  POI_VERTICAL_STATES[i] ?? 'Above';

export const wetnessStage = (w: number): PoiWetnessStage =>
  w >= 0.86 ? 'Tearing' : w >= 0.62 ? 'VeryWet' : w >= 0.3 ? 'Wet' : 'Dry';
