'use client';

/**
 * 水しぶき — the splash system for the big screen (spec §62, §126).
 *
 * Every visible splash in the tank comes from here: the poi breaking the surface, a
 * lift sheeting water off, a capture, a torn poi dumping its catch back, fish rolling
 * at the surface, and two poi knocking into each other.
 *
 * It is a fixed pool of instanced billboard droplets plus a pool of expanding surface
 * rings. Nothing is allocated after mount and nothing goes through React state — game
 * events call 'spawn()' on the imperative handle, which writes straight into the typed
 * arrays that back the instanced attributes.
 *
 * The droplets are simulated on the CPU (gravity, drag, lifetime) because their spawn
 * pattern is event-driven and irregular; the rings are pure parameter animation.
 */

import { useFrame } from '@react-three/fiber';
import { forwardRef, useEffect, useImperativeHandle, useMemo } from 'react';
import * as THREE from 'three';
import { DIAG } from '@/rendering/diagFlags';
import { TANK } from '@/game/core/constants';
import { clamp, createRng } from '@/game/core/math';

/** Screen-side splash flavours. Maps 1:1 onto the protocol's 'SplashKind'. */
export type SplashEffectKind = 'enter' | 'exit' | 'capture' | 'break' | 'fish' | 'collide';

export type ParticleQuality = 'low' | 'medium' | 'high';

export interface SplashHandle {
  /**
   * Throws one splash. 'strength' is 0..1 (values above 1 are clamped to 1.5 so a
   * violent event can still read bigger). The ring is always placed at the water line,
   * whatever height the droplets start from.
   */
  spawn(x: number, y: number, z: number, strength: number, kind: SplashEffectKind): void;
}

export interface SplashSystemProps {
  quality?: ParticleQuality;
}

interface PoolSizes {
  particles: number;
  rings: number;
  /** Multiplier on every spawn count. */
  density: number;
}

const QUALITY: Record<ParticleQuality, PoolSizes> = {
  high: { particles: 1200, rings: 32, density: 1 },
  medium: { particles: 640, rings: 20, density: 0.6 },
  low: { particles: 300, rings: 12, density: 0.34 },
};

interface RingSpec {
  radius0: number;
  radius1: number;
  life: number;
  width: number;
  intensity: number;
}

interface KindSpec {
  /** Droplet count at strength 1, before the quality density multiplier. */
  count: number;
  /** Launch speed range, world units / second. */
  speed: [number, number];
  /** Cone half-angles from straight up, radians. */
  cone: [number, number];
  size: [number, number];
  life: [number, number];
  /** Base droplet colour (linear-ish; the material brightens the core). */
  color: [number, number, number];
  /** Fraction of droplets that come out near-white — the bright spray in a splash. */
  bright: number;
  /** Velocity damping per second. */
  drag: number;
  gravityScale: number;
  /** Extra horizontal scatter applied to the spawn point. */
  jitter: number;
  ring: RingSpec;
  /** Optional second, wider and slower ring. */
  ring2?: RingSpec;
  /** Optional slab of slow, heavily stretched droplets that reads as a sheet of water. */
  sheet?: { count: number; size: [number, number]; life: [number, number]; speed: [number, number] };
}

const WATER = [0.62, 0.82, 0.95] as [number, number, number];
const WATER_DIM = [0.44, 0.58, 0.68] as [number, number, number];
const WATER_WARM = [0.88, 0.9, 0.86] as [number, number, number];

/**
 * Per-kind character. These numbers are the whole personality of the effect, so they
 * are tuned rather than derived: entering throws a crown, capture throws a bright
 * burst plus a sheet, a break is heavier and slower than anything else.
 */
const KINDS: Record<SplashEffectKind, KindSpec> = {
  enter: {
    // A crown: a ring of droplets thrown outward at a shallow angle, not a fountain.
    count: 34,
    speed: [2.3, 4.4],
    cone: [0.32, 0.82],
    size: [0.045, 0.1],
    life: [0.5, 0.95],
    color: WATER,
    bright: 0.35,
    drag: 0.9,
    gravityScale: 1,
    jitter: 0.16,
    ring: { radius0: 0.3, radius1: 1.15, life: 0.85, width: 0.14, intensity: 0.55 },
  },
  exit: {
    // Water sheeting off the paper: fewer, slower, much more stretched droplets.
    count: 22,
    speed: [1.1, 2.4],
    cone: [0.06, 0.42],
    size: [0.05, 0.11],
    life: [0.75, 1.3],
    color: WATER,
    bright: 0.2,
    drag: 0.55,
    gravityScale: 1,
    jitter: 0.22,
    ring: { radius0: 0.36, radius1: 0.95, life: 0.95, width: 0.11, intensity: 0.34 },
  },
  capture: {
    count: 56,
    speed: [2.6, 5.8],
    cone: [0.14, 1.05],
    size: [0.05, 0.13],
    life: [0.6, 1.15],
    color: WATER_WARM,
    bright: 0.4,
    drag: 0.85,
    gravityScale: 1,
    jitter: 0.18,
    ring: { radius0: 0.28, radius1: 1.25, life: 0.8, width: 0.16, intensity: 0.62 },
    ring2: { radius0: 0.45, radius1: 2.0, life: 1.4, width: 0.08, intensity: 0.22 },
    sheet: { count: 18, size: [0.11, 0.2], life: [0.28, 0.5], speed: [1.2, 2.6] },
  },
  break: {
    // Heavier and slower — a fat, sad collapse of water rather than a bright burst.
    count: 46,
    speed: [1.5, 3.1],
    cone: [0.4, 1.25],
    size: [0.08, 0.19],
    life: [0.85, 1.5],
    color: WATER_DIM,
    bright: 0.12,
    drag: 0.5,
    gravityScale: 1.15,
    jitter: 0.3,
    ring: { radius0: 0.42, radius1: 1.5, life: 1.3, width: 0.2, intensity: 0.48 },
    ring2: { radius0: 0.6, radius1: 2.3, life: 1.9, width: 0.1, intensity: 0.18 },
  },
  fish: {
    // A fish rolling at the surface: a flick, nothing more.
    count: 10,
    speed: [1.0, 2.3],
    cone: [0.2, 0.7],
    size: [0.03, 0.065],
    life: [0.32, 0.6],
    color: WATER,
    bright: 0.3,
    drag: 1.0,
    gravityScale: 1,
    jitter: 0.1,
    ring: { radius0: 0.12, radius1: 0.6, life: 0.6, width: 0.06, intensity: 0.3 },
  },
  collide: {
    // Two bamboo frames knocking: a low, wide, unspectacular spray (spec §49).
    count: 16,
    speed: [1.2, 2.7],
    cone: [0.55, 1.3],
    size: [0.04, 0.085],
    life: [0.35, 0.7],
    color: WATER,
    bright: 0.25,
    drag: 1.1,
    gravityScale: 1,
    jitter: 0.14,
    ring: { radius0: 0.2, radius1: 0.85, life: 0.65, width: 0.08, intensity: 0.33 },
  },
};

/*
 * Ring radii are deliberately modest. A poi is only 1.24 units across and the tank is
 * 15 wide: a ring that grows past ~1.5 units stops reading as "water displaced by a
 * scoop" and starts reading as a screen-wide flash that hides the fish everyone is
 * trying to target (spec §99 keeps the tank, not the UI, in the middle of the screen).
 */
/** Rings sit just proud of the water plane so wave crests do not eat them. */
const RING_Y = TANK.surfaceY + 0.035;
const GRAVITY = 11.5;

const DROPLET_VERT = /* glsl */ `
attribute vec3 aPos;
attribute vec3 aVel;
attribute vec4 aColor;
attribute vec3 aParam; // x = size, y = alpha, z = stretch

varying vec2 vUv;
varying vec4 vColor;

void main() {
  vec4 mv = modelViewMatrix * vec4(aPos, 1.0);

  // Billboard, but stretched along the screen-space velocity: a falling droplet is a
  // streak, and that streak is most of what sells the motion at 60fps.
  vec3 velView = (modelViewMatrix * vec4(aVel, 0.0)).xyz;
  vec2 dir = velView.xy;
  float m = length(dir);
  dir = m > 1e-4 ? dir / m : vec2(0.0, 1.0);
  vec2 perp = vec2(-dir.y, dir.x);

  float s = aParam.x;
  vec2 offset = dir * (position.y * s * aParam.z) + perp * (position.x * s);
  mv.xy += offset;

  gl_Position = projectionMatrix * mv;
  vUv = uv;
  vColor = vec4(aColor.rgb, aColor.a * aParam.y);
}
`;

const DROPLET_FRAG = /* glsl */ `
varying vec2 vUv;
varying vec4 vColor;

void main() {
  vec2 d = vUv * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;

  float core = 1.0 - r2;
  float a = core * core * vColor.a;
  // A bright rim: light bending through the outside of a droplet.
  float rim = smoothstep(0.42, 1.0, r2) * 0.5;
  vec3 c = vColor.rgb * (0.7 + core * 0.7) + rim;

  gl_FragColor = vec4(c, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const RING_VERT = /* glsl */ `
attribute vec4 aRing;        // xyz = centre, w = radius
attribute vec3 aRingParams;  // x = width, y = alpha, z = unused
attribute vec3 aRingColor;

varying float vSide;
varying vec3 vColor;
varying float vAlpha;

void main() {
  // position.x carries the angle, position.y the 0..1 side across the band.
  float angle = position.x;
  float side = position.y;
  float r = max(0.0, aRing.w + (side - 0.5) * aRingParams.x);
  vec3 p = aRing.xyz + vec3(cos(angle) * r, 0.0, sin(angle) * r);

  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  vSide = side;
  vColor = aRingColor;
  vAlpha = aRingParams.y;
}
`;

const RING_FRAG = /* glsl */ `
varying float vSide;
varying vec3 vColor;
varying float vAlpha;

const float PI = 3.141592653589793;

void main() {
  // Soft band, brighter on the inner edge where a real ripple crest catches the light.
  // max() is load-bearing (venue black-flash fix, 2026-08-26): at the outer edge
  // vSide interpolates to exactly 1.0 and sin(1.0 * PI) with a float32 PI is
  // MINUS 8.7e-8 - and pow of a negative base is undefined in GLSL, i.e. NaN
  // on Apple GPUs. The NaN sailed through the discard below (NaN compares
  // false), was additively blended into the half-float composer buffer, and
  // the bloom mip chain smeared that one texel into a huge black band for a
  // frame. Bisected with scripts/diag/wk-watch.mjs: rings on = black frames,
  // rings off = none.
  float band = max(sin(vSide * PI), 0.0);
  float a = pow(band, 1.6) * vAlpha;
  // NaN-robust guard: !(a >= x) also catches a non-finite alpha.
  if (!(a >= 0.002)) discard;
  vec3 c = vColor * (0.8 + (1.0 - vSide) * 0.6);

  gl_FragColor = vec4(c, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Builds a unit quad as an InstancedBufferGeometry, ready for per-instance attributes. */
function makeQuad(): THREE.InstancedBufferGeometry {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3),
  );
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  return geo;
}

/**
 * A flat annulus strip lying in XZ. 'position' carries (angle, side, 0) rather than a
 * real coordinate, so the vertex shader can rebuild the ring at any radius and width
 * without touching the geometry.
 */
function makeRingStrip(segments: number): THREE.InstancedBufferGeometry {
  const geo = new THREE.InstancedBufferGeometry();
  const verts = new Float32Array((segments + 1) * 2 * 3);
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const base = i * 6;
    verts[base] = angle;
    verts[base + 1] = 0; // inner
    verts[base + 2] = 0;
    verts[base + 3] = angle;
    verts[base + 4] = 1; // outer
    verts[base + 5] = 0;
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  const index: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  geo.setIndex(index);
  return geo;
}

/**
 * The pool. Deliberately a plain class rather than React state: 'spawn' is called from
 * socket callbacks and must never trigger a re-render.
 */
class SplashPool {
  readonly dropletGeometry: THREE.InstancedBufferGeometry;
  readonly dropletMaterial: THREE.ShaderMaterial;
  readonly ringGeometry: THREE.InstancedBufferGeometry;
  readonly ringMaterial: THREE.ShaderMaterial;

  private readonly capacity: number;
  private readonly ringCapacity: number;
  private readonly density: number;

  // Instanced attribute backing stores.
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly color: Float32Array;
  private readonly param: Float32Array;

  // CPU-only per-particle state.
  private readonly life: Float32Array;
  private readonly lifeMax: Float32Array;
  private readonly baseSize: Float32Array;
  private readonly baseStretch: Float32Array;
  private readonly drag: Float32Array;
  private readonly grav: Float32Array;

  private count = 0;
  private recycleCursor = 0;

  private readonly ring: Float32Array;
  private readonly ringParams: Float32Array;
  private readonly ringColor: Float32Array;
  private readonly ringLife: Float32Array;
  private readonly ringLifeMax: Float32Array;
  private readonly ringR0: Float32Array;
  private readonly ringR1: Float32Array;
  private readonly ringWidth: Float32Array;
  private readonly ringIntensity: Float32Array;
  private ringCount = 0;
  private ringCursor = 0;

  private readonly posAttr: THREE.InstancedBufferAttribute;
  private readonly velAttr: THREE.InstancedBufferAttribute;
  private readonly colorAttr: THREE.InstancedBufferAttribute;
  private readonly paramAttr: THREE.InstancedBufferAttribute;
  private readonly ringAttr: THREE.InstancedBufferAttribute;
  private readonly ringParamsAttr: THREE.InstancedBufferAttribute;
  private readonly ringColorAttr: THREE.InstancedBufferAttribute;

  private readonly rng = createRng(0x7f4a7c15);

  constructor(sizes: PoolSizes) {
    this.capacity = sizes.particles;
    this.ringCapacity = sizes.rings;
    this.density = sizes.density;

    const n = this.capacity;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.color = new Float32Array(n * 4);
    this.param = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.lifeMax = new Float32Array(n);
    this.baseSize = new Float32Array(n);
    this.baseStretch = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.grav = new Float32Array(n);

    this.dropletGeometry = makeQuad();
    this.posAttr = new THREE.InstancedBufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.velAttr = new THREE.InstancedBufferAttribute(this.vel, 3).setUsage(THREE.DynamicDrawUsage);
    this.colorAttr = new THREE.InstancedBufferAttribute(this.color, 4).setUsage(THREE.DynamicDrawUsage);
    this.paramAttr = new THREE.InstancedBufferAttribute(this.param, 3).setUsage(THREE.DynamicDrawUsage);
    this.dropletGeometry.setAttribute('aPos', this.posAttr);
    this.dropletGeometry.setAttribute('aVel', this.velAttr);
    this.dropletGeometry.setAttribute('aColor', this.colorAttr);
    this.dropletGeometry.setAttribute('aParam', this.paramAttr);
    this.dropletGeometry.instanceCount = 0;

    this.dropletMaterial = new THREE.ShaderMaterial({
      vertexShader: DROPLET_VERT,
      fragmentShader: DROPLET_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });

    const m = this.ringCapacity;
    this.ring = new Float32Array(m * 4);
    this.ringParams = new Float32Array(m * 3);
    this.ringColor = new Float32Array(m * 3);
    this.ringLife = new Float32Array(m);
    this.ringLifeMax = new Float32Array(m);
    this.ringR0 = new Float32Array(m);
    this.ringR1 = new Float32Array(m);
    this.ringWidth = new Float32Array(m);
    this.ringIntensity = new Float32Array(m);

    this.ringGeometry = makeRingStrip(72);
    this.ringAttr = new THREE.InstancedBufferAttribute(this.ring, 4).setUsage(THREE.DynamicDrawUsage);
    this.ringParamsAttr = new THREE.InstancedBufferAttribute(this.ringParams, 3).setUsage(
      THREE.DynamicDrawUsage,
    );
    this.ringColorAttr = new THREE.InstancedBufferAttribute(this.ringColor, 3).setUsage(
      THREE.DynamicDrawUsage,
    );
    this.ringGeometry.setAttribute('aRing', this.ringAttr);
    this.ringGeometry.setAttribute('aRingParams', this.ringParamsAttr);
    this.ringGeometry.setAttribute('aRingColor', this.ringColorAttr);
    this.ringGeometry.instanceCount = 0;

    this.ringMaterial = new THREE.ShaderMaterial({
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
  }

  get activeParticles(): number {
    return this.count;
  }

  get activeRings(): number {
    return this.ringCount;
  }

  spawn(x: number, y: number, z: number, strength: number, kind: SplashEffectKind): void {
        // A NaN here would ride the additive pipeline into the bloom mip chain
        // and black out the ENTIRE frame — sanitize at the door.
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
        strength = Number.isFinite(strength) ? Math.min(Math.max(strength, 0), 1.5) : 0.5;
    const spec = KINDS[kind] ?? KINDS.enter;
    const s = clamp(Number.isFinite(strength) ? strength : 0.5, 0, 1.5);
    // Even a feeble event should be visible; a strong one should be noticeably bigger.
    const scale = 0.4 + 0.75 * s;

    if (!DIAG.noSpray) {
      const n = Math.max(1, Math.round(spec.count * scale * this.density));
      for (let i = 0; i < n; i++) this.emitDroplet(spec, x, y, z, scale, false);

      if (spec.sheet) {
        const sn = Math.max(1, Math.round(spec.sheet.count * scale * this.density));
        for (let i = 0; i < sn; i++) this.emitDroplet(spec, x, y, z, scale, true);
      }
    }

    if (!DIAG.noRings) {
      this.emitRing(spec.ring, x, z, scale, spec.color);
      if (spec.ring2) this.emitRing(spec.ring2, x, z, scale, spec.color);
    }
  }

  /** Kills everything instantly — used when the round resets. */
  clear(): void {
    this.count = 0;
    this.ringCount = 0;
    this.dropletGeometry.instanceCount = 0;
    this.ringGeometry.instanceCount = 0;
  }

  private allocate(): number {
    if (this.count < this.capacity) return this.count++;
    // Pool exhausted: overwrite in rotation rather than dropping the splash entirely.
    const i = this.recycleCursor % this.capacity;
    this.recycleCursor = (this.recycleCursor + 1) % this.capacity;
    return i;
  }

  private emitDroplet(
    spec: KindSpec,
    x: number,
    y: number,
    z: number,
    scale: number,
    sheet: boolean,
  ): void {
    const rng = this.rng;
    const i = this.allocate();
    const p3 = i * 3;
    const c4 = i * 4;

    const azimuth = rng.next() * Math.PI * 2;
    // sqrt biases samples toward the wide end of the cone, which is what a real crown does.
    const polar = spec.cone[0] + (spec.cone[1] - spec.cone[0]) * Math.sqrt(rng.next());
    const sinP = Math.sin(polar);

    const speedRange = sheet && spec.sheet ? spec.sheet.speed : spec.speed;
    const speed = rng.range(speedRange[0], speedRange[1]) * (0.7 + 0.4 * scale);

    this.pos[p3] = x + Math.cos(azimuth) * rng.range(0, spec.jitter);
    this.pos[p3 + 1] = y + rng.range(-0.03, 0.06);
    this.pos[p3 + 2] = z + Math.sin(azimuth) * rng.range(0, spec.jitter);

    this.vel[p3] = Math.cos(azimuth) * sinP * speed;
    this.vel[p3 + 1] = Math.cos(polar) * speed;
    this.vel[p3 + 2] = Math.sin(azimuth) * sinP * speed;

    const isBright = rng.next() < spec.bright;
    const tint = rng.range(0.85, 1.15);
    this.color[c4] = (isBright ? 1.0 : spec.color[0]) * tint;
    this.color[c4 + 1] = (isBright ? 1.0 : spec.color[1]) * tint;
    this.color[c4 + 2] = (isBright ? 1.0 : spec.color[2]) * tint;
    this.color[c4 + 3] = sheet ? 0.55 : 1;

    const sizeRange = sheet && spec.sheet ? spec.sheet.size : spec.size;
    const size = rng.range(sizeRange[0], sizeRange[1]);
    const lifeRange = sheet && spec.sheet ? spec.sheet.life : spec.life;
    const life = rng.range(lifeRange[0], lifeRange[1]);

    this.baseSize[i] = size;
    // A sheet of water is one wide, flat smear rather than a scatter of beads.
    this.baseStretch[i] = sheet ? 3.2 : 1;
    this.life[i] = life;
    this.lifeMax[i] = life;
    this.drag[i] = sheet ? spec.drag * 2.2 : spec.drag;
    this.grav[i] = sheet ? spec.gravityScale * 0.35 : spec.gravityScale;

    this.param[p3] = size;
    this.param[p3 + 1] = 1;
    this.param[p3 + 2] = this.baseStretch[i];
  }

  private emitRing(
    spec: RingSpec,
    x: number,
    z: number,
    scale: number,
    color: readonly [number, number, number],
  ): void {
    let i: number;
    if (this.ringCount < this.ringCapacity) {
      i = this.ringCount++;
    } else {
      // More concurrent ripples than the pool holds: retire the oldest slot in rotation.
      i = this.ringCursor;
      this.ringCursor = (this.ringCursor + 1) % this.ringCapacity;
    }
    const r4 = i * 4;
    const p3 = i * 3;

    this.ring[r4] = x;
    this.ring[r4 + 1] = RING_Y;
    this.ring[r4 + 2] = z;
    this.ring[r4 + 3] = spec.radius0;

    this.ringR0[i] = spec.radius0;
    this.ringR1[i] = spec.radius1 * (0.6 + 0.55 * scale);
    this.ringWidth[i] = spec.width;
    this.ringIntensity[i] = spec.intensity * (0.55 + 0.6 * scale);
    this.ringLife[i] = spec.life;
    this.ringLifeMax[i] = spec.life;

    this.ringParams[p3] = spec.width;
    this.ringParams[p3 + 1] = this.ringIntensity[i];
    this.ringParams[p3 + 2] = 0;

    this.ringColor[p3] = color[0];
    this.ringColor[p3 + 1] = color[1];
    this.ringColor[p3 + 2] = color[2];
  }

  /** Swap-removes particle 'i', keeping the live range packed at the front. */
  private kill(i: number): void {
    const last = --this.count;
    if (i !== last) {
      const a3 = i * 3;
      const b3 = last * 3;
      const a4 = i * 4;
      const b4 = last * 4;
      for (let k = 0; k < 3; k++) {
        this.pos[a3 + k] = this.pos[b3 + k];
        this.vel[a3 + k] = this.vel[b3 + k];
        this.param[a3 + k] = this.param[b3 + k];
      }
      for (let k = 0; k < 4; k++) this.color[a4 + k] = this.color[b4 + k];
      this.life[i] = this.life[last];
      this.lifeMax[i] = this.lifeMax[last];
      this.baseSize[i] = this.baseSize[last];
      this.baseStretch[i] = this.baseStretch[last];
      this.drag[i] = this.drag[last];
      this.grav[i] = this.grav[last];
    }
  }

  private killRing(i: number): void {
    const last = --this.ringCount;
    if (i !== last) {
      const a4 = i * 4;
      const b4 = last * 4;
      const a3 = i * 3;
      const b3 = last * 3;
      for (let k = 0; k < 4; k++) this.ring[a4 + k] = this.ring[b4 + k];
      for (let k = 0; k < 3; k++) {
        this.ringParams[a3 + k] = this.ringParams[b3 + k];
        this.ringColor[a3 + k] = this.ringColor[b3 + k];
      }
      this.ringLife[i] = this.ringLife[last];
      this.ringLifeMax[i] = this.ringLifeMax[last];
      this.ringR0[i] = this.ringR0[last];
      this.ringR1[i] = this.ringR1[last];
      this.ringWidth[i] = this.ringWidth[last];
      this.ringIntensity[i] = this.ringIntensity[last];
    }
  }

  update(dt: number): void {
    const step = clamp(dt, 0, 0.05); // a tab-switch stall must not teleport the spray

    for (let i = this.count - 1; i >= 0; i--) {
      const remaining = this.life[i] - step;
      if (remaining <= 0) {
        this.kill(i);
        continue;
      }
      this.life[i] = remaining;

      const p3 = i * 3;
      const damping = Math.exp(-this.drag[i] * step);
      const vx = this.vel[p3] * damping;
      const vy = this.vel[p3 + 1] * damping - GRAVITY * this.grav[i] * step;
      const vz = this.vel[p3 + 2] * damping;

      const px = this.pos[p3] + vx * step;
      const py = this.pos[p3 + 1] + vy * step;
      const pz = this.pos[p3 + 2] + vz * step;

      // Absorbed by the water on the way down, or thrown clean out of the tank.
      if (
        (py <= TANK.surfaceY && vy < 0) ||
        px < -TANK.halfWidth ||
        px > TANK.halfWidth ||
        pz < -TANK.halfDepth ||
        pz > TANK.halfDepth
      ) {
        this.kill(i);
        continue;
      }

      this.pos[p3] = px;
      this.pos[p3 + 1] = py;
      this.pos[p3 + 2] = pz;
      this.vel[p3] = vx;
      this.vel[p3 + 1] = vy;
      this.vel[p3 + 2] = vz;

      const u = remaining / this.lifeMax[i];
      // Hold full brightness for most of the life, then fade fast: a droplet does not
      // dim gradually, it simply stops catching the light.
      const alpha = u > 0.65 ? 1 : (u / 0.65) * (u / 0.65);
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      this.param[p3] = this.baseSize[i] * (0.8 + 0.2 * u);
      this.param[p3 + 1] = alpha;
      // Fast droplets smear; the authored stretch is the floor, never the ceiling.
      this.param[p3 + 2] = Math.max(this.baseStretch[i], 1 + speed * 0.16);
    }

    for (let i = this.ringCount - 1; i >= 0; i--) {
      const remaining = this.ringLife[i] - step;
      if (remaining <= 0) {
        this.killRing(i);
        continue;
      }
      this.ringLife[i] = remaining;

      const u = 1 - remaining / this.ringLifeMax[i]; // 0 -> 1 over the ring's life
      // Ease-out expansion: a surface ripple decelerates as it spreads.
      const e = 1 - (1 - u) * (1 - u);
      const r = this.ringR0[i] + (this.ringR1[i] - this.ringR0[i]) * e;
      this.ring[i * 4 + 3] = r;

      const p3 = i * 3;
      this.ringParams[p3] = this.ringWidth[i] * (1 + e * 1.6); // the crest softens as it goes
      this.ringParams[p3 + 1] = this.ringIntensity[i] * (1 - u) * (1 - u);
    }

    this.dropletGeometry.instanceCount = this.count;
    this.ringGeometry.instanceCount = this.ringCount;

    if (this.count > 0) {
      this.posAttr.needsUpdate = true;
      this.velAttr.needsUpdate = true;
      this.colorAttr.needsUpdate = true;
      this.paramAttr.needsUpdate = true;
    }
    if (this.ringCount > 0) {
      this.ringAttr.needsUpdate = true;
      this.ringParamsAttr.needsUpdate = true;
      this.ringColorAttr.needsUpdate = true;
    }
  }

  dispose(): void {
    this.dropletGeometry.dispose();
    this.dropletMaterial.dispose();
    this.ringGeometry.dispose();
    this.ringMaterial.dispose();
  }
}

export const SplashSystem = forwardRef<SplashHandle, SplashSystemProps>(function SplashSystem(
  { quality = 'high' },
  ref,
) {
  const sizes = QUALITY[quality] ?? QUALITY.high;
  const pool = useMemo(() => new SplashPool(sizes), [sizes]);

  useEffect(() => () => pool.dispose(), [pool]);

  useImperativeHandle(
    ref,
    (): SplashHandle => ({
      spawn: (x, y, z, strength, kind) => pool.spawn(x, y, z, strength, kind),
    }),
    [pool],
  );

  useFrame((_state, delta) => {
    pool.update(delta);
  });

  return (
    <group>
      {/* Rings render before droplets so bright spray always sits on top of the ripple. */}
      <mesh
        geometry={pool.ringGeometry}
        material={pool.ringMaterial}
        frustumCulled={false}
        renderOrder={6}
      />
      <mesh
        geometry={pool.dropletGeometry}
        material={pool.dropletMaterial}
        frustumCulled={false}
        renderOrder={7}
      />
    </group>
  );
});
