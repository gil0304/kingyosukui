'use client';

/**
 * The submerged environment (spec §59, §64).
 *
 * Everything below the water line that is not a fish or a poi: a displaced gravel bed,
 * a scattering of smooth river stones, clumps of water plants that sway, and a slow
 * stream of rising bubbles. All procedural — nothing is loaded from 'public/'.
 *
 * Four draw calls total (floor, instanced stones, one merged plant mesh, one point
 * cloud of bubbles), and every material shares one underwater light rig so the whole
 * bed reads as a single lit space: warm stall light from above, filtered through the
 * water column until only blue-green survives at depth.
 */

import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';

import { TANK } from '@/game/core/constants';
import { createRng, noise1 } from '@/game/core/math';

const FLOOR_SEED = 20240824;
const STONE_COUNT = 11;
const PLANT_CLUMPS = 7;
const BLADES_PER_CLUMP = 9;
const BLADE_SEGMENTS = 9;
const BUBBLE_COUNT = 170;

/** The floor plane overshoots the water volume so the tank walls never show a gap. */
const FLOOR_MARGIN = 0.7;

/* ------------------------------------------------------------------------------ */
/* Shared GLSL                                                                      */
/* ------------------------------------------------------------------------------ */

const NOISE_GLSL = /* glsl */ `
float hash12(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

vec2 hash22(vec2 p) {
  vec2 q = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(q) * 43758.5453123);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
`;

/**
 * Spec §64. 'uAbsorption' reuses the water shader's extinction so a stone halfway down
 * is lit by exactly the light the surface shader says gets that far.
 */
const UNDERWATER_LIGHT_GLSL = /* glsl */ `
uniform float uTime;
uniform vec3 uKeyColor;
uniform vec3 uFillColor;
uniform vec3 uGroundColor;
uniform vec3 uFogColor;
uniform float uKeyIntensity;
uniform float uAbsorption;
uniform float uFogDensity;

/**
 * A cheap moving-light shimmer, so that the surfaces the projected caustic plane cannot
 * reach — the stones, the plant blades — still sit under light that MOVES. The crisp,
 * ripple-driven caustic network on the gravel itself comes from Caustics.tsx.
 */
float causticShimmer(vec3 worldPos) {
  vec2 p = worldPos.xz * 1.7;
  float a = valueNoise(p + vec2(uTime * 0.13, -uTime * 0.09));
  float b = valueNoise(p * 2.1 + vec2(-uTime * 0.21, uTime * 0.17));
  return pow(clamp(a * b * 2.6, 0.0, 1.0), 2.2);
}

vec3 underwaterLight(vec3 n, vec3 worldPos, vec3 albedo) {
  vec3 keyDir = normalize(vec3(0.18, 0.94, 0.28));
  float raw = dot(n, keyDir);
  // Wrapped diffuse: underwater light is heavily scattered, so a surface turned away
  // from the lantern is dimmed, never black.
  float ndl = max(raw, 0.0) * 0.72 + (raw * 0.5 + 0.5) * 0.28;

  float depth = max(-worldPos.y, 0.0);
  vec3 sigma = vec3(0.72, 0.30, 0.22) * uAbsorption;
  vec3 through = exp(-sigma * depth);

  // Only up-facing surfaces catch the focused light coming down through the surface.
  float shimmer = causticShimmer(worldPos) * max(n.y, 0.0);

  vec3 key = uKeyColor * ndl * uKeyIntensity * through * (0.78 + 0.85 * shimmer);
  vec3 fill = mix(uGroundColor, uFillColor, n.y * 0.5 + 0.5);
  return albedo * (key + fill);
}

/** Horizontal attenuation — the far end of a 15-unit tank is genuinely murkier. */
vec3 underwaterFog(vec3 color, vec3 worldPos) {
  float dist = length(cameraPosition - worldPos);
  float f = 1.0 - exp(-dist * uFogDensity);
  return mix(color, uFogColor, clamp(f * 0.6, 0.0, 1.0));
}
`;

/* ------------------------------------------------------------------------------ */
/* Gravel floor                                                                     */
/* ------------------------------------------------------------------------------ */

const FLOOR_VERT = /* glsl */ `
precision highp float;

varying vec3 vWorldPos;
varying vec3 vNormal;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldPos = world.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const FLOOR_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uSandLight;
uniform vec3 uSandDark;
uniform vec3 uSandPale;
uniform float uPebbleScale;

varying vec3 vWorldPos;
varying vec3 vNormal;

${NOISE_GLSL}
${UNDERWATER_LIGHT_GLSL}

/**
 * One layer of pebbles. Returns the pebble colour and, through the out params, the
 * direction its rounded top tilts — that is what makes the bed read as loose stones
 * rather than as a flat photograph of stones.
 */
vec3 pebbles(vec2 p, out vec2 slope, out float dome) {
  vec2 cell = floor(p);
  vec2 f = fract(p);

  float bestSq = 8.0;
  vec2 bestId = vec2(0.0);
  vec2 bestOffset = vec2(0.0);

  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = hash22(cell + g);
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < bestSq) {
        bestSq = d;
        bestId = cell + g;
        bestOffset = r;
      }
    }
  }

  float rnd = hash12(bestId + 0.37);
  vec3 tint = mix(uSandDark, uSandLight, rnd);
  // A few pale quartz pebbles catch the light and break up the field.
  tint = mix(tint, uSandPale, step(0.88, hash12(bestId + 4.11)));

  dome = clamp(1.0 - sqrt(bestSq) * 1.45, 0.0, 1.0);
  slope = -bestOffset;
  return tint;
}

void main() {
  vec2 p = vWorldPos.xz * uPebbleScale;

  vec2 slopeA;
  float domeA;
  vec3 colorA = pebbles(p, slopeA, domeA);

  vec2 slopeB;
  float domeB;
  // A finer second layer fills the gaps between the big pebbles with grit.
  vec3 colorB = pebbles(p * 2.9 + vec2(13.7, 5.3), slopeB, domeB);

  vec3 albedo = mix(colorB, colorA, 0.62);
  albedo *= 0.74 + 0.46 * mix(domeB, domeA, 0.62);
  // Fine grain so the pebble cells never show their lattice.
  albedo *= 0.90 + 0.20 * valueNoise(vWorldPos.xz * 34.0);

  vec3 n = normalize(vNormal);
  n = normalize(vec3(
    n.x + (slopeA.x * domeA * 0.55 + slopeB.x * domeB * 0.30),
    n.y,
    n.z + (slopeA.y * domeA * 0.55 + slopeB.y * domeB * 0.30)
  ));

  vec3 color = underwaterLight(n, vWorldPos, albedo);
  color = underwaterFog(color, vWorldPos);

  gl_FragColor = vec4(color, 1.0);

  #include <colorspace_fragment>
}
`;

/* ------------------------------------------------------------------------------ */
/* River stones                                                                     */
/* ------------------------------------------------------------------------------ */

const STONE_VERT = /* glsl */ `
precision highp float;

attribute float aTint;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vTint;

void main() {
#ifdef USE_INSTANCING
  mat4 model = modelMatrix * instanceMatrix;
#else
  mat4 model = modelMatrix;
#endif
  vec4 world = model * vec4(position, 1.0);
  vWorldPos = world.xyz;
  vNormal = normalize(mat3(model) * normal);
  vTint = aTint;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const STONE_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uStoneLight;
uniform vec3 uStoneDark;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vTint;

${NOISE_GLSL}
${UNDERWATER_LIGHT_GLSL}

void main() {
  vec3 n = normalize(vNormal);
  vec3 albedo = mix(uStoneDark, uStoneLight, vTint);
  // Mottling in object-ish space; stones are static so world space is stable enough.
  albedo *= 0.86 + 0.28 * valueNoise(vWorldPos.xz * 9.0 + vWorldPos.y * 3.0);

  vec3 color = underwaterLight(n, vWorldPos, albedo);
  // Wet stone keeps a broad sheen where it faces up toward the surface.
  color += vec3(0.32, 0.44, 0.44) * pow(max(n.y, 0.0), 5.0) * 0.16;
  color = underwaterFog(color, vWorldPos);

  gl_FragColor = vec4(color, 1.0);

  #include <colorspace_fragment>
}
`;

/* ------------------------------------------------------------------------------ */
/* Water plants                                                                     */
/* ------------------------------------------------------------------------------ */

const PLANT_VERT = /* glsl */ `
precision highp float;

/** x = height along the blade 0..1, y = sway phase, z = stiffness. */
attribute vec3 aParam;
attribute float aTint;

uniform float uTime;
uniform float uSway;
uniform float uSwaySpeed;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vHeight;
varying float vTint;

void main() {
  float t = aParam.x;
  float phase = aParam.y;
  float stiffness = aParam.z;

  // Roots are anchored; the amplitude grows with the square of the height so the blade
  // bends as a whole instead of pivoting at a hinge.
  float amp = t * t * uSway * stiffness;
  float s = uTime * uSwaySpeed;

  vec3 pos = position;
  // Two out-of-phase axes so the clump breathes rather than waving as one flag.
  pos.x += sin(s + phase + t * 2.4) * amp;
  pos.z += cos(s * 0.83 + phase * 1.7 + t * 1.9) * amp * 0.7;
  pos.y -= amp * amp * 0.35;

  vec4 world = modelMatrix * vec4(pos, 1.0);
  vWorldPos = world.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vHeight = t;
  vTint = aTint;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const PLANT_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uPlantBase;
uniform vec3 uPlantTip;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vHeight;
varying float vTint;

${NOISE_GLSL}
${UNDERWATER_LIGHT_GLSL}

void main() {
  // Ribbons are double sided; flip the normal so the back face is lit, not black.
  vec3 n = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);

  vec3 albedo = mix(uPlantBase, uPlantTip, vHeight * 0.85 + vTint * 0.15);
  // A pale midrib down each blade.
  albedo *= 0.90 + 0.18 * valueNoise(vec2(vTint * 40.0, vHeight * 7.0));

  vec3 color = underwaterLight(n, vWorldPos, albedo);
  // Thin leaves transmit: the tips glow when the light is behind them.
  color += uPlantTip * pow(vHeight, 2.0) * 0.16;
  color = underwaterFog(color, vWorldPos);

  gl_FragColor = vec4(color, 1.0);

  #include <colorspace_fragment>
}
`;

/* ------------------------------------------------------------------------------ */
/* Bubbles                                                                          */
/* ------------------------------------------------------------------------------ */

const BUBBLE_VERT = /* glsl */ `
precision highp float;

/** x = phase 0..1, y = rise speed, z = WORLD diameter (not pixels). */
attribute vec3 aBubble;

uniform float uTime;
uniform float uBottom;
uniform float uTop;
uniform float uPixelScale;

varying float vFade;

void main() {
  float rise = fract(aBubble.x + uTime * aBubble.y);

  vec3 pos = position;
  pos.y = mix(uBottom, uTop, rise);
  // Bubbles wobble as they shed vortices; the wobble widens as they rise.
  float wobble = 0.02 + rise * 0.05;
  pos.x += sin(uTime * 1.7 + aBubble.x * 41.0) * wobble;
  pos.z += cos(uTime * 1.31 + aBubble.x * 27.0) * wobble;

  vec4 world = modelMatrix * vec4(pos, 1.0);
  vec4 mv = viewMatrix * world;

  // Fade in off the gravel and pop out just under the surface.
  vFade = smoothstep(0.0, 0.07, rise) * (1.0 - smoothstep(0.88, 1.0, rise));
  // Bubbles grow slightly as the pressure drops on the way up.
  float size = aBubble.z * (0.75 + rise * 0.45);

  gl_PointSize = max(size * uPixelScale / max(-mv.z, 0.001), 1.0);
  gl_Position = projectionMatrix * mv;
}
`;

const BUBBLE_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uBubbleColor;

varying float vFade;

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c) * 2.0;
  if (r > 1.0) discard;

  // A bubble is a shell, not a disc: bright rim, near-empty middle, one specular dot.
  float rim = smoothstep(0.52, 1.0, r) * (1.0 - smoothstep(0.94, 1.0, r));
  float spec = smoothstep(0.42, 0.0, length(c - vec2(-0.15, -0.15)) * 2.3);

  float alpha = clamp(rim * 0.85 + spec * 0.9 + 0.05, 0.0, 1.0) * vFade;
  vec3 color = uBubbleColor * (0.35 + rim * 0.8) + vec3(1.0) * spec * 0.5;

  gl_FragColor = vec4(color, alpha);

  #include <colorspace_fragment>
}
`;

/* ------------------------------------------------------------------------------ */
/* Procedural geometry                                                              */
/* ------------------------------------------------------------------------------ */

/**
 * Gentle dunes in the gravel bed, relative to TANK.floorY. Deterministic, so the layout
 * is identical every run.
 *
 * Exported because Caustics.tsx has to lay its projection plane on exactly this surface:
 * a flat caustics plane would be buried inside the higher dunes and show cut-out holes.
 */
export function tankFloorHeight(x: number, z: number): number {
  return (
    0.075 * noise1(x * 0.42 + 3.1) * noise1(z * 0.55 + 11.7) +
    0.036 * noise1(x * 1.15 + 21.3) * noise1(z * 1.35 + 5.9) +
    0.014 * noise1(x * 2.9 + 41.2) * noise1(z * 3.1 + 17.4)
  );
}

function createFloorGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(
    TANK.width + FLOOR_MARGIN,
    TANK.depth + FLOOR_MARGIN,
    120,
    72,
  );
  geometry.rotateX(-Math.PI / 2);

  const position = geometry.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const z = position.getZ(i);
    position.setY(i, tankFloorHeight(x, z));
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/** A rounded, water-worn pebble: a subdivided icosahedron dented and squashed flat. */
function createStoneGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.IcosahedronGeometry(0.5, 2);
  const position = geometry.attributes.position as THREE.BufferAttribute;

  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    // Low-frequency dents only — a river stone has no sharp features left.
    const dent =
      1 +
      0.17 * noise1(x * 2.6 + y * 1.7 + 4.2) +
      0.09 * noise1(z * 3.4 - x * 2.1 + 19.6);
    // Flattened: stones settle on their broad face.
    position.setXYZ(i, x * dent, y * dent * 0.58, z * dent);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * All the water-plant blades merged into one geometry: bent ribbon strips whose sway is
 * driven entirely by the vertex shader from 'aParam'. One draw call for every clump.
 */
function createPlantGeometry(): THREE.BufferGeometry {
  const rng = createRng(FLOOR_SEED + 77);
  const bladeCount = PLANT_CLUMPS * BLADES_PER_CLUMP;
  const vertsPerBlade = (BLADE_SEGMENTS + 1) * 2;
  const totalVerts = bladeCount * vertsPerBlade;
  const totalIndices = bladeCount * BLADE_SEGMENTS * 6;

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const params = new Float32Array(totalVerts * 3);
  const tints = new Float32Array(totalVerts);
  const indices = new Uint16Array(totalIndices);

  const tangent = new THREE.Vector3();
  const perp = new THREE.Vector3();
  const normal = new THREE.Vector3();

  let v = 0;
  let idx = 0;

  for (let c = 0; c < PLANT_CLUMPS; c++) {
    // Keep clumps off the walls and out of the very middle, where the poi mostly work.
    const cx = rng.range(-TANK.halfWidth + 1.4, TANK.halfWidth - 1.4);
    const cz = rng.range(-TANK.halfDepth + 0.9, TANK.halfDepth - 0.9);
    const clumpTint = rng.next();

    for (let b = 0; b < BLADES_PER_CLUMP; b++) {
      const angle = rng.range(0, Math.PI * 2);
      const spread = rng.range(0, 0.34);
      const baseX = cx + Math.cos(angle) * spread;
      const baseZ = cz + Math.sin(angle) * spread;

      const height = rng.range(0.55, 1.45);
      const bendDir = rng.range(0, Math.PI * 2);
      const bend = rng.range(0.12, 0.42);
      const halfWidth = rng.range(0.022, 0.048);
      const phase = rng.range(0, Math.PI * 2);
      const stiffness = rng.range(0.55, 1.0);
      const tint = clumpTint * 0.6 + rng.next() * 0.4;

      const bendX = Math.cos(bendDir) * bend;
      const bendZ = Math.sin(bendDir) * bend;
      // The ribbon's width axis is perpendicular to the direction it bends in.
      perp.set(-Math.sin(bendDir), 0, Math.cos(bendDir));

      const firstVert = v;

      for (let s = 0; s <= BLADE_SEGMENTS; s++) {
        const t = s / BLADE_SEGMENTS;
        const cxPos = baseX + bendX * t * t;
        const cyPos = TANK.floorY + height * t;
        const czPos = baseZ + bendZ * t * t;

        // d/dt of the centre curve above.
        tangent.set(2 * bendX * t, height, 2 * bendZ * t).normalize();
        normal.crossVectors(tangent, perp).normalize();

        // Taper: broad at the base, pointed at the tip.
        const w = halfWidth * (0.45 + 0.9 * Math.sin(Math.PI * (0.15 + 0.75 * (1 - t))));

        for (let side = 0; side < 2; side++) {
          const sign = side === 0 ? -1 : 1;
          const o = v * 3;
          positions[o] = cxPos + perp.x * w * sign;
          positions[o + 1] = cyPos;
          positions[o + 2] = czPos + perp.z * w * sign;
          normals[o] = normal.x;
          normals[o + 1] = normal.y;
          normals[o + 2] = normal.z;
          params[o] = t;
          params[o + 1] = phase;
          params[o + 2] = stiffness;
          tints[v] = tint;
          v++;
        }
      }

      for (let s = 0; s < BLADE_SEGMENTS; s++) {
        const a = firstVert + s * 2;
        indices[idx++] = a;
        indices[idx++] = a + 1;
        indices[idx++] = a + 2;
        indices[idx++] = a + 1;
        indices[idx++] = a + 3;
        indices[idx++] = a + 2;
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('aParam', new THREE.BufferAttribute(params, 3));
  geometry.setAttribute('aTint', new THREE.BufferAttribute(tints, 1));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

function createBubbleGeometry(): THREE.BufferGeometry {
  const rng = createRng(FLOOR_SEED + 131);
  const positions = new Float32Array(BUBBLE_COUNT * 3);
  const bubbles = new Float32Array(BUBBLE_COUNT * 3);

  for (let i = 0; i < BUBBLE_COUNT; i++) {
    const o = i * 3;
    positions[o] = rng.range(-TANK.halfWidth + 0.4, TANK.halfWidth - 0.4);
    positions[o + 1] = 0; // replaced in the vertex shader
    positions[o + 2] = rng.range(-TANK.halfDepth + 0.4, TANK.halfDepth - 0.4);

    bubbles[o] = rng.next();
    // A spread of rise rates: the small ones are slow and linger.
    bubbles[o + 1] = rng.range(0.055, 0.16);
    // WORLD diameter, not pixels: the vertex shader turns this into gl_PointSize
    // via uPixelScale / distance. A gravel bubble is a few millimetres across;
    // anything above ~0.05 fills the tank with beach balls.
    bubbles[o + 2] = rng.range(0.014, 0.046);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aBubble', new THREE.BufferAttribute(bubbles, 3));
  geometry.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(0, TANK.floorY / 2, 0),
    Math.max(TANK.width, TANK.depth),
  );
  return geometry;
}

/* ------------------------------------------------------------------------------ */
/* Component                                                                        */
/* ------------------------------------------------------------------------------ */


export function Underwater() {
  const stonesRef = useRef<THREE.InstancedMesh>(null);

  /** Shared clock holder — one assignment per frame drives every animated material. */
  const time = useMemo(() => ({ value: 0 }), []);

  /**
   * One shared set of uniform holders across every underwater material, so the light
   * rig can never drift out of sync between the gravel, the stones and the plants.
   */
  const lightUniforms = useMemo(
    () => ({
      uTime: time,
      uKeyColor: { value: new THREE.Color('#ffd2a0') },
      uFillColor: { value: new THREE.Color('#1d5f66') },
      uGroundColor: { value: new THREE.Color('#07222c') },
      uFogColor: { value: new THREE.Color('#0a3441') },
      uKeyIntensity: { value: 1.05 },
      uAbsorption: { value: 0.55 },
      uFogDensity: { value: 0.042 },
    }),
    [time],
  );

  const floorGeometry = useMemo(createFloorGeometry, []);
  const plantGeometry = useMemo(createPlantGeometry, []);
  const bubbleGeometry = useMemo(createBubbleGeometry, []);

  /**
   * Stone geometry and its instance placement are built together: the per-instance tint
   * has to be on the geometry as an InstancedBufferAttribute before the first draw.
   */
  const stones = useMemo(() => {
    const geometry = createStoneGeometry();
    const rng = createRng(FLOOR_SEED + 313);
    const matrices: THREE.Matrix4[] = [];
    const tints = new Float32Array(STONE_COUNT);

    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const scale = new THREE.Vector3();

    for (let i = 0; i < STONE_COUNT; i++) {
      const x = rng.range(-TANK.halfWidth + 1.0, TANK.halfWidth - 1.0);
      const z = rng.range(-TANK.halfDepth + 0.8, TANK.halfDepth - 0.8);
      const size = rng.range(0.18, 0.46);
      // Sit each stone partly into the gravel so none of them look like they float.
      position.set(x, TANK.floorY + tankFloorHeight(x, z) + size * 0.22, z);
      euler.set(rng.range(-0.22, 0.22), rng.range(0, Math.PI * 2), rng.range(-0.22, 0.22));
      quaternion.setFromEuler(euler);
      // Near-uniform scale keeps mat3(instanceMatrix) a valid normal transform.
      scale.set(size * rng.range(0.92, 1.18), size, size * rng.range(0.92, 1.18));
      matrices.push(new THREE.Matrix4().compose(position, quaternion, scale));
      tints[i] = rng.next();
    }

    geometry.setAttribute('aTint', new THREE.InstancedBufferAttribute(tints, 1));
    return { geometry, matrices };
  }, []);

  const floorMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: FLOOR_VERT,
        fragmentShader: FLOOR_FRAG,
        uniforms: {
          ...lightUniforms,
          uSandLight: { value: new THREE.Color('#b09472') },
          uSandDark: { value: new THREE.Color('#5c4a3a') },
          uSandPale: { value: new THREE.Color('#d8cbb2') },
          /** Pebble cells per world unit — ~11cm stones. */
          uPebbleScale: { value: 9.0 },
        },
      }),
    [lightUniforms],
  );

  const stoneMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: STONE_VERT,
        fragmentShader: STONE_FRAG,
        uniforms: {
          ...lightUniforms,
          uStoneLight: { value: new THREE.Color('#8d8b83') },
          uStoneDark: { value: new THREE.Color('#3d4048') },
        },
      }),
    [lightUniforms],
  );

  const plantMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: PLANT_VERT,
        fragmentShader: PLANT_FRAG,
        side: THREE.DoubleSide,
        uniforms: {
          ...lightUniforms,
          uSway: { value: 0.16 },
          uSwaySpeed: { value: 0.75 },
          uPlantBase: { value: new THREE.Color('#1c4a2a') },
          uPlantTip: { value: new THREE.Color('#6fbf63') },
        },
      }),
    [lightUniforms],
  );

  const bubbleMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: BUBBLE_VERT,
        fragmentShader: BUBBLE_FRAG,
        transparent: true,
        depthWrite: false,
        uniforms: {
          uTime: time,
          uBottom: { value: TANK.floorY + 0.06 },
          uTop: { value: TANK.surfaceY - 0.05 },
          uPixelScale: { value: 600 },
          uBubbleColor: { value: new THREE.Color('#cdeef2') },
        },
      }),
    [time],
  );

  useEffect(() => {
    const mesh = stonesRef.current;
    if (!mesh) return;
    for (let i = 0; i < STONE_COUNT; i++) {
      mesh.setMatrixAt(i, stones.matrices[i]);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [stones]);

  useEffect(
    () => () => {
      floorGeometry.dispose();
      stones.geometry.dispose();
      plantGeometry.dispose();
      bubbleGeometry.dispose();
      floorMaterial.dispose();
      stoneMaterial.dispose();
      plantMaterial.dispose();
      bubbleMaterial.dispose();
    },
    [
      floorGeometry,
      stones,
      plantGeometry,
      bubbleGeometry,
      floorMaterial,
      stoneMaterial,
      plantMaterial,
      bubbleMaterial,
    ],
  );

  useFrame((state) => {
    time.value = state.clock.elapsedTime;

    // gl_PointSize is in drawing-buffer pixels, so the bubble projection scale has to
    // track both the canvas height and the camera's field of view.
    const camera = state.camera as THREE.PerspectiveCamera;
    const fov = camera.isPerspectiveCamera ? camera.fov : 45;
    const heightPx = state.size.height * state.viewport.dpr;
    bubbleMaterial.uniforms.uPixelScale.value = (heightPx * 0.5) / Math.tan((fov * Math.PI) / 360);
  });

  return (
    <group>
      <mesh geometry={floorGeometry} material={floorMaterial} position={[0, TANK.floorY, 0]} />
      <instancedMesh ref={stonesRef} args={[stones.geometry, stoneMaterial, STONE_COUNT]} />
      <mesh geometry={plantGeometry} material={plantMaterial} />
      <points geometry={bubbleGeometry} material={bubbleMaterial} frustumCulled={false} />
    </group>
  );
}
