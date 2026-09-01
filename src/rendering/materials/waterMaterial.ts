/**
 * Water surface material (spec §60, §61).
 *
 * Builds the ShaderMaterial for the big tank's surface plane and owns every default the
 * art direction depends on. The shader itself lives in @/rendering/shaders/waterSurface.glsl.
 *
 * The surface is drawn AFTER the underwater scene has been captured into a colour FBO
 * (see WaterSurface.tsx), so 'transparent' here is about draw order, not blending —
 * the shader composites the refracted image itself and writes an opaque result.
 */

import * as THREE from 'three';

import { TANK } from '@/game/core/constants';
import { WATER_FRAG, WATER_VERT } from '@/rendering/shaders/waterSurface.glsl';

export type WaterQuality = 'high' | 'low';

/** Accepts the boolean 'RoomSettings.highQuality' as well as an explicit level. */
export function normalizeQuality(q: WaterQuality | boolean | undefined): WaterQuality {
  if (q === undefined) return 'high';
  if (typeof q === 'boolean') return q ? 'high' : 'low';
  return q;
}

export interface WaterMaterialOptions {
  /** Ripple field texture (r = height, g = previous, ba = gradient, biased 0..1). */
  ripple?: THREE.Texture | null;
  /** Scene colour FBO captured without the water surface. */
  refraction?: THREE.Texture | null;
  /** Depth texture of the same FBO — drives thickness, absorption and foam. */
  sceneDepth?: THREE.Texture | null;
  cameraNear?: number;
  cameraFar?: number;
  /** Drawing-buffer size in pixels. */
  resolution?: THREE.Vector2;
  quality?: WaterQuality | boolean;
  shallowColor?: THREE.ColorRepresentation;
  deepColor?: THREE.ColorRepresentation;
  foamColor?: THREE.ColorRepresentation;
  /** Direction FROM the surface TOWARD the key light. */
  lightDir?: THREE.Vector3;
  lanternPositions?: readonly THREE.Vector3[];
  lanternColors?: readonly THREE.ColorRepresentation[];
}

/** Number of lantern reflections the shader carries. Must match the uniform arrays. */
export const WATER_LANTERN_COUNT = 4;

/**
 * Default lantern rig: four paper lanterns strung along the FAR rim of the stall.
 *
 * The far rim is not an arbitrary choice — it is the only side whose reflection lands
 * in the water. With the screen camera at roughly (0, 3.2, 9.6), the mirror image of a
 * lantern hung over the near rim crosses the water plane at z ~ +7, well outside the
 * tank; hung over the far rim at y ~ 2.8 it crosses at z ~ +1.8, right in the middle of
 * the surface. Move these and the reflections move with them, so a rig that hangs
 * lanterns elsewhere should also verify they still reflect somewhere visible.
 *
 * Lanterns.tsx owns the real ones and should push them in with setWaterLanterns.
 */
export const DEFAULT_LANTERN_POSITIONS: readonly THREE.Vector3[] = [
  new THREE.Vector3(-5.4, 2.6, -TANK.halfDepth - 0.55),
  new THREE.Vector3(-1.8, 2.9, -TANK.halfDepth - 0.55),
  new THREE.Vector3(1.8, 2.9, -TANK.halfDepth - 0.55),
  new THREE.Vector3(5.4, 2.6, -TANK.halfDepth - 0.55),
];

export const DEFAULT_LANTERN_COLORS: readonly THREE.ColorRepresentation[] = [
  '#ff6a35',
  '#ffc76a',
  '#ffc76a',
  '#ff6a35',
];

const DEFAULT_SHALLOW = '#2f7a72';
const DEFAULT_DEEP = '#04202e';
const DEFAULT_FOAM = '#e6f3f0';

function fillVectors(source: readonly THREE.Vector3[] | undefined): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < WATER_LANTERN_COUNT; i++) {
    const src = source && source[i] ? source[i] : DEFAULT_LANTERN_POSITIONS[i];
    out.push(src.clone());
  }
  return out;
}

function fillColors(source: readonly THREE.ColorRepresentation[] | undefined): THREE.Color[] {
  const out: THREE.Color[] = [];
  for (let i = 0; i < WATER_LANTERN_COUNT; i++) {
    const src = source && source[i] !== undefined ? source[i] : DEFAULT_LANTERN_COLORS[i];
    out.push(new THREE.Color(src));
  }
  return out;
}

export function createWaterMaterial(opts: WaterMaterialOptions = {}): THREE.ShaderMaterial {
  const quality = normalizeQuality(opts.quality);
  const high = quality === 'high';

  const material = new THREE.ShaderMaterial({
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    defines: high ? { WATER_QUALITY_HIGH: '' } : {},
    transparent: true,
    // The surface must not occlude the poi handles and splash particles drawn after it,
    // and it already composites everything beneath it from the FBO.
    depthWrite: false,
    side: THREE.FrontSide,
    uniforms: {
      uTime: { value: 0 },
      uRipple: { value: opts.ripple ?? null },
      uRefraction: { value: opts.refraction ?? null },
      uSceneDepth: { value: opts.sceneDepth ?? null },
      uCameraNear: { value: opts.cameraNear ?? 0.1 },
      uCameraFar: { value: opts.cameraFar ?? 100 },
      uResolution: { value: opts.resolution ?? new THREE.Vector2(1920, 1080) },
      uShallowColor: { value: new THREE.Color(opts.shallowColor ?? DEFAULT_SHALLOW) },
      uDeepColor: { value: new THREE.Color(opts.deepColor ?? DEFAULT_DEEP) },
      uFoamColor: { value: new THREE.Color(opts.foamColor ?? DEFAULT_FOAM) },
      uLightDir: { value: (opts.lightDir ?? new THREE.Vector3(0.22, 0.9, 0.38)).clone().normalize() },
      uLanternPositions: { value: fillVectors(opts.lanternPositions) },
      uLanternColors: { value: fillColors(opts.lanternColors) },
      uQuality: { value: high ? 1 : 0.35 },

      uTankSize: { value: new THREE.Vector2(TANK.width, TANK.depth) },
      // Gerstner tuning — global multipliers over the wave set baked into the shader.
      uWaveAmplitude: { value: 1 },
      uWaveSpeed: { value: 1 },
      uWaveSteepness: { value: 1 },
      // Ripple field contribution. The height term is deliberately modest and the
      // normal terms strong: a real ripple is read from the light sliding across its
      // slope far more than from how far it lifts the surface.
      uRippleHeight: { value: 0.4 },
      uRippleNormal: { value: 1.2 },
      // Screen-space refraction offset, in screen uv at full water column depth.
      // Screen-UV units. 0.22 bends the tap by a fifth of the frame and smears the
      // whole school into unreadable colour; the players have to be able to pick out
      // one fish and go for it, so the bend stays around one percent of the frame.
      uRefractionStrength: { value: 0.045 },
      // Beer-Lambert extinction multiplier.
      // Path length through the water grows fast at the grazing angles the far half of
      // the tank is seen at, so a physically plausible 0.55 turns the back of the tank
      // into flat green soup. Kept low enough that every fish stays visible.
      uAbsorption: { value: 0.22 },
      /** Ceiling on the Fresnel mirror so the far half of the tank stays readable. */
      uMaxFresnel: { value: 0.46 },
      uColumnDepth: { value: TANK.waterDepth },
      uDetailStrength: { value: high ? 0.045 : 0.03 },
      /** Per-pixel ripple gradient, on top of the per-vertex one. */
      uRippleDetail: { value: 1.2 },
      /** Water column thickness (world units) over which the foam line fades out. */
      uFoamWidth: { value: 0.11 },
      uSpecularBoost: { value: 1 },
    },
  });

  material.name = 'WaterSurfaceMaterial';
  return material;
}

/** Push the live lantern rig into an existing water material (spec §60 reflections). */
export function setWaterLanterns(
  material: THREE.ShaderMaterial,
  positions: readonly THREE.Vector3[],
  colors?: readonly THREE.ColorRepresentation[],
): void {
  const targetPositions = material.uniforms.uLanternPositions.value as THREE.Vector3[];
  const targetColors = material.uniforms.uLanternColors.value as THREE.Color[];
  for (let i = 0; i < WATER_LANTERN_COUNT; i++) {
    const p = positions[i] ?? DEFAULT_LANTERN_POSITIONS[i];
    targetPositions[i].copy(p);
    if (colors) {
      targetColors[i].set(colors[i] ?? DEFAULT_LANTERN_COLORS[i]);
    }
  }
}

/** Switch quality at runtime. Changing a define forces a shader recompile. */
export function setWaterQuality(material: THREE.ShaderMaterial, quality: WaterQuality | boolean): void {
  const level = normalizeQuality(quality);
  const high = level === 'high';
  const already = material.defines !== undefined && 'WATER_QUALITY_HIGH' in material.defines;
  if (already === high) return;

  if (high) {
    material.defines = { ...material.defines, WATER_QUALITY_HIGH: '' };
  } else {
    const next = { ...material.defines };
    delete next.WATER_QUALITY_HIGH;
    material.defines = next;
  }
  material.uniforms.uQuality.value = high ? 1 : 0.35;
  material.uniforms.uDetailStrength.value = high ? 0.045 : 0.03;
  material.needsUpdate = true;
}
