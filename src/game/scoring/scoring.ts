/** Scoring, ranking and special awards (spec §100, §103-§105). */

import type {
  Award,
  CapturedFish,
  FishRarity,
  GameResult,
  PlayerPublicState,
  RankedPlayer,
} from '@/types';
import { RARITY_ORDER, getFishData } from '@/game/fish/fishTypes';

export const bestFishOf = (fish: readonly CapturedFish[]): CapturedFish | null => {
  let best: CapturedFish | null = null;
  for (const f of fish) {
    if (!best || f.score > best.score) best = f;
  }
  return best;
};

export const rarityCount = (fish: readonly CapturedFish[], min: FishRarity = 'Rare'): number => {
  const threshold = RARITY_ORDER[min];
  let n = 0;
  for (const f of fish) {
    if (RARITY_ORDER[getFishData(f.fishType).rarity] >= threshold) n++;
  }
  return n;
};

export const totalScore = (fish: readonly CapturedFish[]): number =>
  fish.reduce((s, f) => s + f.score, 0);

export interface ScoringInput extends PlayerPublicState {
  capturedFish: CapturedFish[];
}

/**
 * Rank by score, then by fish count, then by earliest join (stable, deterministic).
 * Equal scores share a rank number.
 */
export const rankPlayers = (players: readonly ScoringInput[]): RankedPlayer[] => {
  const sorted = [...players].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.fishCount !== a.fishCount) return b.fishCount - a.fishCount;
    return a.number - b.number;
  });

  const out: RankedPlayer[] = [];
  let rank = 0;
  let prevScore = Number.NaN;
  let prevCount = Number.NaN;
  sorted.forEach((p, i) => {
    if (p.score !== prevScore || p.fishCount !== prevCount) rank = i + 1;
    prevScore = p.score;
    prevCount = p.fishCount;
    out.push({ ...p, rank, bestFish: bestFishOf(p.capturedFish) });
  });
  return out;
};

export const computeAwards = (players: readonly ScoringInput[]): Award[] => {
  const awards: Award[] = [];
  const active = players.filter((p) => !p.spectating);
  if (active.length === 0) return awards;

  const mostFish = [...active].sort((a, b) => b.fishCount - a.fishCount)[0]!;
  if (mostFish.fishCount > 0) {
    awards.push({
      kind: 'MOST_FISH',
      label: 'MOST FISH',
      playerId: mostFish.id,
      playerNumber: mostFish.number,
      detail: `${mostFish.fishCount}匹`,
    });
  }

  const withRare = active
    .map((p) => ({ p, n: rarityCount(p.capturedFish) }))
    .sort((a, b) => b.n - a.n)[0]!;
  if (withRare.n > 0) {
    awards.push({
      kind: 'RARE_HUNTER',
      label: 'RARE HUNTER',
      playerId: withRare.p.id,
      playerNumber: withRare.p.number,
      detail: `レア${withRare.n}匹`,
    });
  }

  // GENTLE SCOOP — never tore the paper, and actually caught something.
  const gentle = active
    .filter((p) => p.poiBreaks === 0 && p.fishCount > 0)
    .sort((a, b) => b.fishCount - a.fishCount)[0];
  if (gentle) {
    awards.push({
      kind: 'GENTLE_SCOOP',
      label: 'GENTLE SCOOP',
      playerId: gentle.id,
      playerNumber: gentle.number,
      detail: 'ポイを破らなかった',
    });
  }

  // BEST FISH — single most valuable fish of the round.
  let bestPlayer: ScoringInput | null = null;
  let best: CapturedFish | null = null;
  for (const p of active) {
    const b = bestFishOf(p.capturedFish);
    if (b && (!best || b.score > best.score)) {
      best = b;
      bestPlayer = p;
    }
  }
  if (best && bestPlayer) {
    awards.push({
      kind: 'BEST_FISH',
      label: 'BEST FISH',
      playerId: bestPlayer.id,
      playerNumber: bestPlayer.number,
      detail: `${getFishData(best.fishType).label} ${best.score}pt`,
    });
  }

  return awards;
};

export const buildResult = (
  roomId: string,
  players: readonly ScoringInput[],
  durationSeconds: number,
  finishedAt: number,
): GameResult => ({
  roomId,
  rankings: rankPlayers(players.filter((p) => !p.spectating)),
  awards: computeAwards(players),
  durationSeconds,
  finishedAt,
});

export const formatScore = (n: number): string => n.toLocaleString('en-US');
