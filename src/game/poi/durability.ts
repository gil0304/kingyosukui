/**
 * Poi paper durability, wetness and tearing (spec §51-§57).
 *
 * The whole skill of 金魚すくい lives in this file: the paper survives a slow,
 * deliberate lift and fails a violent one. Everything here is pure arithmetic so
 * the authoritative server can run it 60 times a second for every player.
 */

import { DURABILITY, POI, WETNESS } from '@/game/core/constants';
import { clamp01, smoothstep } from '@/game/core/math';

/**
 * Even a motionless poi carries a little load — a wet paper holding a fish is
 * already under tension. Expressed as a fraction of the "gentle" reference
 * acceleration so the formula never collapses to zero.
 */
const STILL_ACCEL_FRACTION = 0.12;

/**
 * The paper's own mass, in fish-weight units. Keeps a violent empty swing from
 * being completely free — flailing an empty poi still wears it, just slowly.
 */
const PAPER_SELF_LOAD = 0.08;

/** Below this durability the hole becomes visible and starts growing (§56). */
const TEAR_THRESHOLD = 55;

/** Wet paper stretches: 1 + w² · factor. Quadratic, so the last drops hurt most. */
export function wetnessModifier(wetness: number): number {
  const w = clamp01(wetness);
  return 1 + w * w * DURABILITY.wetnessFactor;
}

/**
 * How dangerous a lift acceleration is, 0..1 — 0 at or below 'gentleAccel',
 * 1 at 'violentAccel'. Used both by the damage model and by the phone/screen
 * UI to warn the player before the paper gives way.
 */
export function liftDanger(liftAccel: number): number {
  return smoothstep(DURABILITY.gentleAccel, DURABILITY.violentAccel, liftAccel);
}

/**
 * Spec §54: Load = FishWeight × LiftAcceleration × WetnessModifier.
 * The acceleration is floored at a small fraction of the gentle reference so a
 * still poi still reports a non-zero load.
 */
export function computeLoad(fishWeight: number, liftAccel: number, wetness: number): number {
  const weight = fishWeight > 0 ? fishWeight : 0;
  const accel = Math.max(liftAccel, DURABILITY.gentleAccel * STILL_ACCEL_FRACTION);
  return weight * accel * wetnessModifier(wetness);
}

export interface DurabilityContext {
  inWater: boolean;
  lifting: boolean;
  liftAccel: number;
  carriedWeight: number;
  wetness: number;
}

/**
 * Damage to subtract from 'durability' this frame. Three independent sources:
 *
 *   lift load   — only while lifting, and gated by 'liftDanger' so a lift at or
 *                 below 'gentleAccel' is genuinely free (§55, the core skill).
 *   soak        — the paper softens simply by being under water (§53).
 *   weight      — fish resting on the paper stretch it continuously.
 */
export function durabilityDamage(ctx: DurabilityContext, dt: number): number {
  if (!(dt > 0)) return 0;

  const wetness = clamp01(ctx.wetness);
  const carried = ctx.carriedWeight > 0 ? ctx.carriedWeight : 0;
  let perSecond = 0;

  if (ctx.lifting) {
    const danger = liftDanger(ctx.liftAccel);
    if (danger > 0) {
      const load = computeLoad(carried + PAPER_SELF_LOAD, ctx.liftAccel, wetness);
      perSecond += load * DURABILITY.loadScale * danger;
    }
  }

  if (ctx.inWater) perSecond += DURABILITY.soakPerSecond;
  if (carried > 0) perSecond += DURABILITY.weightStressPerSecond * carried;

  return perSecond * dt;
}

/**
 * One-off damage for a fish dropping onto the paper from a height (§54).
 * The impact scales with the fish weight and how fast it landed.
 */
export function impactDamage(fishWeight: number, impactSpeed: number, wetness: number): number {
  const weight = fishWeight > 0 ? fishWeight : 0;
  const speed = Math.abs(impactSpeed);
  const severity = clamp01(speed / 2.5);
  return DURABILITY.impactDamage * weight * severity * wetnessModifier(wetness);
}

/** Wetness rises while submerged and slowly recovers in the air (§51). */
export function updateWetness(wetness: number, inWater: boolean, dt: number): number {
  if (!(dt > 0)) return clamp01(wetness);
  const rate = inWater ? WETNESS.gainPerSecond : -WETNESS.dryPerSecond;
  return clamp01(wetness + rate * dt);
}

/**
 * Visual hole size 0..1 (§56). Nothing shows while the paper is healthy; past
 * the threshold a small hole appears and widens, so the player watches the
 * failure coming instead of being surprised by it.
 */
export function tearAmount(durability: number): number {
  if (durability >= TEAR_THRESHOLD) return 0;
  if (durability <= 0) return 1;
  const t = clamp01((TEAR_THRESHOLD - durability) / TEAR_THRESHOLD);
  // Slightly eased: visible immediately, then accelerating as the paper gives up.
  return t * (0.35 + 0.65 * t);
}

/** Durability at which 'tearAmount' starts reporting a hole — for UI thresholds. */
export const TEAR_START_DURABILITY = TEAR_THRESHOLD;

/** Convenience for HUDs: remaining paper life as 0..1. */
export function durability01(durability: number): number {
  return clamp01(durability / POI.maxDurability);
}
