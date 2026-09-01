'use client';

/**
 * 水滴 — water clinging to a lifted poi and dripping back into the tank (spec §126).
 *
 * This is deliberately NOT the splash system. A splash is fast, bright and additive;
 * these are slow, heavy, individually readable droplets that hang on the paper for a
 * moment, detach, stretch as they fall, and vanish the instant they touch the surface.
 * They are what makes a successful scoop look wet rather than clean.
 *
 * They are drawn with normal blending and a faked refraction (dark body, bright rim,
 * one specular highlight), because an additive droplet reads as a spark, not as water.
 *
 * Pooled up front; 'spawn()' writes into typed arrays and never allocates or re-renders.
 */

import { useFrame } from '@react-three/fiber';
import { forwardRef, useEffect, useImperativeHandle, useMemo } from 'react';
import * as THREE from 'three';
import { TANK } from '@/game/core/constants';
import { clamp, createRng } from '@/game/core/math';

export interface DropletHandle {
  /**
   * Sheds 'count' droplets around (x, y, z). 'spread' is the horizontal radius they are
   * scattered over — pass the poi's paper radius, since that is where water actually
   * collects and lets go.
   */
  spawn(x: number, y: number, z: number, count: number, spread: number): void;
}

export interface DropletsProps {
  /** Pool size. 240 comfortably covers four poi being lifted at once. */
  capacity?: number;
}

/** Gentle: these are meant to be watchable, not to snap out of frame. */
const GRAVITY = 8.4;
const AIR_DRAG = 0.35;
/** Killed slightly above the water line so they never poke through the surface shader. */
const SURFACE_KILL = TANK.surfaceY + 0.02;

const VERT = /* glsl */ `
attribute vec3 aPos;
attribute vec4 aParam; // x = size, y = alpha, z = vertical stretch, w = tilt

varying vec2 vUv;
varying float vAlpha;

void main() {
  vec4 mv = modelViewMatrix * vec4(aPos, 1.0);

  // Screen-aligned, always upright: a falling droplet elongates along gravity, and
  // gravity is (near enough) screen-down for this camera.
  float s = aParam.x;
  float c = cos(aParam.w);
  float sn = sin(aParam.w);
  vec2 local = vec2(position.x * s, position.y * s * aParam.z);
  mv.xy += vec2(local.x * c - local.y * sn, local.x * sn + local.y * c);

  gl_Position = projectionMatrix * mv;
  vUv = uv;
  vAlpha = aParam.y;
}
`;

const FRAG = /* glsl */ `
varying vec2 vUv;
varying float vAlpha;

void main() {
  vec2 p = vUv * 2.0 - 1.0;

  // Teardrop: circular at the bottom, drawn to a point at the top.
  float taper = mix(1.0, 0.3, smoothstep(-0.2, 1.0, p.y));
  float d = length(vec2(p.x / max(taper, 0.06), p.y * 0.88));
  if (d > 1.0) discard;

  // Faked refraction. Real screen-space refraction belongs to the water surface shader;
  // at this size a rim, a dark body and one highlight are indistinguishable from it.
  float rim = smoothstep(0.52, 1.0, d);
  float highlight = pow(max(0.0, 1.0 - length(p - vec2(-0.32, 0.3)) * 2.1), 9.0);

  vec3 body = vec3(0.30, 0.44, 0.55);
  vec3 edge = vec3(0.72, 0.88, 1.0);
  vec3 c = mix(body, edge, rim) + highlight * 1.7;

  float a = (0.2 + rim * 0.62 + highlight * 0.8) * vAlpha;
  // Soften the silhouette so the droplet has no hard alpha edge.
  a *= smoothstep(1.0, 0.9, d);

  gl_FragColor = vec4(c, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

class DropletPool {
  readonly geometry: THREE.InstancedBufferGeometry;
  readonly material: THREE.ShaderMaterial;

  private readonly capacity: number;
  private readonly pos: Float32Array;
  private readonly param: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly lifeMax: Float32Array;
  private readonly cling: Float32Array;
  private readonly phase: Float32Array;
  private readonly baseSize: Float32Array;

  private readonly posAttr: THREE.InstancedBufferAttribute;
  private readonly paramAttr: THREE.InstancedBufferAttribute;

  private count = 0;
  private cursor = 0;
  private clock = 0;

  private readonly rng = createRng(0x2c1b3ea7);

  constructor(capacity: number) {
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.param = new Float32Array(capacity * 4);
    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.lifeMax = new Float32Array(capacity);
    this.cling = new Float32Array(capacity);
    this.phase = new Float32Array(capacity);
    this.baseSize = new Float32Array(capacity);

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3),
    );
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);

    this.posAttr = new THREE.InstancedBufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.paramAttr = new THREE.InstancedBufferAttribute(this.param, 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aPos', this.posAttr);
    geo.setAttribute('aParam', this.paramAttr);
    geo.instanceCount = 0;
    this.geometry = geo;

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
    });
  }

  get active(): number {
    return this.count;
  }

  spawn(x: number, y: number, z: number, count: number, spread: number): void {
    const rng = this.rng;
    const n = clamp(Math.round(count), 0, this.capacity);
    const radius = Math.max(0, spread);

    for (let k = 0; k < n; k++) {
      let i: number;
      if (this.count < this.capacity) {
        i = this.count++;
      } else {
        i = this.cursor;
        this.cursor = (this.cursor + 1) % this.capacity;
      }
      const p3 = i * 3;
      const p4 = i * 4;

      // Biased to the rim: water runs to the edge of the paper before it lets go.
      const r = radius * (0.45 + 0.55 * Math.sqrt(rng.next()));
      const a = rng.next() * Math.PI * 2;
      this.pos[p3] = x + Math.cos(a) * r;
      this.pos[p3 + 1] = y - rng.range(0, 0.05);
      this.pos[p3 + 2] = z + Math.sin(a) * r;

      // Barely moving at first — they are still held on by surface tension.
      this.vel[p3] = Math.cos(a) * rng.range(0, 0.25);
      this.vel[p3 + 1] = rng.range(-0.15, 0.05);
      this.vel[p3 + 2] = Math.sin(a) * rng.range(0, 0.25);

      const size = rng.range(0.05, 0.115);
      this.baseSize[i] = size;
      this.cling[i] = rng.range(0.08, 0.52);
      this.phase[i] = rng.next() * Math.PI * 2;
      const life = rng.range(1.1, 2.2);
      this.life[i] = life;
      this.lifeMax[i] = life;

      this.param[p4] = size;
      this.param[p4 + 1] = 0;
      this.param[p4 + 2] = 1;
      this.param[p4 + 3] = rng.range(-0.12, 0.12);
    }
  }

  clear(): void {
    this.count = 0;
    this.geometry.instanceCount = 0;
  }

  private kill(i: number): void {
    const last = --this.count;
    if (i === last) return;
    const a3 = i * 3;
    const b3 = last * 3;
    const a4 = i * 4;
    const b4 = last * 4;
    for (let k = 0; k < 3; k++) {
      this.pos[a3 + k] = this.pos[b3 + k];
      this.vel[a3 + k] = this.vel[b3 + k];
    }
    for (let k = 0; k < 4; k++) this.param[a4 + k] = this.param[b4 + k];
    this.life[i] = this.life[last];
    this.lifeMax[i] = this.lifeMax[last];
    this.cling[i] = this.cling[last];
    this.phase[i] = this.phase[last];
    this.baseSize[i] = this.baseSize[last];
  }

  update(dt: number): void {
    const step = clamp(dt, 0, 0.05);
    this.clock += step;

    for (let i = this.count - 1; i >= 0; i--) {
      const remaining = this.life[i] - step;
      if (remaining <= 0) {
        this.kill(i);
        continue;
      }
      this.life[i] = remaining;

      const p3 = i * 3;
      const p4 = i * 4;

      if (this.cling[i] > 0) {
        // Held by surface tension: it swells and trembles instead of falling.
        this.cling[i] -= step;
        const wobble = Math.sin(this.clock * 9 + this.phase[i]) * 0.004;
        this.pos[p3] += wobble;
        this.pos[p3 + 1] -= step * 0.09;
        this.param[p4] = this.baseSize[i] * (1 + (0.52 - this.cling[i]) * 0.5);
        this.param[p4 + 2] = 1.05;
      } else {
        const damping = Math.exp(-AIR_DRAG * step);
        const vx = this.vel[p3] * damping;
        const vy = this.vel[p3 + 1] * damping - GRAVITY * step;
        const vz = this.vel[p3 + 2] * damping;
        this.vel[p3] = vx;
        this.vel[p3 + 1] = vy;
        this.vel[p3 + 2] = vz;
        this.pos[p3] += vx * step;
        this.pos[p3 + 1] += vy * step;
        this.pos[p3 + 2] += vz * step;

        // The faster it falls the longer it draws out — a real droplet does the same.
        this.param[p4] = this.baseSize[i];
        this.param[p4 + 2] = clamp(1 + Math.abs(vy) * 0.24, 1, 3.4);
      }

      if (this.pos[p3 + 1] <= SURFACE_KILL) {
        this.kill(i);
        continue;
      }

      // Fade in over the first moments (so a spawn never pops) and out at the very end.
      const age = this.lifeMax[i] - remaining;
      const fadeIn = Math.min(1, age / 0.12);
      const fadeOut = Math.min(1, remaining / 0.25);
      this.param[p4 + 1] = fadeIn * fadeOut;
    }

    this.geometry.instanceCount = this.count;
    if (this.count > 0) {
      this.posAttr.needsUpdate = true;
      this.paramAttr.needsUpdate = true;
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

export const Droplets = forwardRef<DropletHandle, DropletsProps>(function Droplets(
  { capacity = 240 },
  ref,
) {
  const pool = useMemo(() => new DropletPool(Math.max(16, Math.round(capacity))), [capacity]);

  useEffect(() => () => pool.dispose(), [pool]);

  useImperativeHandle(
    ref,
    (): DropletHandle => ({
      spawn: (x, y, z, count, spread) => pool.spawn(x, y, z, count, spread),
    }),
    [pool],
  );

  useFrame((_state, delta) => {
    pool.update(delta);
  });

  return (
    <mesh geometry={pool.geometry} material={pool.material} frustumCulled={false} renderOrder={8} />
  );
});
