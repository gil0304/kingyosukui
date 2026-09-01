/**
 * Procedural 3D goldfish geometry (spec §65, §74, §130).
 *
 * A real lofted body — never a sprite, never a billboard. One merged
 * 'BufferGeometry' per (type, LOD) holding body + caudal fin + dorsal fin +
 * anal fin + two pectoral fins + two eyes, so the whole school is a handful of
 * draw calls.
 *
 * Local frame: **+X is forward (nose), +Y is up, +Z is the fish's left flank.**
 * The swimming wave in 'fishAnimation.ts' displaces along local Z, so every
 * part carries the attributes the vertex shader needs to move independently:
 *
 *   aPart  0 body · 1 caudal fin · 2 pectoral fin · 3 dorsal/anal fin · 4 eye
 *   aSpine 0 at the nose → 1 at the tip of the tail (drives the travelling wave)
 *   aSide  -1 / 0 / +1   (which pectoral fin a vertex belongs to)
 *
 * Geometry is built at **world scale** straight from 'FISH_CATALOG[type].size',
 * so a consumer can drop it into the scene without knowing the catalogue.
 * 'FishSchool' therefore only applies a small per-instance size jitter.
 *
 * Everything is cached: geometry for a (type, LOD) pair is built exactly once.
 */

import { BufferGeometry, Float32BufferAttribute } from 'three';

import { FISH_CATALOG } from '@/game/fish/fishTypes';
import { TAU, clamp, clamp01, lerp } from '@/game/core/math';
import type { FishType } from '@/types';

export type FishLod = 0 | 1 | 2;

/**
 * Camera distances at which a fish drops to the next LOD.
 * The screen camera sits at (0, 3.2, 9.6): the nearest fish is ~6.4 units away
 * and the far corner of the tank ~16.6, so these two cuts split the tank into
 * roughly equal thirds.
 */
export const FISH_LOD_DISTANCES: readonly [number, number] = [8.5, 13.0];

/** Vertex attribute code for 'aPart'. */
export const FISH_PART = {
  body: 0,
  tail: 1,
  pectoral: 2,
  vfin: 3,
  eye: 4,
} as const;

// ---------------------------------------------------------------------------
// Per-type proportions
// ---------------------------------------------------------------------------

/**
 * Shape of one species, expressed as fractions of the total nose-to-tail
 * length so the same maths works for the stubby 出目金 and the sleek 金色金魚.
 */
export interface FishProportions {
  /** Fraction of the total length taken by the body; the rest is caudal fin. */
  bodyFrac: number;
  /** Deepest half-height of the back, as a fraction of total length. */
  depth: number;
  /** Widest half-width, as a fraction of total length. */
  width: number;
  /** Where along the body the deepest ring sits (0 nose, 1 peduncle). */
  girthAt: number;
  /** Ring scale at the nose / at the caudal peduncle, relative to the widest ring. */
  noseR: number;
  peduncleR: number;
  /** Belly fullness relative to the back (goldfish are deep-bellied). */
  belly: number;
  /** How far the ring centres sag below the spine axis. */
  bellyDrop: number;
  /** Extra height of the shoulder hump behind the head. */
  hump: number;
  /** Caudal fin: half opening angle (rad), depth of the central notch, veil ruffle. */
  tailAngle: number;
  tailNotch: number;
  tailRuffle: number;
  /** Fin sizes as fractions of total length. */
  dorsal: number;
  anal: number;
  pectoral: number;
  /** Eye radius as a fraction of total length. */
  eye: number;
  /** 出目金 eyes bulge out on stalks; everyone else gets a flat eye disc. */
  bulgingEyes: boolean;
}

export const FISH_PROPORTIONS: Record<FishType, FishProportions> = {
  red: {
    bodyFrac: 0.66,
    depth: 0.155,
    width: 0.082,
    girthAt: 0.34,
    noseR: 0.18,
    peduncleR: 0.13,
    belly: 1.3,
    bellyDrop: 0.03,
    hump: 0.1,
    tailAngle: 0.95,
    tailNotch: 0.34,
    tailRuffle: 0.035,
    dorsal: 0.105,
    anal: 0.055,
    pectoral: 0.16,
    eye: 0.03,
    bulgingEyes: false,
  },
  redwhite: {
    bodyFrac: 0.64,
    depth: 0.168,
    width: 0.09,
    girthAt: 0.35,
    noseR: 0.19,
    peduncleR: 0.13,
    belly: 1.34,
    bellyDrop: 0.034,
    hump: 0.13,
    tailAngle: 1.02,
    tailNotch: 0.38,
    tailRuffle: 0.042,
    dorsal: 0.11,
    anal: 0.06,
    pectoral: 0.17,
    eye: 0.031,
    bulgingEyes: false,
  },
  black: {
    // 黒金魚 is the lean, twitchy one — slimmer body, tighter tail.
    bodyFrac: 0.68,
    depth: 0.142,
    width: 0.076,
    girthAt: 0.32,
    noseR: 0.16,
    peduncleR: 0.12,
    belly: 1.22,
    bellyDrop: 0.026,
    hump: 0.08,
    tailAngle: 0.88,
    tailNotch: 0.3,
    tailRuffle: 0.03,
    dorsal: 0.1,
    anal: 0.05,
    pectoral: 0.155,
    eye: 0.029,
    bulgingEyes: false,
  },
  demekin: {
    // 出目金: short round body, huge veil tail, protruding spherical eyes.
    bodyFrac: 0.58,
    depth: 0.215,
    width: 0.15,
    girthAt: 0.38,
    noseR: 0.26,
    peduncleR: 0.16,
    belly: 1.42,
    bellyDrop: 0.042,
    hump: 0.18,
    tailAngle: 1.15,
    tailNotch: 0.46,
    tailRuffle: 0.055,
    dorsal: 0.12,
    anal: 0.07,
    pectoral: 0.19,
    eye: 0.058,
    bulgingEyes: true,
  },
  gold: {
    // 金色金魚: sleek comet body with a long flowing tail (spec §108).
    bodyFrac: 0.62,
    depth: 0.152,
    width: 0.08,
    girthAt: 0.33,
    noseR: 0.17,
    peduncleR: 0.115,
    belly: 1.26,
    bellyDrop: 0.03,
    hump: 0.11,
    tailAngle: 1.05,
    tailNotch: 0.42,
    tailRuffle: 0.05,
    dorsal: 0.115,
    anal: 0.058,
    pectoral: 0.175,
    eye: 0.03,
    bulgingEyes: false,
  },
};

/** Where the nose sits on the local X axis, as a fraction of total length. */
const NOSE_X = 0.46;

// Tessellation per LOD. LOD 1/2 already carry roughly half the fin detail of
// LOD 0, which is exactly what the low-quality path asks for when it drops LOD 0.
const LOD_BODY_RINGS = [28, 16, 9] as const;
const LOD_BODY_RADIAL = [16, 10, 6] as const;
const LOD_TAIL = [
  [7, 14],
  [5, 8],
  [3, 5],
] as const;
const LOD_RIBBON = [
  [9, 5],
  [6, 3],
  [4, 2],
] as const;
const LOD_PECTORAL = [
  [5, 8],
  [3, 5],
  [2, 3],
] as const;
const LOD_EYE = [
  [6, 10],
  [4, 7],
  [3, 5],
] as const;

// ---------------------------------------------------------------------------
// Body profile
// ---------------------------------------------------------------------------

interface Profile {
  /** Total nose-to-tail length in world units. */
  readonly length: number;
  readonly noseX: number;
  readonly pedX: number;
  readonly tipX: number;
  /** Spine parameter (0..1) for a local X coordinate. */
  spineOf(x: number): number;
  /** Point on the body surface. 'u' runs 0 (nose) → 1 (caudal peduncle). */
  ring(u: number, theta: number, out: Float32Array): void;
  /** Outward surface normal at the same parameters. */
  ringNormal(u: number, theta: number, out: Float32Array): void;
  readonly p: FishProportions;
}

const smooth01 = (t: number): number => t * t * (3 - 2 * t);

const makeProfile = (type: FishType): Profile => {
  const p = FISH_PROPORTIONS[type];
  const L = FISH_CATALOG[type].size;
  const noseX = NOSE_X * L;
  const pedX = noseX - p.bodyFrac * L;
  const tipX = noseX - L;

  // Girth envelope: swells from the snout to the shoulder, then tapers to the
  // narrow caudal peduncle the tail fin hangs off.
  const shape = (u: number): number => {
    if (u <= p.girthAt) {
      const t = u / p.girthAt;
      return lerp(p.noseR, 1, Math.pow(Math.sin(t * Math.PI * 0.5), 0.75));
    }
    const t = (u - p.girthAt) / (1 - p.girthAt);
    return lerp(1, p.peduncleR, Math.pow(smooth01(clamp01(t)), 0.8));
  };

  const humpF = (u: number): number =>
    1 + p.hump * Math.pow(Math.sin(Math.PI * clamp01((u - 0.08) / 0.7)), 1.6);

  const bellyF = (u: number): number =>
    1 + (p.belly - 1) * Math.pow(Math.sin(Math.PI * clamp01((u - 0.05) / 0.85)), 1.2);

  const rTop = (u: number): number => L * p.depth * shape(u) * humpF(u);
  const rBelly = (u: number): number => L * p.depth * shape(u) * bellyF(u);
  const rWide = (u: number): number => L * p.width * shape(u) * (1 + 0.18 * Math.sin(Math.PI * u));
  // Sags in the middle and returns to the axis at both ends, so the tail fan
  // and the head both sit on y = 0 and the shader can spread the lobes about it.
  const yMid = (u: number): number => -L * p.bellyDrop * Math.pow(Math.sin(Math.PI * u), 1.1);

  const ring = (u: number, theta: number, out: Float32Array): void => {
    const cy = Math.cos(theta);
    const cz = Math.sin(theta);
    // Blend belly radius into back radius across the flank so the egg-shaped
    // cross-section stays C1 continuous (a hard switch would crease the shading).
    const w = smooth01(clamp01((cy + 0.45) / 0.9));
    const ry = lerp(rBelly(u), rTop(u), w);
    out[0] = lerp(noseX, pedX, u);
    out[1] = yMid(u) + ry * cy;
    out[2] = rWide(u) * cz;
  };

  const na = new Float32Array(3);
  const nb = new Float32Array(3);
  const ringNormal = (u: number, theta: number, out: Float32Array): void => {
    const du = 0.004;
    const dt = 0.004;
    const cu = clamp(u, du, 1 - du);
    ring(cu + du, theta, na);
    ring(cu - du, theta, nb);
    const ux = na[0] - nb[0];
    const uy = na[1] - nb[1];
    const uz = na[2] - nb[2];
    ring(cu, theta + dt, na);
    ring(cu, theta - dt, nb);
    const tx = na[0] - nb[0];
    const ty = na[1] - nb[1];
    const tz = na[2] - nb[2];
    // n = tangent_u × tangent_theta points outward with this parameterisation.
    let nx = uy * tz - uz * ty;
    let ny = uz * tx - ux * tz;
    let nz = ux * ty - uy * tx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    out[0] = nx;
    out[1] = ny;
    out[2] = nz;
  };

  return {
    length: L,
    noseX,
    pedX,
    tipX,
    p,
    spineOf: (x: number) => clamp01((noseX - x) / L),
    ring,
    ringNormal,
  };
};

// ---------------------------------------------------------------------------
// Mesh builder
// ---------------------------------------------------------------------------

/** A parametric patch: writes the surface point for (i, j) ∈ [0,1]². */
type PatchFn = (i: number, j: number, out: Float32Array) => void;

class Builder {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly uv: number[] = [];
  readonly part: number[] = [];
  readonly spine: number[] = [];
  readonly side: number[] = [];
  readonly idx: number[] = [];

  get vertexCount(): number {
    return this.pos.length / 3;
  }
}

const tmpA = new Float32Array(3);
const tmpB = new Float32Array(3);
const tmpC = new Float32Array(3);
const tmpD = new Float32Array(3);

/**
 * Tessellate a parametric patch into the builder.
 *
 * Normals come from central differences of 'point' rather than from face
 * averaging: that keeps the wrapped body seam perfectly smooth and gives the
 * fins the normal of the sheet they actually describe.
 *
 * 'segI' × 'segJ' quads; the sample used for the normal is nudged away from
 * i = 0 and i = 1 so degenerate rows (a fan hub, a sphere pole) still resolve.
 */
const addPatch = (
  b: Builder,
  segI: number,
  segJ: number,
  point: PatchFn,
  part: number,
  side: number,
  spineOf: (x: number) => number,
): void => {
  const base = b.vertexCount;
  const di = 0.5 / Math.max(segI, 1);
  const dj = 0.5 / Math.max(segJ, 1);

  for (let i = 0; i <= segI; i++) {
    const fi = i / segI;
    const si = clamp(fi, di, 1 - di);
    for (let j = 0; j <= segJ; j++) {
      const fj = j / segJ;
      point(fi, fj, tmpA);

      point(si + di, fj, tmpB);
      point(si - di, fj, tmpC);
      const ux = tmpB[0] - tmpC[0];
      const uy = tmpB[1] - tmpC[1];
      const uz = tmpB[2] - tmpC[2];

      point(si, fj + dj, tmpB);
      point(si, fj - dj, tmpD);
      const vx = tmpB[0] - tmpD[0];
      const vy = tmpB[1] - tmpD[1];
      const vz = tmpB[2] - tmpD[2];

      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz);
      if (l > 1e-9) {
        nx /= l;
        ny /= l;
        nz /= l;
      } else {
        nx = 1;
        ny = 0;
        nz = 0;
      }

      b.pos.push(tmpA[0], tmpA[1], tmpA[2]);
      b.nrm.push(nx, ny, nz);
      b.uv.push(fi, fj);
      b.part.push(part);
      b.spine.push(spineOf(tmpA[0]));
      b.side.push(side);
    }
  }

  const stride = segJ + 1;
  for (let i = 0; i < segI; i++) {
    for (let j = 0; j < segJ; j++) {
      const a = base + i * stride + j;
      const bb = a + 1;
      const c = a + stride + 1;
      const d = a + stride;
      // Winding chosen so the face normal matches ∂p/∂i × ∂p/∂j.
      b.idx.push(a, d, c, a, c, bb);
    }
  }
};

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

const addBody = (b: Builder, pr: Profile, lod: FishLod): void => {
  const rings = LOD_BODY_RINGS[lod];
  const radial = LOD_BODY_RADIAL[lod];

  addPatch(
    b,
    rings - 1,
    radial,
    (i, j, out) => pr.ring(i, j * TAU, out),
    FISH_PART.body,
    0,
    pr.spineOf,
  );

  // Rounded snout cap: sweeps the first ring forward onto a single apex.
  const capLen = pr.length * 0.05;
  const capRing = new Float32Array(3);
  addPatch(
    b,
    2,
    radial,
    (i, j, out) => {
      const a = (1 - i) * Math.PI * 0.5;
      pr.ring(0, j * TAU, capRing);
      const s = Math.cos(a);
      out[0] = pr.noseX + Math.sin(a) * capLen + (capRing[0] - pr.noseX) * s;
      out[1] = lerp(0, capRing[1], s);
      out[2] = capRing[2] * s;
    },
    FISH_PART.body,
    0,
    pr.spineOf,
  );

  // Flat cap over the caudal peduncle (hidden inside the tail root, but the
  // body must stay a closed volume for correct shading at grazing angles).
  addPatch(
    b,
    1,
    radial,
    (i, j, out) => {
      pr.ring(1, j * TAU, capRing);
      out[0] = pr.pedX - i * pr.length * 0.012;
      out[1] = capRing[1] * (1 - i);
      out[2] = capRing[2] * (1 - i);
    },
    FISH_PART.body,
    0,
    pr.spineOf,
  );
};

/**
 * The flowing double-lobed goldfish tail: a fan of rays leaving the peduncle,
 * shortened in the middle so the trailing edge splits into two lobes, and
 * rippled out of plane so it reads as a veil rather than a card.
 */
const addCaudal = (b: Builder, pr: Profile, lod: FishLod): void => {
  const p = pr.p;
  const [segR, segT] = LOD_TAIL[lod];
  const ruffle = p.tailRuffle * pr.length;

  const notchAt = (t: number): number => 1 - p.tailNotch * Math.exp(-(t * 3) * (t * 3));
  const taperAt = (t: number): number => 1 - 0.25 * t * t * t * t;

  // Normalise so the furthest-back point of the fin lands exactly at the
  // nominal tail tip: that is what makes 'aSpine' reach 1.0 at the tip and the
  // fish exactly 'FISH_CATALOG.size' long from snout to trailing edge.
  let extent = 1e-4;
  for (let s = 0; s <= 64; s++) {
    const t = (s / 64) * 2 - 1;
    extent = Math.max(extent, Math.cos(t * p.tailAngle) * notchAt(t) * taperAt(t));
  }
  const reach = ((1 - p.bodyFrac) * pr.length) / extent;

  addPatch(
    b,
    segR,
    segT,
    (i, j, out) => {
      const t = j * 2 - 1; // -1 lower lobe .. +1 upper lobe
      const phi = t * p.tailAngle;
      const notch = notchAt(t);
      const taper = taperAt(t);
      const len = reach * notch * taper * i;
      out[0] = pr.pedX - Math.cos(phi) * len;
      out[1] = Math.sin(phi) * len;
      out[2] = ruffle * (Math.sin(t * 4.2) * i * i + 0.35 * Math.sin(i * 5) * t);
    },
    FISH_PART.tail,
    0,
    pr.spineOf,
  );
};

/** Dorsal / anal fin: a sail rising off a base line that follows the body. */
const addRibbon = (
  b: Builder,
  pr: Profile,
  lod: FishLod,
  u0: number,
  u1: number,
  theta: number,
  height: number,
  dir: number,
  peak: number,
): void => {
  const [segT, segK] = LOD_RIBBON[lod];
  const base = new Float32Array(3);
  const h = height * pr.length;

  addPatch(
    b,
    segT,
    segK,
    (i, j, out) => {
      const u = lerp(u0, u1, i);
      pr.ring(u, theta, base);
      const rise = h * Math.pow(Math.abs(Math.sin(Math.PI * (peak + 0.7 * i))), 0.7);
      out[0] = base[0] - 0.3 * rise * j;
      out[1] = base[1] + dir * rise * j;
      out[2] = base[2] + 0.022 * pr.length * Math.sin(i * 3) * j * j;
    },
    FISH_PART.vfin,
    0,
    pr.spineOf,
  );
};

/**
 * Pectoral fin. Built in its own frame so the vertex shader can flap it as a
 * rigid rotation about the body axis; 'aSide' tells the shader which one.
 */
const addPectoral = (b: Builder, pr: Profile, lod: FishLod, side: number): void => {
  const p = pr.p;
  const [segR, segT] = LOD_PECTORAL[lod];
  const root = new Float32Array(3);
  pr.ring(0.3, Math.atan2(side * 0.95, -0.28), root);

  // Sweep backward, outward and slightly down — the resting pose of a goldfish.
  let ux = -0.7;
  let uy = -0.34;
  let uz = side * 0.62;
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul;
  uy /= ul;
  uz /= ul;

  // dirV = up × dirU keeps the blade horizontal, so the axis it is thin along
  // (and therefore the axis the shader flaps it around) is vertical.
  let vx = uz;
  let vy = 0;
  let vz = -ux;
  const vl = Math.hypot(vx, vy, vz) || 1;
  vx /= vl;
  vy /= vl;
  vz /= vl;

  const reach = p.pectoral * pr.length;
  // Gentle cup so the blade is not a flat card even before the shader flaps it.
  const cup = 0.035 * pr.length;

  addPatch(
    b,
    segR,
    segT,
    (i, j, out) => {
      const t = j * 2 - 1;
      const phi = t * 0.8;
      const len = reach * (1 - 0.3 * t * t) * i;
      const cp = Math.cos(phi) * len;
      const sp = Math.sin(phi) * len;
      const lift = cup * i * i * (1 - t * t);
      out[0] = root[0] + ux * cp + vx * sp;
      out[1] = root[1] + uy * cp + vy * sp - lift;
      out[2] = root[2] + uz * cp + vz * sp;
    },
    FISH_PART.pectoral,
    side,
    pr.spineOf,
  );
};

/** Eye. A flattened disc for most fish, a full protruding sphere for 出目金. */
const addEye = (b: Builder, pr: Profile, lod: FishLod, side: number): void => {
  const p = pr.p;
  const [segLat, segLon] = LOD_EYE[lod];
  const u = 0.135;
  const theta = Math.atan2(side * 0.86, 0.5);
  const surf = new Float32Array(3);
  const nrm = new Float32Array(3);
  pr.ring(u, theta, surf);
  pr.ringNormal(u, theta, nrm);

  const r = p.eye * pr.length;
  const push = p.bulgingEyes ? r * 0.55 : -r * 0.2;
  const cx = surf[0] + nrm[0] * push;
  const cy = surf[1] + nrm[1] * push;
  const cz = surf[2] + nrm[2] * push;
  // A flat eye is squashed against the flank; a demekin eye is a true sphere.
  const rz = p.bulgingEyes ? r : r * 0.45;

  addPatch(
    b,
    segLat,
    segLon,
    (i, j, out) => {
      // Latitude runs south -> north with i so that ∂p/∂i × ∂p/∂j points out
      // of the sphere, matching the winding 'addPatch' emits.
      const lat = (1 - i) * Math.PI;
      const lon = j * TAU;
      const sl = Math.sin(lat);
      out[0] = cx + r * sl * Math.cos(lon);
      out[1] = cy + r * Math.cos(lat);
      out[2] = cz + rz * sl * Math.sin(lon);
    },
    FISH_PART.eye,
    0,
    pr.spineOf,
  );
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const cache = new Map<string, BufferGeometry>();

/**
 * Build (or fetch from cache) the merged goldfish geometry for one species at
 * one LOD. The returned geometry is shared — clone it before attaching
 * instanced attributes to it.
 */
export function createFishGeometry(type: FishType, lod: FishLod): BufferGeometry {
  const key = `${type}:${lod}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const pr = makeProfile(type);
  const p = pr.p;
  const b = new Builder();

  addBody(b, pr, lod);
  addCaudal(b, pr, lod);
  addRibbon(b, pr, lod, 0.38, 0.7, 0, p.dorsal, 1, 0.22);
  addRibbon(b, pr, lod, 0.72, 0.9, Math.PI, p.anal, -1, 0.3);
  addPectoral(b, pr, lod, 1);
  addPectoral(b, pr, lod, -1);
  addEye(b, pr, lod, 1);
  addEye(b, pr, lod, -1);

  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(b.pos, 3));
  g.setAttribute('normal', new Float32BufferAttribute(b.nrm, 3));
  g.setAttribute('uv', new Float32BufferAttribute(b.uv, 2));
  g.setAttribute('aPart', new Float32BufferAttribute(b.part, 1));
  g.setAttribute('aSpine', new Float32BufferAttribute(b.spine, 1));
  g.setAttribute('aSide', new Float32BufferAttribute(b.side, 1));
  g.setIndex(b.idx);
  g.computeBoundingSphere();
  g.computeBoundingBox();
  g.name = `fish.${type}.lod${lod}`;

  cache.set(key, g);
  return g;
}

/** Shader constants that depend on the species' proportions. */
export interface FishShaderParams {
  /** Total nose-to-tail length in world units — the wave amplitude scale. */
  length: number;
  /** Deepest half-height of the body. */
  depth: number;
  /** Y of the pectoral fin root: the axis the shader flaps the fins around. */
  pivotY: number;
  /** 'aSpine' value where the caudal fin begins. */
  tailBase: number;
}

export function fishShaderParams(type: FishType): FishShaderParams {
  const pr = makeProfile(type);
  const root = new Float32Array(3);
  pr.ring(0.3, Math.atan2(0.95, -0.28), root);
  return {
    length: pr.length,
    depth: pr.length * pr.p.depth * pr.p.belly,
    pivotY: root[1],
    tailBase: pr.p.bodyFrac,
  };
}

/** Release every cached geometry (used when the screen scene tears down). */
export function disposeFishGeometries(): void {
  for (const g of cache.values()) g.dispose();
  cache.clear();
}
