/**
 * The fish catalogue (spec §66-§69).
 *
 * Pure data + selection helpers. No 'three' imports — the authoritative
 * simulation on the server reads this too.
 */

import type { FishData, FishRarity, FishType } from '@/types';
import type { Rng } from '@/game/core/math';

export const FISH_CATALOG: Record<FishType, FishData> = {
  red: {
    id: 'fish.red',
    type: 'red',
    label: '赤金魚',
    rarity: 'Common',
    score: 100,
    speed: 0.95,
    turnSpeed: 2.4,
    fear: 0.5,
    curiosity: 0.35,
    schooling: 0.7,
    weight: 1.0,
    spawnRate: 46,
    size: 0.42,
    depthPreference: 0.45,
    colorBody: '#e2472c',
    colorSecondary: '#f49a6a',
    colorFin: '#ff7a52',
    sheen: 0.15,
  },
  redwhite: {
    id: 'fish.redwhite',
    type: 'redwhite',
    label: '赤白金魚',
    rarity: 'Common',
    score: 200,
    speed: 0.9,
    turnSpeed: 2.3,
    fear: 0.45,
    curiosity: 0.45,
    schooling: 0.62,
    weight: 1.05,
    spawnRate: 26,
    size: 0.44,
    depthPreference: 0.4,
    colorBody: '#f2f0ea',
    colorSecondary: '#e0452b',
    colorFin: '#ffd9cc',
    sheen: 0.2,
  },
  black: {
    id: 'fish.black',
    type: 'black',
    label: '黒金魚',
    rarity: 'Rare',
    score: 300,
    speed: 1.35,
    turnSpeed: 3.1,
    fear: 0.72,
    curiosity: 0.2,
    schooling: 0.35,
    weight: 0.95,
    spawnRate: 16,
    size: 0.4,
    depthPreference: 0.62,
    colorBody: '#241f26',
    colorSecondary: '#3b3340',
    colorFin: '#4a4150',
    sheen: 0.35,
  },
  demekin: {
    id: 'fish.demekin',
    type: 'demekin',
    label: '出目金',
    rarity: 'SuperRare',
    score: 500,
    speed: 0.62,
    turnSpeed: 1.5,
    fear: 0.38,
    curiosity: 0.55,
    schooling: 0.25,
    weight: 1.9,
    spawnRate: 9,
    size: 0.6,
    depthPreference: 0.72,
    colorBody: '#1d1a20',
    colorSecondary: '#b83a24',
    colorFin: '#332c38',
    sheen: 0.45,
  },
  gold: {
    id: 'fish.gold',
    type: 'gold',
    label: '金色金魚',
    rarity: 'Legendary',
    score: 1000,
    speed: 1.5,
    turnSpeed: 3.4,
    fear: 0.92,
    curiosity: 0.12,
    schooling: 0.15,
    weight: 1.25,
    spawnRate: 3,
    size: 0.5,
    depthPreference: 0.35,
    colorBody: '#f5c542',
    colorSecondary: '#fff0b0',
    colorFin: '#ffe18a',
    sheen: 1.0,
  },
};

export const FISH_TYPES = Object.keys(FISH_CATALOG) as FishType[];

export const getFishData = (t: FishType): FishData => FISH_CATALOG[t] ?? FISH_CATALOG.red;

export const RARITY_ORDER: Record<FishRarity, number> = {
  Common: 0,
  Rare: 1,
  SuperRare: 2,
  Legendary: 3,
};

export const RARITY_LABEL: Record<FishRarity, string> = {
  Common: 'ふつう',
  Rare: 'レア',
  SuperRare: '超レア',
  Legendary: '伝説',
};

/** Rare fish only glint — no giant banner (spec §108). */
export const isRare = (t: FishType): boolean => RARITY_ORDER[getFishData(t).rarity] >= 1;

const TOTAL_SPAWN_WEIGHT = FISH_TYPES.reduce((s, t) => s + FISH_CATALOG[t].spawnRate, 0);

export const pickFishType = (rng: Rng): FishType => {
  let r = rng.next() * TOTAL_SPAWN_WEIGHT;
  for (const t of FISH_TYPES) {
    r -= FISH_CATALOG[t].spawnRate;
    if (r <= 0) return t;
  }
  return 'red';
};

/**
 * Build a spawn list of exactly 'count' fish with the catalogue distribution,
 * guaranteeing at least one of every type once the school is big enough.
 */
export const buildSpawnList = (count: number, rng: Rng): FishType[] => {
  const out: FishType[] = [];
  if (count >= FISH_TYPES.length) {
    for (const t of FISH_TYPES) out.push(t);
  }
  while (out.length < count) out.push(pickFishType(rng));
  // Fisher-Yates so the guaranteed types are not all at the front.
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out.slice(0, count);
};
