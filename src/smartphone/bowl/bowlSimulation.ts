/**
 * The player's private goldfish bowl (spec §86-§93).
 *
 * Plain TypeScript over a **2D canvas coordinate space**: +x right, +y DOWN,
 * units are CSS pixels. No 'three', no React, no browser globals — 'BowlCanvas'
 * owns one of these and only feeds it 'dt'.
 *
 * The fish here are pure local decoration: the authoritative list of what the
 * player owns is 'CapturedFish[]' from the server. 'sync()' reconciles the two,
 * so a freshly scooped fish literally drops into the bowl and starts swimming
 * (§92) instead of appearing as a new row in a list (§89 forbids that).
 */

import type { CapturedFish, FishType } from '@/types';
import {
  DEG2RAD,
  TAU,
  clamp,
  clamp01,
  createRng,
  damp,
  lerp,
  noise1,
  rotateTowards,
  smoothstep,
  type Rng,
} from '@/game/core/math';
import { getFishData } from '@/game/fish/fishTypes';

/** One fish swimming in the bowl. Everything the renderer needs, nothing more. */
export interface BowlFish {
  /** Matches 'CapturedFish.id' — the link back to the server's truth. */
  id: string;
  type: FishType;
  /** Canvas-space position, pixels. */
  x: number;
  y: number;
  /** Canvas-space velocity, pixels / second. */
  vx: number;
  vy: number;
  /** Heading in canvas space, radians (0 = swimming right, +y is down). */
  angle: number;
  /** Tail-beat phase, radians. Drives every fin in the renderer. */
  phase: number;
  /** Nose-to-tail body length in pixels, before 'scale'. */
  size: number;
  /** Animated render multiplier: pseudo-depth, entry pop, landing squash. */
  scale: number;
  /** 0 while falling in from above the water line, 1 once it is swimming. */
  enterT: number;
  /** Point value of this fish, carried through for the renderer's glint. */
  score: number;
}

/** The glass: an ellipse plus the height of the still water line. */
export interface BowlBounds {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  /** Canvas y of the *still* water surface (above 'cy' for a half-full bowl). */
  waterY: number;
}

/**
 * One standing-wave mode of the water surface, integrated as an exactly-solved
 * damped harmonic oscillator (unconditionally stable, unlike Euler at 30 rad/s).
 * Surface shape = Σ amplitude·cos(mode·π·u), u = 0..1 across the bowl.
 */
export interface BowlWave {
  /** Spatial mode number: 1 = whole-bowl slosh, higher = ripples. */
  mode: number;
  /** Current signed displacement contribution, pixels. */
  amplitude: number;
  /** d(amplitude)/dt, pixels / second. */
  velocity: number;
  /** Natural angular frequency, rad/s. */
  omega: number;
  /** Damping *ratio* (0..1), not a rate — keeps the exact solution valid. */
  damping: number;
}

/** An expanding ring left on the surface by an entry or a shake. */
export interface BowlSplash {
  x: number;
  y: number;
  /** Seconds since it was born. */
  age: number;
  /** Total lifetime in seconds. */
  life: number;
  /** 0..1 */
  strength: number;
}

/** Internal bookkeeping the renderer never sees. */
interface BowlFishState extends BowlFish {
  /** Per-individual random offset so no two fish wander in step. */
  wander: number;
  /** Base cruise speed, px/s. */
  cruise: number;
  /** Seconds until the next dart (§91). */
  dartIn: number;
  /** 0..1 decaying dart boost. */
  burst: number;
  /** 0..1 pseudo-depth in the bowl, drives 'scale'. */
  depth: number;
  depthTarget: number;
  /** Decaying squash right after the fish hits the water. */
  landPop: number;
  /** Entry animation endpoints. */
  startX: number;
  startY: number;
  landX: number;
  landY: number;
  entered: boolean;
}

/** Spec §93: the surface tilts, but nowhere near enough to steer anything. */
const MAX_SURFACE_TILT = 6 * DEG2RAD;
/** How much of the phone's roll reaches the water before clamping. */
const TILT_GAIN = 0.6;
/** Seconds for the surface to slew to a new tilt — deliberately sluggish. */
const TILT_SLEW = 0.85;
/** Lateral drift at full tilt, as a fraction of the bowl radius per second. */
const DRIFT_PER_SECOND = 0.38;

const WAVE_MODES = 4;
/** Seconds for a newly captured fish to fall from above into the water. */
const ENTRY_SECONDS = 0.62;
/** Crowding reference: the bowl is drawn for roughly this many fish. */
const COMFORT_COUNT = 8;

/**
 * Exact step of x'' + 2ζωx' + ω²x = 0 for the underdamped case.
 * Stable at any dt, which matters because a backgrounded tab returns huge dt.
 */
const stepOscillator = (
  a: number,
  v: number,
  omega: number,
  zeta: number,
  dt: number,
): [amplitude: number, velocity: number] => {
  const wd = omega * Math.sqrt(Math.max(1e-4, 1 - zeta * zeta));
  const e = Math.exp(-zeta * omega * dt);
  const c = Math.cos(wd * dt);
  const s = Math.sin(wd * dt);
  const na = e * (a * c + ((v + zeta * omega * a) / wd) * s);
  const nv = e * (v * c - ((omega * omega * a + 2 * zeta * omega * v) / wd) * s);
  return [na, nv];
};

export class BowlSimulation {
  private bounds: BowlBounds = { cx: 0, cy: 0, rx: 1, ry: 1, waterY: 0 };
  private hasBounds = false;

  private items: BowlFishState[] = [];
  private byId = new Map<string, BowlFishState>();
  private waves: BowlWave[] = [];
  private rings: BowlSplash[] = [];

  private rng: Rng = createRng(0x5eed_9f31);
  private time = 0;

  private tiltTarget = 0;
  private tiltCurrent = 0;

  /** False until the first 'sync()': that batch is placed already swimming. */
  private seeded = false;

  constructor() {
    for (let m = 1; m <= WAVE_MODES; m++) {
      this.waves.push({
        mode: m,
        amplitude: 0,
        velocity: 0,
        // Higher modes are faster and die sooner, like real capillary ripples.
        omega: TAU * (1.55 + 0.85 * (m - 1)),
        damping: clamp(0.055 + 0.05 * (m - 1), 0.02, 0.6),
      });
    }
  }

  // ---------------------------------------------------------------- geometry

  setBounds(b: BowlBounds): void {
    const prev = this.bounds;
    const rescale = this.hasBounds && prev.rx > 1 && prev.ry > 1;

    // Keep the school where it was relative to the glass across a resize /
    // orientation change instead of letting fish pop outside the ellipse.
    if (rescale) {
      const sx = b.rx / prev.rx;
      const sy = b.ry / prev.ry;
      for (const f of this.items) {
        f.x = b.cx + (f.x - prev.cx) * sx;
        f.y = b.cy + (f.y - prev.cy) * sy;
        f.startY = b.cy + (f.startY - prev.cy) * sy;
        f.landY = b.cy + (f.landY - prev.cy) * sy;
        f.startX = b.cx + (f.startX - prev.cx) * sx;
        f.landX = b.cx + (f.landX - prev.cx) * sx;
      }
      for (const r of this.rings) {
        r.x = b.cx + (r.x - prev.cx) * sx;
        r.y = b.cy + (r.y - prev.cy) * sy;
      }
    }

    this.bounds = { ...b };
    this.hasBounds = true;
    if (rescale) this.resize();
  }

  /** Inner ellipse the fish are allowed to occupy (inside the glass). */
  private innerRx(): number {
    return Math.max(4, this.bounds.rx - 6);
  }

  private innerRy(): number {
    return Math.max(4, this.bounds.ry - 6);
  }

  /** Normalised horizontal coordinate 0..1 across the bowl, for the wave modes. */
  private uAt(x: number): number {
    const { cx, rx } = this.bounds;
    return clamp01((x - (cx - rx)) / Math.max(1, rx * 2));
  }

  /** Wave displacement (px, negative = up) at normalised position 'u'. */
  surfaceHeightAt(u: number): number {
    let h = 0;
    for (const w of this.waves) h += w.amplitude * Math.cos(w.mode * Math.PI * u);
    return h;
  }

  /** Canvas y of the water line at canvas x — tilt plus waves. */
  waterLineY(x: number): number {
    const { cx, waterY } = this.bounds;
    return waterY + Math.tan(this.tiltCurrent) * (x - cx) + this.surfaceHeightAt(this.uAt(x));
  }

  /** Slewed surface tilt in radians (never more than ±6°). */
  get tilt(): number {
    return this.tiltCurrent;
  }

  // ------------------------------------------------------------------ inputs

  /**
   * Feed the phone's roll (gamma) in radians. The surface follows lazily and
   * clamps hard: it must read as "there is water in my hand", never as a
   * control (spec §93).
   */
  setTilt(gammaRadians: number): void {
    const g = Number.isFinite(gammaRadians) ? gammaRadians : 0;
    this.tiltTarget = clamp(g * TILT_GAIN, -MAX_SURFACE_TILT, MAX_SURFACE_TILT);
  }

  /** Ring on the surface + energy into the standing waves. */
  addSplash(x: number, y: number, strength: number): void {
    const s = clamp01(strength);
    if (s <= 0.001) return;

    this.rings.push({ x, y, age: 0, life: 0.85 + s * 0.55, strength: s });
    // Cheap safety valve: a long-backgrounded tab must not accumulate rings.
    if (this.rings.length > 24) this.rings.splice(0, this.rings.length - 24);

    const u = this.uAt(x);
    const scale = this.bounds.ry * 0.055;
    for (const w of this.waves) {
      w.velocity += s * scale * Math.cos(w.mode * Math.PI * u) * (14 / (w.mode + 1));
    }
  }

  // ------------------------------------------------------------------- state

  /**
   * Reconcile with the server's list. New ids drop in from above; ids that
   * disappeared (a new round) are removed. The very first batch is placed
   * already swimming so a reconnect or the result screen does not replay a
   * dozen entry animations at once.
   */
  sync(capturedFish: readonly CapturedFish[]): void {
    const seen = new Set<string>();
    let entryDelay = 0;
    let placed = 0;

    for (const cf of capturedFish) {
      seen.add(cf.id);
      if (this.byId.has(cf.id)) continue;
      this.spawn(cf, this.seeded, entryDelay);
      // Stagger a burst of arrivals so their splashes read individually.
      if (this.seeded) entryDelay += 0.16;
      else placed++;
    }

    if (seen.size !== this.items.length) {
      for (let i = this.items.length - 1; i >= 0; i--) {
        const f = this.items[i];
        if (!seen.has(f.id)) {
          this.items.splice(i, 1);
          this.byId.delete(f.id);
        }
      }
    }

    this.seeded = true;
    this.resize();

    // Fish placed directly (a reconnect, or the result screen) land on random
    // spots that can overlap. Relax them apart before the very first frame is
    // painted, so the bowl never opens on a pile of goldfish.
    if (placed > 1) {
      for (let i = 0; i < 14; i++) this.separate(0.05);
    }
  }

  reset(): void {
    this.items.length = 0;
    this.byId.clear();
    this.rings.length = 0;
    for (const w of this.waves) {
      w.amplitude = 0;
      w.velocity = 0;
    }
    this.tiltCurrent = 0;
    this.tiltTarget = 0;
    this.seeded = false;
  }

  get fish(): readonly BowlFish[] {
    return this.items;
  }

  get surface(): readonly BowlWave[] {
    return this.waves;
  }

  get splashes(): readonly BowlSplash[] {
    return this.rings;
  }

  get count(): number {
    return this.items.length;
  }

  // ------------------------------------------------------------------ spawning

  /** Body length in pixels, shrinking as the bowl fills up. */
  private lengthFor(type: FishType): number {
    const data = getFishData(type);
    const base = this.bounds.rx * (0.235 + (data.size - 0.4) * 0.42);
    return base * this.crowdScale();
  }

  private crowdScale(): number {
    const n = Math.max(COMFORT_COUNT, this.items.length);
    return clamp(Math.sqrt(COMFORT_COUNT / n), 0.42, 1);
  }

  /** Re-fit every body after the count or the glass changed. */
  private resize(): void {
    for (const f of this.items) {
      f.size = this.lengthFor(f.type);
      f.cruise = this.cruiseFor(f.type);
    }
  }

  private cruiseFor(type: FishType): number {
    const data = getFishData(type);
    return this.bounds.rx * (0.1 + data.speed * 0.055) * lerp(1, 0.72, 1 - this.crowdScale());
  }

  private spawn(cf: CapturedFish, drop: boolean, delay: number): void {
    const { cx, cy } = this.bounds;
    const irx = this.innerRx();
    const iry = this.innerRy();
    const data = getFishData(cf.fishType);

    const size = this.lengthFor(cf.fishType);
    const landX = cx + this.rng.range(-0.45, 0.45) * irx;
    // Preferred depth from the catalogue, so 出目金 hangs low like on the screen.
    const lineY = this.waterLineY(landX);
    const floorY = cy + iry * 0.86;
    const restY = lerp(lineY + size * 0.75, floorY, clamp01(data.depthPreference));

    const f: BowlFishState = {
      id: cf.id,
      type: cf.fishType,
      x: drop ? landX : cx + this.rng.range(-0.55, 0.55) * irx,
      y: drop ? cy - iry * (1.5 + delay * 0.8) : restY,
      vx: 0,
      vy: 0,
      angle: this.rng.next() < 0.5 ? 0 : Math.PI,
      phase: this.rng.range(0, TAU),
      size,
      // Invisible until its stagger delay elapses (see 'updateEntry').
      scale: drop ? 0 : 1,
      enterT: drop ? -delay / ENTRY_SECONDS : 1,
      score: cf.score,

      wander: this.rng.range(0, 500),
      cruise: this.cruiseFor(cf.fishType),
      dartIn: this.rng.range(2.5, 9) * (1.3 - data.fear * 0.5),
      burst: 0,
      depth: this.rng.next(),
      depthTarget: this.rng.next(),
      landPop: 0,
      startX: landX + this.rng.range(-0.1, 0.1) * irx,
      startY: drop ? cy - iry * (1.5 + delay * 0.8) : restY,
      landX,
      landY: Math.max(lineY + size * 0.55, Math.min(restY, floorY)),
      entered: !drop,
    };

    if (!drop) {
      f.vx = Math.cos(f.angle) * f.cruise;
      f.vy = Math.sin(f.angle) * f.cruise;
    }

    this.items.push(f);
    this.byId.set(f.id, f);
  }

  // -------------------------------------------------------------------- tick

  update(dt: number, t: number): void {
    if (!this.hasBounds) return;
    // A backgrounded tab hands us seconds of dt; never integrate that.
    const step = clamp(dt, 0, 1 / 20);
    this.time = t;
    if (step <= 0) return;

    this.updateTilt(step);
    this.updateWaves(step);
    this.updateRings(step);

    for (const f of this.items) {
      if (!f.entered) this.updateEntry(f, step);
      else this.updateSwim(f, step);
    }
    this.separate(step);
  }

  /**
   * Steering alone cannot pull apart two fish cruising side by side at the same
   * speed, and a stack of overlapping goldfish looks like a bug. One soft
   * positional push per frame guarantees they always make room.
   */
  private separate(dt: number): void {
    const k = Math.min(1, dt * 9);
    for (let i = 0; i < this.items.length; i++) {
      const a = this.items[i];
      if (!a.entered) continue;
      for (let j = i + 1; j < this.items.length; j++) {
        const b = this.items[j];
        if (!b.entered) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d2 = dx * dx + dy * dy;
        const rad = (a.size + b.size) * 0.46;
        if (d2 >= rad * rad) continue;
        const d = Math.max(0.001, Math.sqrt(d2));
        const push = ((rad - d) / d) * 0.5 * k;
        a.x -= dx * push;
        a.y -= dy * push;
        b.x += dx * push;
        b.y += dy * push;
      }
    }
    for (const f of this.items) if (f.entered) this.constrain(f);
  }

  private updateTilt(dt: number): void {
    const prev = this.tiltCurrent;
    this.tiltCurrent = damp(this.tiltCurrent, this.tiltTarget, TILT_SLEW, dt);
    // The steady tilt is already in 'waterLineY'; what is left is the slosh it
    // kicks up on the way. Driving it from the per-frame delta (not a rate)
    // keeps the total energy the same at any frame rate.
    const delta = this.tiltCurrent - prev;
    this.waves[0].velocity += delta * this.bounds.rx * 8;
    this.waves[1].velocity += delta * this.bounds.rx * 3;
  }

  private updateWaves(dt: number): void {
    const maxAmp = this.bounds.ry * 0.06;
    for (let i = 0; i < this.waves.length; i++) {
      const w = this.waves[i];
      // A never-quite-still surface. The forcing is scaled by ω² so each mode
      // settles around a chosen amplitude instead of vanishing at high ω.
      const ambient = (this.bounds.ry * 0.019) / (i === 0 ? 2.4 : w.mode);
      w.velocity +=
        noise1(this.time * (0.7 + i * 0.31) + i * 17.3) * ambient * w.omega * w.omega * dt;
      const [a, v] = stepOscillator(w.amplitude, w.velocity, w.omega, w.damping, dt);
      w.amplitude = clamp(a, -maxAmp, maxAmp);
      w.velocity = Math.abs(a) >= maxAmp ? v * 0.4 : v;
    }
  }

  private updateRings(dt: number): void {
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.age += dt;
      if (r.age >= r.life) this.rings.splice(i, 1);
    }
  }

  /** The fall from above the glass into the water (spec §92). */
  private updateEntry(f: BowlFishState, dt: number): void {
    f.enterT += dt / ENTRY_SECONDS;
    if (f.enterT < 0) return; // still inside its stagger delay

    const e = clamp01(f.enterT);
    // t² — a real fall, accelerating into the surface.
    const fall = e * e;
    const py = f.y;
    f.x = lerp(f.startX, f.landX, e);
    f.y = lerp(f.startY, f.landY, fall);
    f.vy = (f.y - py) / dt;
    f.vx = (f.landX - f.startX) / ENTRY_SECONDS;
    // Tumbling nose-down, straightening out as it enters.
    f.angle = lerp(0.15, Math.PI / 2, smoothstep(0, 0.8, e)) + Math.sin(e * 9) * 0.22 * (1 - e);
    f.phase += dt * 9;
    f.scale = lerp(0.7, 1, smoothstep(0, 0.35, e));

    if (f.enterT >= 1) {
      f.enterT = 1;
      f.entered = true;
      f.landPop = 1;
      f.y = Math.max(f.y, this.waterLineY(f.x) + f.size * 0.5);
      // Shoot off sideways, the way a fish bolts the instant it hits water.
      f.angle = f.landX < this.bounds.cx ? 0.35 : Math.PI - 0.35;
      f.burst = 0.85;
      this.addSplash(f.x, this.waterLineY(f.x), clamp01(0.55 + f.size / this.bounds.rx));
    }
  }

  /** Spec §91 — cruise, avoid the glass, stay under the water, dart sometimes. */
  private updateSwim(f: BowlFishState, dt: number): void {
    const { cx, cy } = this.bounds;
    const irx = this.innerRx();
    const iry = this.innerRy();
    const data = getFishData(f.type);

    // --- steering: sum of desires, resolved into a target heading ---------
    let dx = Math.cos(f.angle);
    let dy = Math.sin(f.angle);

    // Gentle heading noise so the path is never a straight line.
    const n = noise1(this.time * 0.5 + f.wander);
    const nAngle = f.angle + n * 1.4;
    dx += Math.cos(nAngle) * 0.55;
    dy += Math.sin(nAngle) * 0.55;

    // Turn away from the elliptical glass before touching it.
    const nx = (f.x - cx) / irx;
    const ny = (f.y - cy) / iry;
    const r = Math.hypot(nx, ny);
    if (r > 0.62) {
      const w = smoothstep(0.62, 1.02, r) * 3.4;
      const inv = r > 1e-4 ? 1 / r : 0;
      dx -= nx * inv * w;
      dy -= ny * inv * w;
    }

    // Stay under the water line, with a comfortable margin.
    const line = this.waterLineY(f.x);
    const headroom = f.size * 0.7;
    if (f.y < line + headroom) {
      dy += smoothstep(headroom, -headroom * 0.5, f.y - line) * 3.0;
    }

    // Preferred depth from the catalogue — the bowl keeps each species' habit.
    const floorY = cy + iry * 0.86;
    const wantY = lerp(line + headroom, floorY, clamp01(data.depthPreference));
    dy += clamp((wantY - f.y) / Math.max(1, iry), -1, 1) * 0.5;

    // Light mutual avoidance: a bowl is not a school, they just make room.
    for (const o of this.items) {
      if (o === f || !o.entered) continue;
      const ox = f.x - o.x;
      const oy = f.y - o.y;
      const d2 = ox * ox + oy * oy;
      const rad = (f.size + o.size) * 0.62;
      if (d2 > 1e-4 && d2 < rad * rad) {
        const d = Math.sqrt(d2);
        const w = (1 - d / rad) * 2.2;
        dx += (ox / d) * w;
        dy += (oy / d) * w;
      }
    }

    // --- dart (§91): a sudden flick, then back to cruising -----------------
    f.dartIn -= dt;
    if (f.dartIn <= 0) {
      f.burst = 1;
      f.dartIn = this.rng.range(3.5, 10) * (1.3 - data.fear * 0.5);
      f.angle += this.rng.range(-0.7, 0.7);
    }
    f.burst = damp(f.burst, 0, 0.42, dt);

    // --- integrate ---------------------------------------------------------
    const target = Math.atan2(dy, dx);
    const turn = data.turnSpeed * (0.85 + f.burst * 1.3) * dt;
    f.angle = rotateTowards(f.angle, target, turn);

    const speed = f.cruise * (1 + f.burst * 2.1);
    // Spec §93: the tilt pushes the water, and the fish drift with it.
    const drift = Math.sin(this.tiltCurrent) * this.bounds.rx * DRIFT_PER_SECOND;

    f.vx = Math.cos(f.angle) * speed + drift;
    f.vy = Math.sin(f.angle) * speed;
    f.x += f.vx * dt;
    f.y += f.vy * dt;

    this.constrain(f);

    // --- animation ---------------------------------------------------------
    const speed01 = clamp01(speed / Math.max(1, f.cruise * 3));
    f.phase += dt * (3.4 + speed01 * 9);
    if (f.phase > TAU * 1024) f.phase -= TAU * 1024;

    if (Math.abs(f.depth - f.depthTarget) < 0.04) f.depthTarget = this.rng.next();
    f.depth = damp(f.depth, f.depthTarget, 2.4, dt);
    f.landPop = damp(f.landPop, 0, 0.22, dt);
    f.scale = (0.86 + f.depth * 0.3) * (1 + f.landPop * 0.2);
  }

  /** Hard containment — the glass is not negotiable. */
  private constrain(f: BowlFishState): void {
    const { cx, cy } = this.bounds;
    const irx = this.innerRx();
    const iry = this.innerRy();
    const pad = f.size * 0.22;

    const ax = Math.max(4, irx - pad);
    const ay = Math.max(4, iry - pad);
    const nx = (f.x - cx) / ax;
    const ny = (f.y - cy) / ay;
    const r = Math.hypot(nx, ny);
    if (r > 1) {
      f.x = cx + (nx / r) * ax;
      f.y = cy + (ny / r) * ay;
      // Reflect the heading back inside instead of grinding along the glass.
      const inward = Math.atan2(-ny, -nx);
      f.angle = rotateTowards(f.angle, inward, 0.6);
    }

    const line = this.waterLineY(f.x) + f.size * 0.34;
    if (f.y < line) {
      f.y = line;
      if (Math.sin(f.angle) < 0) f.angle = -f.angle;
    }
  }
}
