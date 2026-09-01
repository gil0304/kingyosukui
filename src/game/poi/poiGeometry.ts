/**
 * Procedural geometry for the poi as it appears on the giant screen (spec §50).
 *
 * A real poi is a bamboo/plastic hoop with a sheet of washi glued over it and a
 * flat handle in the same plane as the ring. Nothing here is a "circle sprite"
 * (§130): the ring is a real torus with a flattened cross-section, the handle is
 * a tapered shaft with bamboo nodes, and the paper is a radially subdivided disc
 * that carries the attributes the paper shader needs to sag, wet and tear it.
 *
 * Local space (poi space):
 *   the paper lies in the XZ plane at y = 0, normal +Y;
 *   the handle runs along +Z (toward the player), coplanar with the ring;
 *   the whole assembly is then positioned/rotated by 'PoiView'.
 *
 * Every geometry is built once and cached at module level — up to 8 poi share
 * the same buffers, and a respawning poi must never trigger a re-tessellation.
 */

import * as THREE from 'three';

import { POI } from '@/game/core/constants';
import { TAU, clamp01, lerp, noise1 } from '@/game/core/math';

/** Centre-line radius of the hoop, so its outer edge lands on 'POI.frameRadius'. */
const FRAME_RING_RADIUS = POI.frameRadius - POI.frameThickness;
/** Radial half-width of the hoop's cross-section. */
const FRAME_HALF_WIDTH = POI.frameThickness;
/** Vertical half-height — a real hoop is a flat band, not a round rod. */
const FRAME_HALF_HEIGHT = POI.frameThickness * 0.58;

/** How far the handle tucks in under the paper before it emerges past the ring. */
const HANDLE_START_Z = FRAME_RING_RADIUS * 0.52;
const HANDLE_END_Z = HANDLE_START_Z + POI.handleLength;
/** The handle sits just below the ring so the paper stays the top surface. */
const HANDLE_Y = -(FRAME_HALF_HEIGHT + POI.handleRadius * 0.72);

let frameGeometry: THREE.BufferGeometry | null = null;
let handleGeometry: THREE.BufferGeometry | null = null;
let cordGeometry: THREE.BufferGeometry | null = null;
const paperGeometries = new Map<string, THREE.BufferGeometry>();

/** Two-octave 1D value noise — enough for wood mottling, and deterministic. */
const grain2 = (a: number, b: number): number =>
  noise1(a) * 0.62 + noise1(b * 1.7 + 31.4) * 0.38;

/**
 * The bamboo hoop.
 *
 * Torus of revolution with an ELLIPTICAL cross-section (wide radially, thin
 * vertically). Normals are analytic: for
 *   P = ((R + a·cosθ)·cosφ, b·sinθ, (R + a·cosθ)·sinφ)
 * the surface normal is proportional to (b·cosθ·cosφ, a·sinθ, b·cosθ·sinφ).
 *
 * Colour variation (bamboo nodes + fibre mottling) is baked into a 'color'
 * attribute so a single plain MeshPhysicalMaterial can render it.
 */
export function createPoiFrameGeometry(): THREE.BufferGeometry {
  if (frameGeometry) return frameGeometry;

  const RING_SEG = 96;
  const TUBE_SEG = 10;
  const vertexCount = (RING_SEG + 1) * (TUBE_SEG + 1);

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const colors = new Float32Array(vertexCount * 3);
  const indices = new Uint16Array(RING_SEG * TUBE_SEG * 6);

  let v = 0;
  for (let i = 0; i <= RING_SEG; i++) {
    const u = i / RING_SEG;
    const phi = u * TAU;
    const cp = Math.cos(phi);
    const sp = Math.sin(phi);

    // Bamboo nodes: three slightly fatter, darker bands around the hoop.
    const node = Math.pow(Math.max(0, Math.sin(u * Math.PI * 3.0)), 26);
    const mottle = grain2(u * 17.0, u * 5.0);
    const swell = 1 + node * 0.16 + mottle * 0.035;

    for (let j = 0; j <= TUBE_SEG; j++) {
      const theta = (j / TUBE_SEG) * TAU;
      const ct = Math.cos(theta);
      const st = Math.sin(theta);

      const a = FRAME_HALF_WIDTH * swell;
      const b = FRAME_HALF_HEIGHT * swell;
      const ring = FRAME_RING_RADIUS + a * ct;

      const o3 = v * 3;
      positions[o3 + 0] = ring * cp;
      positions[o3 + 1] = b * st;
      positions[o3 + 2] = ring * sp;

      const nx = b * ct * cp;
      const ny = a * st;
      const nz = b * ct * sp;
      const nl = Math.hypot(nx, ny, nz) || 1;
      normals[o3 + 0] = nx / nl;
      normals[o3 + 1] = ny / nl;
      normals[o3 + 2] = nz / nl;

      // Underside stays in shadow, nodes darken, fibres mottle along the ring.
      const shade =
        0.90 - node * 0.24 + mottle * 0.10 - Math.max(0, -st) * 0.16 + grain2(theta * 3.1, u * 41) * 0.04;
      const c = clamp01(shade);
      colors[o3 + 0] = c;
      colors[o3 + 1] = c * (0.985 - node * 0.03);
      colors[o3 + 2] = c * (0.94 - node * 0.06);

      uvs[v * 2 + 0] = u * 6;
      uvs[v * 2 + 1] = j / TUBE_SEG;
      v++;
    }
  }

  let k = 0;
  for (let i = 0; i < RING_SEG; i++) {
    for (let j = 0; j < TUBE_SEG; j++) {
      const a = i * (TUBE_SEG + 1) + j;
      const b = a + TUBE_SEG + 1;
      indices[k++] = a;
      indices[k++] = b;
      indices[k++] = a + 1;
      indices[k++] = b;
      indices[k++] = b + 1;
      indices[k++] = a + 1;
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.setIndex(new THREE.BufferAttribute(indices, 1));
  g.computeBoundingSphere();
  g.name = 'poi.frame';

  frameGeometry = g;
  return g;
}

/**
 * The washi disc.
 *
 * Radially subdivided (default 48 radial × 14 rings) so the paper shader can
 * sag it as a membrane, stretch it and open a hole from the centre outward.
 *
 * Extra attributes:
 *   'aRadius' — 0 at the centre, 1 at the rim (drives sag, wetting and tearing)
 *   'aAngle'  — 0..2π around the disc (drives the ragged tear edge and rim ripple)
 *
 * Vertices are laid out ring by ring with a duplicated seam column so 'aAngle'
 * is continuous — a wrapped column would make the tear edge seam-pop.
 */
export function createPoiPaperGeometry(segments = 48, rings = 14): THREE.BufferGeometry {
  const seg = Math.max(8, Math.round(segments));
  const rng = Math.max(3, Math.round(rings));
  const key = `${seg}x${rng}`;
  const cached = paperGeometries.get(key);
  if (cached) return cached;

  const vertexCount = (rng + 1) * (seg + 1);
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const aRadius = new Float32Array(vertexCount);
  const aAngle = new Float32Array(vertexCount);

  // The first ring is a fan (all its vertices sit at the centre), every other
  // ring is a quad strip: rng*seg*2 - seg triangles.
  const indices = new Uint32Array((rng * seg * 2 - seg) * 3);

  let v = 0;
  for (let r = 0; r <= rng; r++) {
    // Slight bias toward the centre: that is where the hole opens and where the
    // membrane curvature is highest.
    const t = Math.pow(r / rng, 0.92);
    const radius = t * POI.paperRadius;
    for (let s = 0; s <= seg; s++) {
      const angle = (s / seg) * TAU;
      const o3 = v * 3;
      positions[o3 + 0] = Math.cos(angle) * radius;
      positions[o3 + 1] = 0;
      positions[o3 + 2] = Math.sin(angle) * radius;
      normals[o3 + 1] = 1;
      uvs[v * 2 + 0] = (Math.cos(angle) * t + 1) * 0.5;
      uvs[v * 2 + 1] = (Math.sin(angle) * t + 1) * 0.5;
      aRadius[v] = t;
      aAngle[v] = angle;
      v++;
    }
  }

  let k = 0;
  const row = seg + 1;
  for (let r = 0; r < rng; r++) {
    for (let s = 0; s < seg; s++) {
      const a = r * row + s;
      const b = a + row;
      if (r === 0) {
        // Degenerate inner edge — one triangle instead of a zero-area quad.
        indices[k++] = a;
        indices[k++] = b;
        indices[k++] = b + 1;
      } else {
        indices[k++] = a;
        indices[k++] = b;
        indices[k++] = a + 1;
        indices[k++] = b;
        indices[k++] = b + 1;
        indices[k++] = a + 1;
      }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setAttribute('aRadius', new THREE.BufferAttribute(aRadius, 1));
  g.setAttribute('aAngle', new THREE.BufferAttribute(aAngle, 1));
  g.setIndex(new THREE.BufferAttribute(indices, 1));
  // The shader sags the disc well below y=0, so the auto bounding sphere would
  // cull it at grazing angles. Give it a generous manual bound instead.
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -0.15, 0), POI.paperRadius * 1.35);
  g.name = `poi.paper.${key}`;

  paperGeometries.set(key, g);
  return g;
}

/**
 * The handle: a tapered shaft along +Z with three bamboo nodes and a wood grain
 * baked into vertex colours. Surface of revolution about the Z axis, so the
 * normal is analytic: (cosφ, sinφ, −dr/dz).
 */
export function createPoiHandleGeometry(): THREE.BufferGeometry {
  if (handleGeometry) return handleGeometry;

  const RADIAL = 14;
  const AXIAL = 44;
  const length = HANDLE_END_Z - HANDLE_START_Z;

  const radiusAt = (t: number): number => {
    // Thick where it grips the hoop, slimmer at the far end the hand holds.
    const taper = lerp(1.22, 0.84, t);
    const node = Math.pow(Math.max(0, Math.sin(t * Math.PI * 3.0 + 0.4)), 20);
    const wobble = grain2(t * 9.0, t * 3.0) * 0.03;
    return POI.handleRadius * (taper + node * 0.13 + wobble);
  };

  // +2 vertices for the two cap centres.
  const sideCount = (AXIAL + 1) * (RADIAL + 1);
  const vertexCount = sideCount + 2 * (RADIAL + 2);
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const colors = new Float32Array(vertexCount * 3);
  const indices: number[] = [];

  let v = 0;
  for (let i = 0; i <= AXIAL; i++) {
    const t = i / AXIAL;
    const z = lerp(HANDLE_START_Z, HANDLE_END_Z, t);
    const r = radiusAt(t);
    // Central difference for dr/dz, clamped at the ends.
    const dt = 1 / AXIAL;
    const rPrev = radiusAt(Math.max(0, t - dt));
    const rNext = radiusAt(Math.min(1, t + dt));
    const drdz = (rNext - rPrev) / (Math.min(1, t + dt) - Math.max(0, t - dt)) / length;

    const node = Math.pow(Math.max(0, Math.sin(t * Math.PI * 3.0 + 0.4)), 20);

    for (let j = 0; j <= RADIAL; j++) {
      const phi = (j / RADIAL) * TAU;
      const cp = Math.cos(phi);
      const sp = Math.sin(phi);

      const o3 = v * 3;
      positions[o3 + 0] = cp * r;
      positions[o3 + 1] = HANDLE_Y + sp * r;
      positions[o3 + 2] = z;

      const nl = Math.hypot(cp, sp, -drdz) || 1;
      normals[o3 + 0] = cp / nl;
      normals[o3 + 1] = sp / nl;
      normals[o3 + 2] = -drdz / nl;

      // Longitudinal grain streaks + darker nodes + a shaded underside.
      const streak = grain2(phi * 4.3 + t * 0.6, t * 26.0 + phi);
      const shade = 0.93 + streak * 0.11 - node * 0.20 - Math.max(0, -sp) * 0.14;
      const c = clamp01(shade);
      colors[o3 + 0] = c;
      colors[o3 + 1] = c * 0.975;
      colors[o3 + 2] = c * 0.925;

      uvs[v * 2 + 0] = j / RADIAL;
      uvs[v * 2 + 1] = t;
      v++;
    }
  }

  for (let i = 0; i < AXIAL; i++) {
    for (let j = 0; j < RADIAL; j++) {
      const a = i * (RADIAL + 1) + j;
      const b = a + RADIAL + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }

  // End caps — the poi is seen from above so the far cap does show.
  const cap = (z: number, r: number, dir: number): void => {
    const centre = v;
    const o3 = v * 3;
    positions[o3 + 0] = 0;
    positions[o3 + 1] = HANDLE_Y;
    positions[o3 + 2] = z;
    normals[o3 + 2] = dir;
    colors[o3 + 0] = 0.74;
    colors[o3 + 1] = 0.70;
    colors[o3 + 2] = 0.62;
    uvs[v * 2 + 0] = 0.5;
    uvs[v * 2 + 1] = 0.5;
    v++;

    const first = v;
    for (let j = 0; j <= RADIAL; j++) {
      const phi = (j / RADIAL) * TAU;
      const p3 = v * 3;
      positions[p3 + 0] = Math.cos(phi) * r;
      positions[p3 + 1] = HANDLE_Y + Math.sin(phi) * r;
      positions[p3 + 2] = z;
      normals[p3 + 2] = dir;
      const c = 0.70 + grain2(phi * 6, j) * 0.10;
      colors[p3 + 0] = c;
      colors[p3 + 1] = c * 0.96;
      colors[p3 + 2] = c * 0.90;
      uvs[v * 2 + 0] = (Math.cos(phi) + 1) * 0.5;
      uvs[v * 2 + 1] = (Math.sin(phi) + 1) * 0.5;
      v++;
    }
    for (let j = 0; j < RADIAL; j++) {
      if (dir > 0) indices.push(centre, first + j, first + j + 1);
      else indices.push(centre, first + j + 1, first + j);
    }
  };
  cap(HANDLE_END_Z, radiusAt(1), 1);
  cap(HANDLE_START_Z, radiusAt(0), -1);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.setIndex(indices);
  g.computeBoundingSphere();
  g.name = 'poi.handle';

  handleGeometry = g;
  return g;
}

/**
 * The little coloured cord tied around the grip (spec §46 — together with the
 * player marker this is the ONLY part that carries the player's accent colour).
 *
 * Three tight wraps around the shaft, then a loose loop that hangs under the
 * handle and comes back up, so it reads as a knotted 紐 even at stall distance.
 */
export function createPoiCordGeometry(): THREE.BufferGeometry {
  if (cordGeometry) return cordGeometry;

  const length = HANDLE_END_Z - HANDLE_START_Z;
  const wrapStart = HANDLE_START_Z + length * 0.60;
  const wrapEnd = HANDLE_START_Z + length * 0.70;
  const wrapRadius = POI.handleRadius * 1.12;

  const pts: THREE.Vector3[] = [];

  const TURNS = 3;
  const WRAP_STEPS = 54;
  for (let i = 0; i <= WRAP_STEPS; i++) {
    const t = i / WRAP_STEPS;
    const ang = t * TAU * TURNS - Math.PI * 0.5;
    const r = wrapRadius * lerp(1.06, 1.0, t);
    pts.push(
      new THREE.Vector3(
        Math.cos(ang) * r,
        HANDLE_Y + Math.sin(ang) * r,
        lerp(wrapStart, wrapEnd, t),
      ),
    );
  }

  // The free end: swings out sideways, hangs, and loops back to the knot.
  const LOOP_STEPS = 40;
  for (let i = 1; i <= LOOP_STEPS; i++) {
    const t = i / LOOP_STEPS;
    const swing = Math.sin(t * Math.PI);
    const ang = Math.PI * 0.5 + t * TAU;
    pts.push(
      new THREE.Vector3(
        Math.cos(ang) * (wrapRadius + swing * 0.055),
        HANDLE_Y - swing * 0.185 - t * 0.012,
        wrapEnd + swing * 0.075 + t * 0.028,
      ),
    );
  }

  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.4);
  const g = new THREE.TubeGeometry(curve, 190, 0.0075, 6, false);
  g.name = 'poi.cord';

  cordGeometry = g;
  return g;
}

/** Layout numbers 'PoiView' needs to hang the marker and spawn rim droplets. */
export const POI_LAYOUT = {
  frameRingRadius: FRAME_RING_RADIUS,
  frameHalfHeight: FRAME_HALF_HEIGHT,
  handleStartZ: HANDLE_START_Z,
  handleEndZ: HANDLE_END_Z,
  handleY: HANDLE_Y,
  /** Where the accent marker plate sits along the handle. */
  markerZ: HANDLE_START_Z + (HANDLE_END_Z - HANDLE_START_Z) * 0.32,
} as const;
