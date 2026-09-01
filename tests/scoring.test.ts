import { describe, expect, it } from 'vitest';
import { buildResult, computeAwards, rankPlayers, rarityCount, bestFishOf } from '@/game/scoring/scoring';
import type { CapturedFish, PlayerPublicState } from '@/types';

const cf = (fishType: CapturedFish['fishType'], score: number, at = 0): CapturedFish => ({
  id: `${fishType}-${at}`,
  fishType,
  score,
  capturedAt: at,
});

const player = (
  number: number,
  score: number,
  fish: CapturedFish[],
  poiBreaks = 0,
  spectating = false,
): PlayerPublicState & { capturedFish: CapturedFish[] } => ({
  id: `p${number}`,
  number,
  name: `PLAYER ${number}`,
  color: '#fff',
  connected: true,
  controllerReady: true,
  calibrated: true,
  spectating,
  score,
  fishCount: fish.length,
  poiDurability: 100,
  poiWetness: 0,
  poiStage: 'Dry',
  poiState: 'Above',
  poiBreaks,
  capturedFish: fish,
});

describe('ranking', () => {
  it('orders by score then fish count', () => {
    const r = rankPlayers([
      player(1, 3700, [cf('red', 100)]),
      player(2, 2900, []),
      player(3, 4200, []),
      player(4, 2100, []),
    ]);
    expect(r.map((p) => p.number)).toEqual([3, 1, 2, 4]);
    expect(r.map((p) => p.rank)).toEqual([1, 2, 3, 4]);
  });

  it('shares a rank on an exact tie', () => {
    const r = rankPlayers([
      player(1, 1000, [cf('red', 100)]),
      player(2, 1000, [cf('red', 100)]),
      player(3, 500, []),
    ]);
    expect(r[0]!.rank).toBe(1);
    expect(r[1]!.rank).toBe(1);
    expect(r[2]!.rank).toBe(3);
  });

  it('attaches the best fish', () => {
    const r = rankPlayers([player(1, 1300, [cf('red', 100), cf('gold', 1000), cf('black', 300)])]);
    expect(r[0]!.bestFish?.fishType).toBe('gold');
  });
});

describe('awards', () => {
  it('gives MOST FISH, RARE HUNTER, GENTLE SCOOP and BEST FISH', () => {
    const awards = computeAwards([
      player(1, 900, [cf('red', 100), cf('red', 100, 1), cf('red', 100, 2)], 2),
      player(2, 1300, [cf('gold', 1000), cf('black', 300, 1)], 0),
      player(3, 100, [cf('red', 100)], 1),
    ]);
    const by = Object.fromEntries(awards.map((a) => [a.kind, a.playerNumber]));
    expect(by.MOST_FISH).toBe(1);
    expect(by.RARE_HUNTER).toBe(2);
    expect(by.GENTLE_SCOOP).toBe(2);
    expect(by.BEST_FISH).toBe(2);
  });

  it('skips awards nobody earned', () => {
    const awards = computeAwards([player(1, 0, [], 3)]);
    expect(awards).toHaveLength(0);
  });

  it('ignores spectators waiting for the next round', () => {
    const r = buildResult('X', [player(1, 100, [cf('red', 100)]), player(2, 9999, [], 0, true)], 60, 0);
    expect(r.rankings.map((p) => p.number)).toEqual([1]);
  });
});

describe('helpers', () => {
  it('counts rare fish at or above the threshold', () => {
    expect(rarityCount([cf('red', 100), cf('black', 300), cf('gold', 1000), cf('demekin', 500)])).toBe(3);
  });
  it('returns null for an empty bowl', () => {
    expect(bestFishOf([])).toBeNull();
  });
});
