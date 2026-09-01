/**
 * Canvas-2D painting for the phone's private goldfish bowl (spec §86-§93).
 *
 * Two jobs:
 *   'drawBowlFish' — one goldfish, drawn as an actual 2.5D silhouette (body,
 *     flowing double-lobed tail, dorsal, two pectorals, anal fin, eye), animated
 *     from the fish's tail phase and coloured from 'FISH_CATALOG' so the species
 *     matches what the player just scooped on the giant screen (§90).
 *     Never an emoji, never a static icon (§89).
 *   'drawBowl'   — the glass, the water, and everything in it, in one call.
 *
 * Plain TypeScript: no 'three', no React. Everything is procedural so the phone
 * downloads no assets for this screen.
 */

import { TAU, clamp01, lerp } from '@/game/core/math';
import { getFishData } from '@/game/fish/fishTypes';
import type { BowlBounds, BowlFish, BowlSimulation } from './bowlSimulation';

// ---------------------------------------------------------------- colour utils

const parseHex = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '');
  const v =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  const n = Number.parseInt(v, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const rgba = (hex: string, a: number): string => {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r},${g},${b},${a})`;
};

/** 'amount' > 0 lightens toward white, < 0 darkens toward black. */
const shade = (hex: string, amount: number): string => {
  const [r, g, b] = parseHex(hex);
  const t = Math.abs(amount);
  const to = amount > 0 ? 255 : 0;
  return `rgb(${Math.round(lerp(r, to, t))},${Math.round(lerp(g, to, t))},${Math.round(
    lerp(b, to, t),
  )})`;
};

/**
 * Gradients are rebuilt only when the fish size bucket changes. Their
 * coordinates are resolved against the CTM at paint time, so caching one per
 * (context, key) and painting it inside each fish's local frame is safe.
 */
const gradientCache = new WeakMap<CanvasRenderingContext2D, Map<string, CanvasGradient>>();

const cachedGradient = (
  ctx: CanvasRenderingContext2D,
  key: string,
  build: () => CanvasGradient,
): CanvasGradient => {
  let map = gradientCache.get(ctx);
  if (!map) {
    map = new Map();
    gradientCache.set(ctx, map);
  }
  let g = map.get(key);
  if (!g) {
    g = build();
    map.set(key, g);
    // The bucket key quantises L, so this stays tiny; trim if a resize storm
    // ever pushes it up.
    if (map.size > 96) map.clear();
  }
  return g;
};

// ------------------------------------------------------------------ fish shape

/** Half body height as a fraction of length — 出目金 is a fat little balloon. */
const bodyFat = (f: BowlFish): number =>
  f.type === 'demekin' ? 0.3 : f.type === 'redwhite' ? 0.245 : 0.228;

/** The goldfish outline, drawn nose-first along +x with the belly at +y. */
const bodyPath = (ctx: CanvasRenderingContext2D, L: number, h: number): void => {
  ctx.beginPath();
  // Terminal, slightly up-turned mouth.
  ctx.moveTo(0.5 * L, 0.06 * h);
  // Snout — kept narrow, then the nape rises into the arched back.
  ctx.bezierCurveTo(0.48 * L, -0.34 * h, 0.37 * L, -0.9 * h, 0.16 * L, -1.0 * h);
  // Back tapering into the caudal peduncle.
  ctx.bezierCurveTo(0.0 * L, -1.08 * h, -0.14 * L, -0.62 * h, -0.26 * L, -0.19 * h);
  ctx.lineTo(-0.26 * L, 0.19 * h);
  // Belly — deeper and rounder than the back, its lowest point well forward.
  ctx.bezierCurveTo(-0.15 * L, 0.68 * h, -0.02 * L, 1.1 * h, 0.13 * L, 1.06 * h);
  ctx.bezierCurveTo(0.32 * L, 1.0 * h, 0.45 * L, 0.62 * h, 0.5 * L, 0.06 * h);
  ctx.closePath();
};

/** One flowing tail lobe, rooted at the peduncle and swung by 'angle'. */
const tailLobe = (
  ctx: CanvasRenderingContext2D,
  L: number,
  angle: number,
  spread: number,
  sign: number,
  fill: string | CanvasGradient,
): void => {
  ctx.save();
  ctx.translate(-0.24 * L, 0);
  ctx.rotate(angle);
  ctx.scale(1, sign);
  ctx.beginPath();
  ctx.moveTo(0, -0.02 * L);
  // Outer edge, sweeping back and out to the tip of the lobe.
  ctx.bezierCurveTo(
    -0.18 * L,
    -0.07 * L * spread,
    -0.34 * L,
    -0.19 * L * spread,
    -0.5 * L,
    -0.36 * L * spread,
  );
  // Rounded silk tip, then the inner edge back along the axis: this is what
  // makes it a goldfish veil-tail rather than two thin spikes.
  ctx.quadraticCurveTo(-0.47 * L, -0.19 * L * spread, -0.37 * L, -0.1 * L * spread);
  ctx.quadraticCurveTo(-0.2 * L, -0.04 * L * spread, -0.02 * L, 0.03 * L);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();
};

/** A small trailing fin (pectoral / anal), rooted at the origin of the frame. */
const leafFin = (
  ctx: CanvasRenderingContext2D,
  L: number,
  len: number,
  angle: number,
  fill: string | CanvasGradient,
): void => {
  ctx.save();
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(-len * 0.6 * L, 0.05 * L, -len * L, 0.13 * L);
  ctx.quadraticCurveTo(-len * 0.52 * L, 0.02 * L, 0, 0.05 * L);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();
};

/**
 * Draw one bowl fish at its current position, in canvas pixel space.
 * 't' is the wall clock in seconds (used only for the 金色金魚's glint).
 */
export function drawBowlFish(ctx: CanvasRenderingContext2D, f: BowlFish, t: number): void {
  if (f.scale <= 0.005) return;
  const L = f.size * f.scale;
  if (L < 3) return;

  const data = getFishData(f.type);
  const h = L * bodyFat(f);
  const bucket = Math.round(L / 2) * 2;
  const key = `${f.type}:${bucket}`;

  // Swim energy drives every fin: a darting fish beats hard, a cruising one idles.
  const speed = Math.hypot(f.vx, f.vy);
  const energy = clamp01(speed / Math.max(1, f.size * 2.4));
  const amp = 0.2 + energy * 0.42;

  ctx.save();
  ctx.translate(f.x, f.y);
  ctx.rotate(f.angle);
  // Keep the belly down whichever way it swims: mirror instead of rolling over.
  if (Math.cos(f.angle) < 0) ctx.scale(1, -1);
  if (f.enterT < 1) {
    // Squash-and-stretch along the fall.
    const s = 1 + (1 - f.enterT) * 0.22;
    ctx.scale(s, 2 - s);
  }

  // --- 金色金魚 glow (§108: it glints, it does not get a banner) ------------
  if (data.sheen >= 0.8) {
    const pulse = 0.13 + 0.06 * Math.sin(t * 2.3 + f.phase * 0.5);
    const glow = cachedGradient(ctx, `glow:${bucket}`, () => {
      const g = ctx.createRadialGradient(0, 0, L * 0.08, 0, 0, L * 0.78);
      g.addColorStop(0, 'rgba(255,222,132,0.9)');
      g.addColorStop(0.4, 'rgba(255,196,80,0.34)');
      g.addColorStop(1, 'rgba(255,180,60,0)');
      return g;
    });
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = pulse;
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, L * 0.78, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  // --- fins behind the body -------------------------------------------------
  const finGrad = cachedGradient(ctx, `fin:${key}`, () => {
    const g = ctx.createLinearGradient(0, 0, -0.5 * L, 0);
    g.addColorStop(0, rgba(data.colorFin, 0.95));
    g.addColorStop(0.55, rgba(data.colorFin, 0.72));
    g.addColorStop(1, rgba(shade(data.colorFin, 0.35), 0.28));
    return g;
  });

  const tailA = Math.sin(f.phase) * amp;
  const tailB = Math.sin(f.phase - 0.55) * amp;
  const spread = f.type === 'demekin' ? 1.18 : 1;
  tailLobe(ctx, L, tailA, spread, 1, finGrad);
  tailLobe(ctx, L, tailB, spread, -1, finGrad);

  // Dorsal fin, undulating a beat behind the tail.
  const dorsal = Math.sin(f.phase * 0.85 - 0.9) * h * 0.16;
  ctx.beginPath();
  ctx.moveTo(0.18 * L, -0.92 * h);
  ctx.bezierCurveTo(
    0.08 * L,
    -1.74 * h + dorsal,
    -0.06 * L,
    -1.62 * h + dorsal,
    -0.19 * L,
    -0.5 * h,
  );
  ctx.quadraticCurveTo(-0.02 * L, -1.02 * h, 0.18 * L, -0.92 * h);
  ctx.closePath();
  ctx.fillStyle = finGrad;
  ctx.fill();

  // Anal fin, low and near the tail.
  ctx.save();
  ctx.translate(-0.1 * L, 0.82 * h);
  leafFin(ctx, L, 0.24, 0.45 + Math.sin(f.phase - 1.1) * 0.18, finGrad);
  ctx.restore();

  // Far-side pectoral: dimmer, so the fish reads as having two sides.
  ctx.save();
  ctx.globalAlpha = 0.45;
  ctx.translate(0.2 * L, -0.05 * h);
  leafFin(ctx, L, 0.2, -0.3 + Math.sin(f.phase * 1.9 + 1.6) * 0.45, finGrad);
  ctx.restore();

  // --- body -----------------------------------------------------------------
  const bodyGrad = cachedGradient(ctx, `body:${key}`, () => {
    const g = ctx.createLinearGradient(0, -h * 1.05, 0, h * 1.05);
    if (f.type === 'redwhite') {
      g.addColorStop(0, shade(data.colorBody, -0.08));
      g.addColorStop(0.55, data.colorBody);
      g.addColorStop(1, shade(data.colorBody, 0.25));
    } else {
      g.addColorStop(0, shade(data.colorBody, -0.22));
      g.addColorStop(0.42, data.colorBody);
      g.addColorStop(1, data.colorSecondary);
    }
    return g;
  });

  bodyPath(ctx, L, h);
  ctx.fillStyle = bodyGrad;
  ctx.fill();

  ctx.save();
  ctx.clip();

  // 更紗 markings: the red-and-white fish gets real patches, not a flat tint.
  if (f.type === 'redwhite') {
    ctx.fillStyle = rgba(data.colorSecondary, 0.92);
    ctx.beginPath();
    ctx.ellipse(0.26 * L, -0.5 * h, 0.2 * L, h * 0.95, -0.22, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(-0.12 * L, -0.15 * h, 0.12 * L, h * 0.72, 0.25, 0, TAU);
    ctx.fill();
  }

  // Back shading + belly light: the whole reason this reads as 2.5D.
  const shadeGrad = cachedGradient(ctx, `shade:${key}`, () => {
    const g = ctx.createLinearGradient(0, -h * 1.1, 0, h * 0.2);
    g.addColorStop(0, 'rgba(0,0,0,0.34)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    return g;
  });
  ctx.fillStyle = shadeGrad;
  ctx.fillRect(-0.55 * L, -h * 1.2, 1.1 * L, h * 1.5);

  const bellyGrad = cachedGradient(ctx, `belly:${key}`, () => {
    const g = ctx.createRadialGradient(0.1 * L, h * 0.62, 0, 0.1 * L, h * 0.62, 0.42 * L);
    g.addColorStop(0, 'rgba(255,255,255,0.34)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    return g;
  });
  ctx.fillStyle = bellyGrad;
  ctx.fillRect(-0.55 * L, -h * 1.2, 1.1 * L, h * 2.4);

  // Wet specular streak along the back — stronger the higher the sheen.
  ctx.globalAlpha = 0.18 + data.sheen * 0.4;
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.beginPath();
  ctx.ellipse(0.16 * L, -h * 0.6, 0.22 * L, h * 0.14, -0.1, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 1;

  // Gill plate.
  ctx.strokeStyle = rgba(shade(data.colorBody, -0.4), 0.3);
  ctx.lineWidth = Math.max(0.8, L * 0.012);
  ctx.beginPath();
  ctx.moveTo(0.3 * L, -h * 0.62);
  ctx.quadraticCurveTo(0.22 * L, 0, 0.29 * L, h * 0.66);
  ctx.stroke();

  ctx.restore();

  // Outline, so a black 金魚 still reads against deep water.
  bodyPath(ctx, L, h);
  ctx.strokeStyle = rgba(shade(data.colorBody, -0.45), 0.55);
  ctx.lineWidth = Math.max(0.9, L * 0.014);
  ctx.stroke();

  // --- near-side pectoral, in front of the body ------------------------------
  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.translate(0.2 * L, h * 0.34);
  leafFin(ctx, L, 0.22, 0.25 + Math.sin(f.phase * 1.9) * 0.5, finGrad);
  ctx.restore();

  // --- eye -------------------------------------------------------------------
  const pop = f.type === 'demekin';
  const ex = pop ? 0.35 * L : 0.33 * L;
  const ey = pop ? -h * 0.38 : -h * 0.34;
  const er = pop ? L * 0.085 : L * 0.041;

  if (pop) {
    // 出目金: the eye genuinely bulges out past the outline.
    ctx.fillStyle = shade(data.colorBody, 0.1);
    ctx.beginPath();
    ctx.arc(ex, ey, er * 1.12, 0, TAU);
    ctx.fill();
  }
  ctx.fillStyle = pop ? '#0d0b10' : '#efe6d6';
  ctx.beginPath();
  ctx.arc(ex, ey, er, 0, TAU);
  ctx.fill();
  if (!pop) {
    ctx.fillStyle = '#15111a';
    ctx.beginPath();
    ctx.arc(ex + er * 0.08, ey, er * 0.82, 0, TAU);
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.beginPath();
  ctx.arc(ex + er * 0.34, ey - er * 0.38, er * 0.26, 0, TAU);
  ctx.fill();

  ctx.restore();
}

// ------------------------------------------------------------------ the bowl

const SURFACE_STEPS = 44;

/** Trace the live water line across (and a little beyond) the glass. */
const traceSurface = (
  ctx: CanvasRenderingContext2D,
  bounds: BowlBounds,
  sim: BowlSimulation,
  yOffset = 0,
  reverse = false,
): void => {
  const { cx, rx } = bounds;
  const x0 = cx - rx * 1.06;
  const span = rx * 2.12;
  for (let i = 0; i <= SURFACE_STEPS; i++) {
    const k = reverse ? SURFACE_STEPS - i : i;
    const x = x0 + (span * k) / SURFACE_STEPS;
    ctx.lineTo(x, sim.waterLineY(x) + yOffset);
  }
};

/** Clip to the water: inside the glass AND below the (moving) surface. */
const clipWater = (
  ctx: CanvasRenderingContext2D,
  bounds: BowlBounds,
  sim: BowlSimulation,
): void => {
  const { cx, cy, rx, ry } = bounds;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU);
  ctx.clip();
  ctx.beginPath();
  ctx.moveTo(cx - rx * 1.06, sim.waterLineY(cx - rx * 1.06));
  traceSurface(ctx, bounds, sim);
  ctx.lineTo(cx + rx * 1.1, cy + ry * 1.2);
  ctx.lineTo(cx - rx * 1.1, cy + ry * 1.2);
  ctx.closePath();
  ctx.clip();
};

const paintWater = (ctx: CanvasRenderingContext2D, bounds: BowlBounds): void => {
  const { cx, cy, rx, ry, waterY } = bounds;
  const g = ctx.createLinearGradient(0, waterY - ry * 0.1, 0, cy + ry);
  g.addColorStop(0, '#5ec9d6');
  g.addColorStop(0.28, '#2b96b6');
  g.addColorStop(0.66, '#14608f');
  g.addColorStop(1, '#082f52');
  ctx.fillStyle = g;
  ctx.fillRect(cx - rx * 1.2, waterY - ry * 0.6, rx * 2.4, ry * 2.6);

  // Corner darkening: the water column is thicker where you look through more
  // of it, which is what makes the glass read as round rather than flat.
  const v = ctx.createRadialGradient(cx, cy + ry * 0.1, rx * 0.25, cx, cy, rx * 1.05);
  v.addColorStop(0, 'rgba(2,18,36,0)');
  v.addColorStop(1, 'rgba(2,16,34,0.62)');
  ctx.fillStyle = v;
  ctx.fillRect(cx - rx * 1.2, cy - ry * 1.2, rx * 2.4, ry * 2.4);
};

/** Spec §12: caustic light on the water, not a flat blue plane. */
const paintCaustics = (
  ctx: CanvasRenderingContext2D,
  bounds: BowlBounds,
  sim: BowlSimulation,
  t: number,
): void => {
  const { cx, cy, rx, ry, waterY } = bounds;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  // Shafts of lantern light coming down through the surface. Each is three
  // nested quads: canvas has no blur, so overlapping widths make the soft edge.
  for (let i = 0; i < 3; i++) {
    const sway = Math.sin(t * 0.42 + i * 2.2) * rx * 0.16;
    const topX = cx + lerp(-0.42, 0.42, (i + 0.5) / 3) * rx + sway;
    const drift = rx * 0.28;
    for (let k = 0; k < 3; k++) {
      const half = rx * (0.2 - k * 0.062);
      const g = ctx.createLinearGradient(topX, waterY, topX + drift, cy + ry);
      g.addColorStop(0, `rgba(212,250,255,${0.026 + k * 0.013})`);
      g.addColorStop(0.55, `rgba(168,232,255,${0.014 + k * 0.007})`);
      g.addColorStop(1, 'rgba(140,220,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(topX - half, waterY);
      ctx.lineTo(topX + half, waterY);
      ctx.lineTo(topX + half * 1.9 + drift, cy + ry);
      ctx.lineTo(topX - half * 1.9 + drift, cy + ry);
      ctx.closePath();
      ctx.fill();
    }
  }

  // The rippling net on the water itself.
  for (let i = 0; i < 6; i++) {
    const p = (i + 0.5) / 6;
    const y = lerp(waterY + ry * 0.1, cy + ry * 0.92, p);
    ctx.beginPath();
    for (let k = 0; k <= 18; k++) {
      const u = k / 18;
      const x = cx - rx + u * rx * 2;
      const yy =
        y +
        Math.sin(u * 6.4 + t * (0.75 + i * 0.16) + i * 2.1) * ry * 0.05 +
        Math.sin(u * 13.1 - t * 0.9 + i) * ry * 0.016;
      if (k === 0) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    }
    ctx.lineWidth = Math.max(1, ry * (0.012 + 0.008 * Math.sin(t * 1.4 + i)));
    ctx.strokeStyle = `rgba(186,244,255,${(0.05 + 0.03 * Math.sin(t * 1.7 + i * 1.4)).toFixed(3)})`;
    ctx.stroke();
  }

  // A brighter pool where the surface waves focus, right under the meniscus.
  const focus = sim.surfaceHeightAt(0.5);
  const pool = ctx.createRadialGradient(
    cx,
    cy + ry * 0.55 + focus,
    0,
    cx,
    cy + ry * 0.55,
    rx * 0.7,
  );
  pool.addColorStop(0, 'rgba(150,235,255,0.1)');
  pool.addColorStop(1, 'rgba(150,235,255,0)');
  ctx.fillStyle = pool;
  ctx.fillRect(cx - rx, cy, rx * 2, ry);
  ctx.restore();
};

/**
 * Render the whole bowl: glass, water, caustics, the fish inside it, the
 * refracted magnification of the lower half, the meniscus, splash rings and
 * the rim highlight. 'sim' supplies the live surface and school.
 */
export function drawBowl(
  ctx: CanvasRenderingContext2D,
  bounds: BowlBounds,
  sim: BowlSimulation,
  t: number,
): void {
  const { cx, cy, rx, ry } = bounds;
  if (rx < 8 || ry < 8) return;

  // --- 1. contact shadow + the light the bowl throws on the table -----------
  ctx.save();
  ctx.translate(cx, cy + ry * 0.97);
  ctx.scale(1, 0.17);
  const sh = ctx.createRadialGradient(0, 0, 0, 0, 0, rx * 1.15);
  sh.addColorStop(0, 'rgba(0,0,0,0.62)');
  sh.addColorStop(0.5, 'rgba(0,0,0,0.3)');
  sh.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = sh;
  ctx.beginPath();
  ctx.arc(0, 0, rx * 1.15, 0, TAU);
  ctx.fill();
  ctx.globalCompositeOperation = 'lighter';
  const bounce = ctx.createRadialGradient(0, 0, 0, 0, 0, rx * 0.85);
  bounce.addColorStop(0, 'rgba(70,190,220,0.18)');
  bounce.addColorStop(1, 'rgba(70,190,220,0)');
  ctx.fillStyle = bounce;
  ctx.beginPath();
  ctx.arc(0, 0, rx * 0.85, 0, TAU);
  ctx.fill();
  ctx.restore();

  // --- 2. the empty glass above the water line ------------------------------
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU);
  ctx.clip();
  const air = ctx.createLinearGradient(cx - rx, cy - ry, cx + rx, cy + ry);
  air.addColorStop(0, 'rgba(158,206,224,0.16)');
  air.addColorStop(0.5, 'rgba(110,166,196,0.07)');
  air.addColorStop(1, 'rgba(70,120,150,0.13)');
  ctx.fillStyle = air;
  ctx.fillRect(cx - rx, cy - ry, rx * 2, ry * 2);
  ctx.restore();

  // --- 3. the water and its inhabitants -------------------------------------
  ctx.save();
  clipWater(ctx, bounds, sim);
  paintWater(ctx, bounds);
  paintCaustics(ctx, bounds, sim, t);

  const school = sim.fish;
  for (const f of school) {
    if (f.enterT >= 1) drawBowlFish(ctx, f, t);
  }

  // Refraction: the glass magnifies everything below the widest point of the
  // bowl. Repaint the band and redraw the school through a wider transform.
  const lensY = cy + ry * 0.26;
  ctx.save();
  ctx.beginPath();
  ctx.rect(cx - rx * 1.15, lensY, rx * 2.3, ry * 1.3);
  ctx.clip();
  // Everything in the band is repainted exactly once, through the wider
  // transform — water, light and fish alike, so the seam stays continuous.
  ctx.translate(cx, lensY);
  ctx.scale(1.16, 1.06);
  ctx.translate(-cx, -lensY);
  paintWater(ctx, bounds);
  paintCaustics(ctx, bounds, sim, t);
  for (const f of school) {
    if (f.enterT >= 1 && f.y + f.size * 1.2 > lensY) drawBowlFish(ctx, f, t);
  }
  ctx.restore();

  // The seam of the lens, softened into a band of bent light.
  const seam = ctx.createLinearGradient(0, lensY - ry * 0.09, 0, lensY + ry * 0.11);
  seam.addColorStop(0, 'rgba(190,240,255,0)');
  seam.addColorStop(0.45, 'rgba(190,240,255,0.13)');
  seam.addColorStop(1, 'rgba(190,240,255,0)');
  ctx.fillStyle = seam;
  ctx.fillRect(cx - rx, lensY - ry * 0.09, rx * 2, ry * 0.2);

  // Thick glass at the left and right edges bends the water into a dark lip.
  const edge = ctx.createLinearGradient(cx - rx, 0, cx + rx, 0);
  edge.addColorStop(0, 'rgba(4,26,44,0.75)');
  edge.addColorStop(0.13, 'rgba(4,26,44,0)');
  edge.addColorStop(0.87, 'rgba(4,26,44,0)');
  edge.addColorStop(1, 'rgba(4,26,44,0.75)');
  ctx.fillStyle = edge;
  ctx.fillRect(cx - rx, cy - ry, rx * 2, ry * 2);

  // --- 4. the meniscus, still inside the water clip -------------------------
  const meniscus = ctx.createLinearGradient(0, bounds.waterY - ry * 0.02, 0, bounds.waterY + ry * 0.16);
  meniscus.addColorStop(0, 'rgba(226,252,255,0.55)');
  meniscus.addColorStop(1, 'rgba(226,252,255,0)');
  ctx.beginPath();
  ctx.moveTo(cx - rx * 1.06, sim.waterLineY(cx - rx * 1.06));
  traceSurface(ctx, bounds, sim);
  traceSurface(ctx, bounds, sim, ry * 0.16, true);
  ctx.closePath();
  ctx.fillStyle = meniscus;
  ctx.fill();
  ctx.restore();

  // --- 5. the water line itself, clipped to the glass -----------------------
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU);
  ctx.clip();

  ctx.beginPath();
  ctx.moveTo(cx - rx * 1.06, sim.waterLineY(cx - rx * 1.06));
  traceSurface(ctx, bounds, sim);
  ctx.strokeStyle = 'rgba(224,252,255,0.9)';
  ctx.lineWidth = Math.max(1.3, ry * 0.012);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(cx - rx * 1.06, sim.waterLineY(cx - rx * 1.06) + ry * 0.03);
  traceSurface(ctx, bounds, sim, ry * 0.03);
  ctx.strokeStyle = 'rgba(150,220,240,0.35)';
  ctx.lineWidth = Math.max(1, ry * 0.008);
  ctx.stroke();

  // --- 6. splash rings from every entry (§92) -------------------------------
  for (const s of sim.splashes) {
    const p = clamp01(s.age / s.life);
    const fade = (1 - p) * (1 - p);
    const rad = lerp(ry * 0.04, ry * 0.46, p) * (0.65 + s.strength * 0.6);
    const y = sim.waterLineY(s.x);
    ctx.lineWidth = Math.max(1, ry * 0.011 * (1 - p * 0.6));
    ctx.strokeStyle = `rgba(230,253,255,${(fade * 0.8 * s.strength).toFixed(3)})`;
    ctx.beginPath();
    ctx.ellipse(s.x, y, rad, rad * 0.26, 0, 0, TAU);
    ctx.stroke();
    if (p > 0.18) {
      ctx.strokeStyle = `rgba(200,244,255,${(fade * 0.4 * s.strength).toFixed(3)})`;
      ctx.beginPath();
      ctx.ellipse(s.x, y, rad * 0.55, rad * 0.15, 0, 0, TAU);
      ctx.stroke();
    }
    // The crown of droplets thrown up in the first instants.
    if (p < 0.45) {
      const dp = p / 0.45;
      ctx.fillStyle = `rgba(236,253,255,${((1 - dp) * 0.85 * s.strength).toFixed(3)})`;
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI + 0.2;
        const dx = Math.cos(a) * rad * 1.1;
        const dy = -Math.sin(a * 1.2) * ry * 0.2 * (1 - dp) + dp * dp * ry * 0.16;
        ctx.beginPath();
        ctx.arc(s.x + dx, y + dy, Math.max(0.8, ry * 0.014 * (1 - dp)), 0, TAU);
        ctx.fill();
      }
    }
  }
  ctx.restore();

  // --- 7. fish still falling in, drawn above the water -----------------------
  for (const f of sim.fish) {
    if (f.enterT >= 1 || f.scale <= 0.005) continue;
    // A wet streak trailing the fall sells the drop from the poi (§92).
    const streak = ctx.createLinearGradient(f.x, f.y - f.size * 1.6, f.x, f.y);
    streak.addColorStop(0, 'rgba(190,240,255,0)');
    streak.addColorStop(1, 'rgba(190,240,255,0.28)');
    ctx.fillStyle = streak;
    ctx.fillRect(f.x - f.size * 0.06, f.y - f.size * 1.6, f.size * 0.12, f.size * 1.6);
    drawBowlFish(ctx, f, t);
  }

  // --- 8. the glass itself --------------------------------------------------
  ctx.save();
  const rim = ctx.createLinearGradient(cx - rx, cy - ry, cx + rx * 0.6, cy + ry);
  rim.addColorStop(0, 'rgba(238,252,255,0.85)');
  rim.addColorStop(0.35, 'rgba(190,226,240,0.35)');
  rim.addColorStop(0.72, 'rgba(120,170,200,0.22)');
  rim.addColorStop(1, 'rgba(220,246,255,0.5)');
  ctx.strokeStyle = rim;
  ctx.lineWidth = Math.max(1.5, ry * 0.022);
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU);
  ctx.stroke();

  // The long specular crescent on the upper left.
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = Math.max(2, ry * 0.035);
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx * 0.87, ry * 0.87, 0, Math.PI * 1.12, Math.PI * 1.42);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = Math.max(1, ry * 0.016);
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx * 0.74, ry * 0.74, 0, Math.PI * 1.18, Math.PI * 1.34);
  ctx.stroke();

  // Cool bounce along the bottom right of the glass.
  ctx.strokeStyle = 'rgba(150,230,255,0.3)';
  ctx.lineWidth = Math.max(1.5, ry * 0.024);
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx * 0.93, ry * 0.93, 0, Math.PI * 0.1, Math.PI * 0.44);
  ctx.stroke();

  // The mouth of the 金魚鉢, narrower than its belly.
  const mouthY = cy - ry * 0.9;
  const mrx = rx * 0.5;
  const mry = ry * 0.1;
  ctx.strokeStyle = 'rgba(214,244,255,0.42)';
  ctx.lineWidth = Math.max(1.2, ry * 0.014);
  ctx.beginPath();
  ctx.ellipse(cx, mouthY, mrx, mry, 0, 0, TAU);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.beginPath();
  ctx.ellipse(cx, mouthY, mrx, mry, 0, Math.PI * 0.05, Math.PI * 0.95);
  ctx.stroke();
  ctx.restore();
}
