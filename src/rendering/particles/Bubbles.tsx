'use client';

/**
 * 泡 — the continuous stream of small bubbles rising off the tank floor (spec §59).
 *
 * This is ambient, not event-driven: it runs for the whole show and must cost as close
 * to nothing as possible. So the entire animation lives in the vertex shader — each
 * bubble carries a seed (origin, rise rate, phase) and derives its height, spiral and
 * pop from one 'uTime' uniform. The only per-frame CPU work is writing that float.
 *
 * Bubbles rise from a handful of vents in the gravel rather than uniformly, wobble on
 * the way up, swell as the pressure drops, and burst at the surface.
 */

import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { TANK } from '@/game/core/constants';
import { createRng } from '@/game/core/math';

export interface BubblesProps {
  /** Number of bubbles alive at any moment. 180 reads as lively without becoming soup. */
  count?: number;
  /** Number of vents in the gravel the bubbles rise from. */
  vents?: number;
  /** Overall opacity, for turning the layer down on a bright projector. */
  opacity?: number;
}

const VERT = /* glsl */ `
uniform float uTime;
uniform float uFloorY;
uniform float uRise;

attribute vec4 aSeed;  // x, z origin | rise rate (cycles/sec) | phase
attribute vec3 aShape; // size | wobble amplitude | wobble frequency

varying vec2 vUv;
varying float vAlpha;

void main() {
  float t = uTime * aSeed.z + aSeed.w;
  float cycle = fract(t);

  float y = uFloorY + cycle * uRise;
  // Two unrelated frequencies per axis: a bubble spirals, it does not swing on a plane.
  float x = aSeed.x + sin(t * aShape.z * 6.2831 + aSeed.w) * aShape.y;
  float z = aSeed.y + cos(t * aShape.z * 5.117 + aSeed.w * 1.7) * aShape.y;

  // Expanding as the water pressure drops, then bursting in the last few percent.
  float pop = smoothstep(0.93, 1.0, cycle);
  float size = aShape.x * (0.78 + cycle * 0.34) * (1.0 + pop * 2.0);
  vAlpha = smoothstep(0.0, 0.07, cycle) * (1.0 - pop);

  vec4 mv = modelViewMatrix * vec4(x, y, z, 1.0);
  mv.xy += position.xy * size;
  gl_Position = projectionMatrix * mv;
  vUv = uv;
}
`;

const FRAG = /* glsl */ `
uniform float uOpacity;

varying vec2 vUv;
varying float vAlpha;

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;

  // A bubble is a shell: almost nothing in the middle, a bright ring of refracted
  // light at the edge, and one specular dot where the stall lights catch it.
  float shell = smoothstep(0.58, 0.95, r) * (1.0 - smoothstep(0.95, 1.0, r));
  float highlight = pow(max(0.0, 1.0 - length(p - vec2(-0.3, 0.32)) * 2.6), 8.0);

  vec3 c = vec3(0.66, 0.84, 0.96) * shell + highlight * 1.25;
  float a = (shell * 0.8 + highlight * 0.6 + (1.0 - r) * 0.05) * vAlpha * uOpacity;
  if (a < 0.003) discard;

  gl_FragColor = vec4(c, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

interface BubbleField {
  geometry: THREE.InstancedBufferGeometry;
  material: THREE.ShaderMaterial;
}

function createField(count: number, vents: number, opacity: number): BubbleField {
  const rng = createRng(0x3d9f7b11);

  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3),
  );
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);

  // Vents: a few fixed spots in the gravel, spread across the floor.
  const ventX = new Float32Array(vents);
  const ventZ = new Float32Array(vents);
  for (let v = 0; v < vents; v++) {
    ventX[v] = rng.range(-TANK.halfWidth + 0.9, TANK.halfWidth - 0.9);
    ventZ[v] = rng.range(-TANK.halfDepth + 0.7, TANK.halfDepth - 0.7);
  }

  const seed = new Float32Array(count * 4);
  const shape = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const v = i % vents;
    const s4 = i * 4;
    const s3 = i * 3;
    // Cluster around the vent, but not exactly on it — gravel leaks unevenly.
    seed[s4] = ventX[v] + rng.range(-0.22, 0.22);
    seed[s4 + 1] = ventZ[v] + rng.range(-0.22, 0.22);
    // Rise rate in cycles/second: floor to surface in roughly 3.5–8 s.
    seed[s4 + 2] = 1 / rng.range(3.5, 8.0);
    seed[s4 + 3] = rng.next() * 1000; // phase, so the stream is never in lockstep

    shape[s3] = rng.range(0.018, 0.055);
    shape[s3 + 1] = rng.range(0.03, 0.14);
    shape[s3 + 2] = rng.range(0.35, 1.15);
  }

  geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));
  geometry.setAttribute('aShape', new THREE.InstancedBufferAttribute(shape, 3));
  geometry.instanceCount = count;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uFloorY: { value: TANK.floorY + 0.04 },
      // Stop just short of the surface: the burst should read as happening at the film.
      uRise: { value: TANK.waterDepth - 0.1 },
      uOpacity: { value: opacity },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
  });

  return { geometry, material };
}

export function Bubbles({ count = 180, vents = 14, opacity = 1 }: BubblesProps) {
  const safeCount = Math.max(1, Math.round(count));
  const safeVents = Math.max(1, Math.min(Math.round(vents), safeCount));

  // Opacity is intentionally NOT a dependency: it is a uniform, and rebuilding the whole
  // field would restart every bubble mid-rise.
  const field = useMemo(() => createField(safeCount, safeVents, opacity), [safeCount, safeVents]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    field.material.uniforms.uOpacity.value = opacity;
  }, [field, opacity]);

  useEffect(
    () => () => {
      field.geometry.dispose();
      field.material.dispose();
    },
    [field],
  );

  useFrame((state) => {
    // The entire simulation is this one float.
    field.material.uniforms.uTime.value = state.clock.elapsedTime;
  });

  return (
    <mesh
      geometry={field.geometry}
      material={field.material}
      frustumCulled={false}
      renderOrder={4}
    />
  );
}
