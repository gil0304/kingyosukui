import type { FishId } from './ids';

export type FishRarity = 'Common' | 'Rare' | 'SuperRare' | 'Legendary';

/** Stable string keys — also used to pick the model / material on both clients. */
export type FishType = 'red' | 'redwhite' | 'black' | 'demekin' | 'gold';

/** Spec §69. */
export interface FishData {
  id: string;
  type: FishType;
  /** Japanese display name, e.g. 赤金魚. */
  label: string;

  rarity: FishRarity;
  score: number;

  /** Cruising speed, world units / second. */
  speed: number;
  /** Max turn rate, radians / second. */
  turnSpeed: number;

  /** 0..1 — how strongly and how early it flees a poi. */
  fear: number;
  /** 0..1 — how likely it is to investigate a still poi. */
  curiosity: number;
  /** 0..1 — boids cohesion/alignment weight. */
  schooling: number;

  /** Relative mass; drives poi load (spec §54). */
  weight: number;

  /** Relative spawn weight. */
  spawnRate: number;

  /** Body length in world units (used for geometry scale + LOD). */
  size: number;
  /** Preferred depth as 0 (surface) .. 1 (floor). */
  depthPreference: number;

  /** Base body colour. */
  colorBody: string;
  /** Secondary / belly / patch colour. */
  colorSecondary: string;
  /** Fin colour. */
  colorFin: string;
  /** 0..1 extra specular / emissive sheen — the gold fish glints (spec §108). */
  sheen: number;
}

/** Spec §75. */
export type FishAnimState =
  | 'IdleSwim'
  | 'FastSwim'
  | 'Escape'
  | 'Captured'
  | 'Drop'
  | 'BowlSwim';

export const FISH_ANIM_STATES: readonly FishAnimState[] = [
  'IdleSwim',
  'FastSwim',
  'Escape',
  'Captured',
  'Drop',
  'BowlSwim',
];

/** Wire representation of one fish in a snapshot. */
export interface FishSnapshot {
  id: FishId;
  type: FishType;
  x: number;
  y: number;
  z: number;
  /** Heading around Y. */
  yaw: number;
  pitch: number;
  roll: number;
  /** Normalised 0..1 for tail beat frequency. */
  speed01: number;
  state: FishAnimState;
  /** Player number of the poi currently carrying this fish, or 0. */
  carriedBy: number;
}

/** Spec §81 — nobody owns a fish until the scoop resolves. */
export type FishOwnershipState =
  | 'Swimming'
  | 'OnPoi'
  | 'Lift'
  | 'CaptureSuccess'
  | 'Dropped';

/** Wire ordering for FishType. NEVER reorder — the binary codec depends on it. */
export const FISH_TYPE_ORDER: readonly FishType[] = [
  'red',
  'redwhite',
  'black',
  'demekin',
  'gold',
];

export const fishTypeIndex = (t: FishType): number => {
  const i = FISH_TYPE_ORDER.indexOf(t);
  return i < 0 ? 0 : i;
};

export const fishTypeFromIndex = (i: number): FishType => FISH_TYPE_ORDER[i] ?? 'red';

export const fishAnimIndex = (s: FishAnimState): number => {
  const i = FISH_ANIM_STATES.indexOf(s);
  return i < 0 ? 0 : i;
};

export const fishAnimFromIndex = (i: number): FishAnimState => FISH_ANIM_STATES[i] ?? 'IdleSwim';
