import { describe, expect, it } from 'vitest';

import { FISH_BOUNDS, GAME, POI, POI_BOUNDS, WETNESS } from '@/game/core/constants';
import { FishSimulation, type PoiQuery } from '@/game/fish/fishSimulation';
import { PoiSimulation, type PoiInput } from '@/game/poi/poiSimulation';
import { CaptureSystem, type CaptureActor } from '@/game/poi/captureSystem';
import {
  computeLoad,
  durabilityDamage,
  tearAmount,
  updateWetness,
  wetnessModifier,
} from '@/game/poi/durability';
import { RoomLifecycle, nextAutoState } from '@/game/lifecycle/roomLifecycle';
import { vec3 } from '@/game/core/math';

const DT = 1 / 60;

const input = (over: Partial<PoiInput> = {}): PoiInput => ({
  x: 0,
  y: 0,
  tiltX: 0,
  tiltY: 0,
  tiltZ: 0,
  verticalAcceleration: 0,
  handOffsetY: 0,
  handVelocityY: 0,
  liftPeakAccel: 0,
  isSubmerging: false,
  isLifting: false,
  connected: true,
  ...over,
});

// ---------------------------------------------------------------------------

describe('fish simulation', () => {
  it('keeps 200 fish inside the tank, finite, and bounded in speed for a full round', () => {
    const sim = new FishSimulation(200, 12345);
    const poi: PoiQuery[] = [
      { playerNumber: 1, x: 0, y: -0.5, z: 0, radius: POI.frameRadius, inWater: true, active: true, speed: 2 },
      { playerNumber: 2, x: -4, y: 0.5, z: 1, radius: POI.frameRadius, inWater: false, active: true, speed: 0 },
    ];
    for (let i = 0; i < 60 * 90; i++) {
      // sweep a poi through the school so the fear path is exercised
      poi[0]!.x = Math.sin(i * 0.01) * 6;
      poi[0]!.z = Math.cos(i * 0.013) * 3;
      sim.update(DT, poi);
    }
    const wire = sim.getWire();
    expect(wire.length).toBe(200);
    for (const f of wire) {
      expect(Number.isFinite(f.x) && Number.isFinite(f.y) && Number.isFinite(f.z)).toBe(true);
      expect(f.x).toBeGreaterThanOrEqual(FISH_BOUNDS.minX - 0.05);
      expect(f.x).toBeLessThanOrEqual(FISH_BOUNDS.maxX + 0.05);
      expect(f.y).toBeGreaterThanOrEqual(FISH_BOUNDS.minY - 0.05);
      expect(f.y).toBeLessThanOrEqual(FISH_BOUNDS.maxY + 0.05);
      expect(f.z).toBeGreaterThanOrEqual(FISH_BOUNDS.minZ - 0.05);
      expect(f.z).toBeLessThanOrEqual(FISH_BOUNDS.maxZ + 0.05);
      expect(f.speed01).toBeGreaterThanOrEqual(0);
      expect(f.speed01).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic for a given seed', () => {
    const run = () => {
      const s = new FishSimulation(40, 777);
      for (let i = 0; i < 300; i++) s.update(DT, []);
      return s.getWire().map((f) => `${f.id}:${f.x.toFixed(4)}:${f.z.toFixed(4)}`);
    };
    expect(run()).toEqual(run());
  });

  it('drives fish away from a submerged poi', () => {
    const sim = new FishSimulation(60, 4242);
    const still: PoiQuery[] = [];
    for (let i = 0; i < 600; i++) sim.update(DT, still);

    const scary: PoiQuery[] = [
      { playerNumber: 1, x: 0, y: -0.5, z: 0, radius: POI.frameRadius, inWater: true, active: true, speed: 3 },
    ];
    const near = (r: number) => {
      let n = 0;
      for (const f of sim.getWire()) if (Math.hypot(f.x, f.z) < r) n++;
      return n;
    };
    const before = near(2.0);
    for (let i = 0; i < 180; i++) sim.update(DT, scary);
    expect(near(2.0)).toBeLessThanOrEqual(before);
  });

  it('replaces a captured fish so the school stays full', () => {
    const sim = new FishSimulation(20, 9);
    const id = sim.getWire()[0]!.id;
    expect(sim.has(id)).toBe(true);
    sim.captureAndReplace(id);
    expect(sim.has(id)).toBe(false);
    expect(sim.count).toBe(20);
  });

  it('finds only swimming fish inside the capture cylinder', () => {
    const sim = new FishSimulation(30, 31337);
    const out: number[] = [];
    const wire = sim.getWire();
    const target = wire[0]!;
    const found = sim.queryCylinder(target.x, target.y - 0.05, target.z, 0.6, 0.4, out);
    expect(found).toContain(target.id);
    sim.setCarried(target.id, 1);
    const found2 = sim.queryCylinder(target.x, target.y - 0.05, target.z, 0.6, 0.4, out);
    expect(found2).not.toContain(target.id);
  });
});

// ---------------------------------------------------------------------------

describe('poi simulation', () => {
  it('maps tilt to an absolute position and never leaves the tank', () => {
    const poi = new PoiSimulation(1, 0);
    poi.setInput(input({ x: 1, y: -1 }));
    for (let i = 0; i < 240; i++) poi.update(DT, i * DT);
    expect(poi.x).toBeCloseTo(POI_BOUNDS.maxX, 1);
    expect(poi.z).toBeCloseTo(POI_BOUNDS.minZ, 1);

    poi.setInput(input({ x: -1, y: 1 }));
    for (let i = 0; i < 240; i++) poi.update(DT, i * DT);
    expect(poi.x).toBeCloseTo(POI_BOUNDS.minX, 1);
    expect(poi.z).toBeCloseTo(POI_BOUNDS.maxZ, 1);
  });

  it('levelling the phone recentres the poi (no drift)', () => {
    const poi = new PoiSimulation(1, 3);
    poi.setInput(input({ x: 0.8 }));
    for (let i = 0; i < 200; i++) poi.update(DT, i * DT);
    poi.setInput(input({ x: 0 }));
    for (let i = 0; i < 400; i++) poi.update(DT, i * DT);
    expect(Math.abs(poi.x)).toBeLessThan(0.05);
  });

  it('submerges, then lifts back out and reports LIFT_RESOLVED once', () => {
    const poi = new PoiSimulation(1, 0);
    let entered = 0;
    let resolved = 0;
    poi.setInput(input({ isSubmerging: true }));
    for (let i = 0; i < 200; i++) {
      for (const e of poi.update(DT, i * DT)) if (e.type === 'ENTER_WATER') entered++;
    }
    expect(poi.inWater).toBe(true);
    expect(poi.state).toBe('Submerged');
    expect(entered).toBe(1);

    poi.setInput(input({ isLifting: true, handVelocityY: 0.6, verticalAcceleration: 4, liftPeakAccel: 4 }));
    for (let i = 0; i < 300; i++) {
      for (const e of poi.update(DT, (200 + i) * DT)) if (e.type === 'LIFT_RESOLVED') resolved++;
    }
    expect(resolved).toBe(1);
    // it settles back to the hover height afterwards, but it is out of the water
    expect(poi.y).toBeGreaterThan(0);
    expect(poi.inWater).toBe(false);
  });

  it('gets wet under water and dries out above it', () => {
    const poi = new PoiSimulation(1, 0);
    poi.setInput(input({ isSubmerging: true }));
    for (let i = 0; i < 60 * 3; i++) poi.update(DT, i * DT);
    const wet = poi.wetness;
    expect(wet).toBeGreaterThan(WETNESS.wet * 0.5);
    poi.setInput(input({}));
    for (let i = 0; i < 60 * 12; i++) poi.update(DT, (180 + i) * DT);
    expect(poi.inWater).toBe(false);
    expect(poi.wetness).toBeLessThan(wet);
  });

  it('a violent yank tears the paper; a gentle lift does not (spec §55)', () => {
    const gentle = new PoiSimulation(1, 0);
    const violent = new PoiSimulation(2, 0);
    for (const p of [gentle, violent]) {
      p.setInput(input({ isSubmerging: true }));
      for (let i = 0; i < 120; i++) p.update(DT, i * DT);
      p.carriedWeight = 1.0;
    }
    gentle.setInput(input({ isLifting: true, handVelocityY: 0.3, verticalAcceleration: 2.0, liftPeakAccel: 2.0 }));
    violent.setInput(input({ isLifting: true, handVelocityY: 2.6, verticalAcceleration: 26, liftPeakAccel: 26 }));
    for (let i = 0; i < 240; i++) {
      gentle.update(DT, (120 + i) * DT);
      violent.update(DT, (120 + i) * DT);
    }
    expect(gentle.durability).toBeGreaterThan(violent.durability);
    expect(gentle.durability).toBeGreaterThan(50);
  });

  it('breaks, then respawns with a fresh paper', () => {
    const poi = new PoiSimulation(1, 0);
    let broke = 0;
    let respawned = 0;
    poi.setInput(input({ isSubmerging: true }));
    for (let i = 0; i < 60; i++) poi.update(DT, i * DT);
    poi.forceBreak();
    poi.setInput(input({})); // hand comes back up while waiting for a new poi
    for (let i = 0; i < Math.ceil((POI.respawnSeconds + 1) * 60); i++) {
      for (const e of poi.update(DT, (60 + i) * DT)) {
        if (e.type === 'BROKE') broke++;
        if (e.type === 'RESPAWNED') respawned++;
      }
    }
    expect(respawned).toBe(1);
    expect(broke).toBeLessThanOrEqual(1);
    expect(poi.durability).toBe(POI.maxDurability);
    expect(poi.wetness).toBe(0);
    expect(poi.state).toBe('Above');
  });

  it('separates two overlapping poi without letting either damage the other', () => {
    const a = new PoiSimulation(1, 0);
    const b = new PoiSimulation(2, 0.05);
    a.setInput(input({ x: 0 }));
    b.setInput(input({ x: 0 }));
    for (let i = 0; i < 60; i++) {
      a.update(DT, i * DT);
      b.update(DT, i * DT);
      PoiSimulation.separate(a, b, DT);
    }
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(0.2);
    expect(a.durability).toBe(POI.maxDurability);
    expect(b.durability).toBe(POI.maxDurability);
  });

  it('a disconnected poi stops moving (spec §84)', () => {
    const poi = new PoiSimulation(1, 0);
    poi.setInput(input({ x: 1 }));
    for (let i = 0; i < 30; i++) poi.update(DT, i * DT);
    poi.setDisconnected();
    const x = poi.x;
    for (let i = 0; i < 120; i++) poi.update(DT, (30 + i) * DT);
    expect(Math.abs(poi.x - x)).toBeLessThan(0.35);
  });
});

// ---------------------------------------------------------------------------

describe('durability model', () => {
  it('wet paper carries a heavier load than dry paper', () => {
    expect(wetnessModifier(0)).toBeCloseTo(1, 5);
    expect(wetnessModifier(1)).toBeGreaterThan(wetnessModifier(0.5));
    expect(computeLoad(1, 10, 0.9)).toBeGreaterThan(computeLoad(1, 10, 0));
  });

  it('damage grows with lift acceleration', () => {
    const ctx = { inWater: false, lifting: true, liftAccel: 3, carriedWeight: 1, wetness: 0.5 };
    const slow = durabilityDamage(ctx, DT);
    const fast = durabilityDamage({ ...ctx, liftAccel: 25 }, DT);
    expect(fast).toBeGreaterThan(slow * 3);
  });

  it('wetness rises under water and falls above it, staying in 0..1', () => {
    let w = 0;
    for (let i = 0; i < 600; i++) w = updateWetness(w, true, DT);
    expect(w).toBeLessThanOrEqual(1);
    expect(w).toBeGreaterThan(WETNESS.wet);
    for (let i = 0; i < 6000; i++) w = updateWetness(w, false, DT);
    expect(w).toBe(0);
  });

  it('the hole only appears once the paper is well worn', () => {
    expect(tearAmount(100)).toBe(0);
    expect(tearAmount(60)).toBe(0);
    expect(tearAmount(20)).toBeGreaterThan(0);
    expect(tearAmount(0)).toBeCloseTo(1, 3);
  });
});

// ---------------------------------------------------------------------------

describe('room lifecycle', () => {
  it('runs the full loop back to WAITING', () => {
    const seen: string[] = [];
    const lc = new RoomLifecycle({ onEnter: (s) => seen.push(s) });
    lc.setPlayingDuration(60);
    let t = 1_000_000;
    lc.to('CALIBRATION', t, GAME.calibrationSeconds);
    t += GAME.calibrationSeconds * 1000 + 10;
    lc.tick(t);
    expect(lc.state).toBe('COUNTDOWN');
    t += GAME.countdownSeconds * 1000 + 10;
    lc.tick(t);
    expect(lc.state).toBe('PLAYING');
    expect(lc.timeRemaining(t)).toBeGreaterThan(59);
    t += 60_000 + 10;
    lc.tick(t);
    expect(lc.state).toBe('RESULT');
    t += GAME.resultSeconds * 1000 + 10;
    lc.tick(t);
    expect(lc.state).toBe('WAITING');
    expect(seen).toEqual(['CALIBRATION', 'COUNTDOWN', 'PLAYING', 'RESULT', 'WAITING']);
  });

  it('never auto-advances out of WAITING', () => {
    const lc = new RoomLifecycle();
    lc.to('WAITING', 0);
    lc.tick(10_000_000);
    expect(lc.state).toBe('WAITING');
    expect(nextAutoState('WAITING')).toBeNull();
  });

  it('counts 3, 2, 1 during the countdown', () => {
    const lc = new RoomLifecycle();
    const t0 = 500_000;
    lc.to('COUNTDOWN', t0, 3);
    expect(lc.countdown(t0 + 10)).toBe(3);
    expect(lc.countdown(t0 + 1100)).toBe(2);
    expect(lc.countdown(t0 + 2100)).toBe(1);
    lc.to('PLAYING', t0 + 3000, 60);
    expect(lc.countdown(t0 + 3100)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('capture arbitration (spec §82)', () => {
  const submerge = (poi: PoiSimulation, ticks = 200) => {
    poi.setInput(input({ isSubmerging: true }));
    for (let i = 0; i < ticks; i++) poi.update(DT, i * DT);
  };

  it('gives a contested fish to exactly one player, never both', () => {
    const fish = new FishSimulation(1, 5);
    const cap = new CaptureSystem(fish, 1);
    cap.setEnabled(true);

    const target = fish.getWire()[0]!;
    const a = new PoiSimulation(1, target.x);
    const b = new PoiSimulation(2, target.x);
    submerge(a);
    submerge(b);
    // Park both papers exactly under the same fish.
    const pos = fish.getPosition(target.id, vec3());
    a.x = pos.x;
    a.z = pos.z;
    a.y = pos.y - 0.05;
    b.x = pos.x;
    b.z = pos.z;
    b.y = pos.y - 0.05;

    const actors: CaptureActor[] = [
      { playerNumber: 1, poi: a, liftResolved: false, broke: false },
      { playerNumber: 2, poi: b, liftResolved: false, broke: false },
    ];
    cap.update(DT, 1, actors, { onCapture: () => {}, onDrop: () => {}, onContact: () => {} });

    const total = a.carried.length + b.carried.length;
    expect(total).toBe(1);
  });

  it('scores the fish only when the lift resolves above the water', () => {
    const fish = new FishSimulation(1, 11);
    const cap = new CaptureSystem(fish, 2);
    cap.setEnabled(true);
    const target = fish.getWire()[0]!;
    const poi = new PoiSimulation(1, target.x);
    submerge(poi);
    const pos = fish.getPosition(target.id, vec3());
    poi.x = pos.x;
    poi.z = pos.z;
    poi.y = pos.y - 0.05;

    const actor: CaptureActor = { playerNumber: 1, poi, liftResolved: false, broke: false };
    const captures: number[] = [];
    const cb = { onCapture: (_pn: number, id: number) => captures.push(id), onDrop: () => {}, onContact: () => {} };

    cap.update(DT, 1, [actor], cb);
    expect(poi.carried.length).toBe(1);
    expect(captures).toHaveLength(0); // nobody owns it yet (spec §81)

    actor.liftResolved = true;
    cap.update(DT, 1.1, [actor], cb);
    expect(captures).toEqual([target.id]);
    expect(poi.carried.length).toBe(0);
    expect(fish.has(target.id)).toBe(false);
  });

  it('drops everything when the paper tears', () => {
    const fish = new FishSimulation(1, 13);
    const cap = new CaptureSystem(fish, 3);
    cap.setEnabled(true);
    const target = fish.getWire()[0]!;
    const poi = new PoiSimulation(1, target.x);
    submerge(poi);
    const pos = fish.getPosition(target.id, vec3());
    poi.x = pos.x;
    poi.z = pos.z;
    poi.y = pos.y - 0.05;

    const actor: CaptureActor = { playerNumber: 1, poi, liftResolved: false, broke: false };
    const drops: string[] = [];
    const cb = {
      onCapture: () => {},
      onDrop: (_pn: number, _id: number, _t: string, reason: string) => drops.push(reason),
      onContact: () => {},
    };
    cap.update(DT, 1, [actor], cb);
    expect(poi.carried.length).toBe(1);

    actor.broke = true;
    cap.update(DT, 1.05, [actor], cb);
    expect(drops).toEqual(['BREAK']);
    expect(poi.carried.length).toBe(0);
    expect(fish.has(target.id)).toBe(true); // it falls back in, it does not vanish
  });

  it('captures nothing while disabled (outside PLAYING)', () => {
    const fish = new FishSimulation(1, 17);
    const cap = new CaptureSystem(fish, 4);
    cap.setEnabled(false);
    const target = fish.getWire()[0]!;
    const poi = new PoiSimulation(1, target.x);
    submerge(poi);
    const pos = fish.getPosition(target.id, vec3());
    poi.x = pos.x;
    poi.z = pos.z;
    poi.y = pos.y - 0.05;
    cap.update(DT, 1, [{ playerNumber: 1, poi, liftResolved: false, broke: false }], {
      onCapture: () => {},
      onDrop: () => {},
      onContact: () => {},
    });
    expect(poi.carried.length).toBe(0);
  });
});

describe('gentle lift (spec §55)', () => {
  it('raising the hand without a LIFT gesture still brings the paper out of the water', () => {
    const poi = new PoiSimulation(1, 0);
    poi.setInput(input({ isSubmerging: true }));
    for (let i = 0; i < 200; i++) poi.update(DT, i * DT);
    expect(poi.state).toBe('Submerged');

    let resolved = 0;
    poi.setInput(input({})); // no gesture at all — just stop pushing down
    for (let i = 0; i < 400; i++) {
      for (const e of poi.update(DT, (200 + i) * DT)) if (e.type === 'LIFT_RESOLVED') resolved++;
    }
    expect(resolved).toBe(1);
    expect(poi.inWater).toBe(false);
  });

  it('the gentle lift costs the paper far less than a yank', () => {
    const gentle = new PoiSimulation(1, 0);
    const yank = new PoiSimulation(2, 0);
    for (const p of [gentle, yank]) {
      p.setInput(input({ isSubmerging: true }));
      for (let i = 0; i < 200; i++) p.update(DT, i * DT);
      p.carriedWeight = 1.9; // a heavy 出目金
    }
    gentle.setInput(input({}));
    yank.setInput(input({ isLifting: true, handVelocityY: 3, verticalAcceleration: 30, liftPeakAccel: 30 }));
    // 1.5 s — long enough for the yank to tear, short enough that it has not
    // respawned yet, so the two are actually comparable.
    for (let i = 0; i < 90; i++) {
      gentle.update(DT, (200 + i) * DT);
      yank.update(DT, (200 + i) * DT);
    }
    // Both pay the weight stress of a heavy 出目金; only the yank pays the lift load.
    expect(gentle.durability).toBeGreaterThan(75);
    expect(gentle.durability - yank.durability).toBeGreaterThan(15);
  });

  it('repeated yanking tears the paper; repeated careful scoops never do', () => {
    const scoop = (poi: PoiSimulation, violent: boolean, round: number) => {
      const t0 = round * 400;
      poi.setInput(input({ isSubmerging: true }));
      for (let i = 0; i < 150; i++) poi.update(DT, (t0 + i) * DT);
      poi.carriedWeight = 1.0;
      poi.setInput(
        violent
          ? input({ isLifting: true, handVelocityY: 3, verticalAcceleration: 28, liftPeakAccel: 28 })
          : input({}),
      );
      for (let i = 0; i < 200; i++) poi.update(DT, (t0 + 150 + i) * DT);
      poi.carriedWeight = 0;
      poi.setInput(input({}));
      for (let i = 0; i < 50; i++) poi.update(DT, (t0 + 350 + i) * DT);
    };

    const careful = new PoiSimulation(1, 0);
    const reckless = new PoiSimulation(2, 0);
    let brokeCareful = 0;
    let brokeReckless = 0;
    for (let r = 0; r < 8; r++) {
      const before = [careful.durability, reckless.durability];
      scoop(careful, false, r);
      scoop(reckless, true, r);
      if (careful.durability > before[0]!) brokeCareful++;
      if (reckless.durability > before[1]!) brokeReckless++;
    }
    expect(brokeReckless).toBeGreaterThan(0);
    expect(brokeCareful).toBe(0);
  });
});
