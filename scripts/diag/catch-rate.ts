/**
 * Catchability meter: an average player, simulated.
 *
 * Chases the nearest reachable fish, dips when close, holds briefly, lifts
 * gently — no superhuman tracking (reaction delay + target updates at 4 Hz).
 * Reports catches per minute over several seeds. Run before and after any
 * difficulty tuning so "easier" is a measured fact, not a feeling.
 */
import { FishSimulation, type PoiQuery } from '@/game/fish/fishSimulation';
import { PoiSimulation, type PoiInput } from '@/game/poi/poiSimulation';
import { CaptureSystem, type CaptureActor } from '@/game/poi/captureSystem';
import { POI, POI_BOUNDS } from '@/game/core/constants';
import { vec3 } from '@/game/core/math';

const DT = 1 / 60;
const HALF_X = (POI_BOUNDS.maxX - POI_BOUNDS.minX) / 2;
const HALF_Z = (POI_BOUNDS.maxZ - POI_BOUNDS.minZ) / 2;

const runRound = (seed: number, seconds: number): { catches: number; drops: number } => {
  const fish = new FishSimulation(120, seed);
  const cap = new CaptureSystem(fish, seed ^ 0x1234);
  cap.setEnabled(true);
  const poi = new PoiSimulation(1, 0);
  const inp: PoiInput = {
    x: 0, y: 0, tiltX: 0, tiltY: 0, tiltZ: 0,
    verticalAcceleration: 0, handOffsetY: 0, handVelocityY: 0, liftPeakAccel: 0,
    isSubmerging: false, isLifting: false, connected: true,
  };
  let catches = 0;
  let drops = 0;
  let target = -1;
  let mode: 'chase' | 'dip' | 'lift' | 'recover' = 'chase';
  let modeT = 0;
  let retargetT = 0;
  const pos = vec3();

  for (let i = 0; i < seconds * 60; i++) {
    const t = i * DT;
    modeT += DT;
    retargetT += DT;

    // ---- "player" brain (deliberately imperfect) ----
    if (mode === 'chase') {
      if (retargetT > 0.25 && (target < 0 || !fish.has(target))) {
        retargetT = 0;
        // nearest reachable swimming fish
        let best = -1; let bestD = 1e9;
        for (const w of fish.getWire()) {
          if (w.carriedBy) continue;
          const d = Math.hypot(w.x - poi.x, w.z - poi.z);
          if (d < bestD) { bestD = d; best = w.id; }
        }
        target = best;
      }
      if (target >= 0 && fish.has(target)) {
        fish.getPosition(target, pos);
        inp.x = Math.max(-1, Math.min(1, pos.x / HALF_X));
        inp.y = Math.max(-1, Math.min(1, pos.z / HALF_Z));
        const d = Math.hypot(pos.x - poi.x, pos.z - poi.z);
        if (d < 0.45) { mode = 'dip'; modeT = 0; }
      }
      inp.isSubmerging = false; inp.isLifting = false;
    } else if (mode === 'dip') {
      inp.isSubmerging = true;
      // track the fish while under water, with a sluggish hand
      if (target >= 0 && fish.has(target) && retargetT > 0.2) {
        retargetT = 0;
        fish.getPosition(target, pos);
        inp.x = Math.max(-1, Math.min(1, pos.x / HALF_X));
        inp.y = Math.max(-1, Math.min(1, pos.z / HALF_Z));
      }
      if (poi.carried.length > 0 && modeT > 0.35) { mode = 'lift'; modeT = 0; }
      else if (modeT > 3.5) { mode = 'recover'; modeT = 0; } // gave up
    } else if (mode === 'lift') {
      inp.isSubmerging = false;
      inp.isLifting = true;
      inp.handVelocityY = 0.5;
      inp.verticalAcceleration = 2.0; // gentle
      inp.liftPeakAccel = 2.0;
      if (modeT > 1.2) { mode = 'recover'; modeT = 0; }
    } else {
      inp.isSubmerging = false; inp.isLifting = false;
      inp.handVelocityY = 0; inp.verticalAcceleration = 0; inp.liftPeakAccel = 0;
      if (modeT > 0.6) { mode = 'chase'; modeT = 0; target = -1; }
    }

    // ---- world tick ----
    poi.setInput(inp);
    const evs = poi.update(DT, t);
    let resolved = false, broke = false;
    for (const e of evs) { if (e.type === 'LIFT_RESOLVED') resolved = true; if (e.type === 'BROKE') broke = true; }
    const q: PoiQuery = { playerNumber: 1, x: poi.x, y: poi.y, z: poi.z, radius: POI.frameRadius, inWater: poi.inWater, active: poi.active, speed: poi.speed };
    fish.update(DT, [q]);
    const actor: CaptureActor = { playerNumber: 1, poi, liftResolved: resolved, broke };
    cap.update(DT, t, [actor], {
      onCapture: () => { catches++; },
      onDrop: () => { drops++; },
      onContact: () => {},
    });
  }
  return { catches, drops };
};

let totalC = 0, totalD = 0;
const per: number[] = [];
for (const seed of [11, 22, 33, 44, 55]) {
  const r = runRound(seed, 60);
  per.push(r.catches);
  totalC += r.catches; totalD += r.drops;
}
console.log(`60秒ラウンド×5席: 捕獲 ${JSON.stringify(per)} 平均 ${(totalC / 5).toFixed(1)}匹/分, ドロップ計 ${totalD}`);
