/**
 * Goldfish material (spec §64, §108, §130).
 *
 * A real MeshStandardMaterial — the fish must sit under the same PBR
 * lighting as the rest of the stall, catching the warm lantern key and the
 * blue-green underwater fill. 'onBeforeCompile' grafts the swimming animation
 * from 'fishAnimation.ts' onto the standard vertex shader and layers the
 * species colouring on top of the standard fragment shader, so shadows,
 * environment reflections and tone mapping all keep working.
 *
 * Per-instance attributes fed by 'FishSchool':
 *   aPhase  beat offset (turns)          aState  FishAnimState index
 *   aSpeed  (beats/s, amplitude)         aTurn   -1..1 banking
 *   aTint   colour jitter                aSheen  specular sheen
 *
 * Two fish of the same species never look identical: 'aTint' moves the body
 * gradient, the 赤白 patches and the phase of the travelling glint (spec §130).
 */

import { Color, DoubleSide, MeshStandardMaterial } from 'three';
import type { IUniform, WebGLProgramParametersWithUniforms } from 'three';

import { FISH_ANIM_TUNING, FISH_VERTEX_BODY, FISH_VERTEX_HEAD } from '@/game/fish/fishAnimation';
import { fishShaderParams, type FishLod } from '@/game/fish/fishGeometry';
import { FISH_CATALOG } from '@/game/fish/fishTypes';
import type { FishType } from '@/types';

/**
 * Shared animation clock. Every fish material references this exact object, so
 * one write per frame drives the whole school.
 */
export const FISH_TIME_UNIFORM: IUniform<number> = { value: 0 };

/** Advance the shared fish animation clock (seconds). */
export function updateFishTime(seconds: number): void {
  FISH_TIME_UNIFORM.value = seconds;
}

interface FishSurface {
  roughness: number;
  metalness: number;
  /** How strongly 'aSheen' turns into a metallic glint. */
  glint: number;
  /** Fresnel rim colour — what the fish picks up from the lanterns / water. */
  rim: string;
  envMapIntensity: number;
}

const SURFACE: Record<FishType, FishSurface> = {
  red: { roughness: 0.42, metalness: 0.05, glint: 0.12, rim: '#ffd2ae', envMapIntensity: 0.8 },
  redwhite: { roughness: 0.4, metalness: 0.05, glint: 0.16, rim: '#ffdcc4', envMapIntensity: 0.85 },
  // 黒金魚 is velvet with a wet highlight — it reads as a silhouette in the deep water.
  black: { roughness: 0.3, metalness: 0.18, glint: 0.3, rim: '#7fb6d8', envMapIntensity: 1.0 },
  demekin: { roughness: 0.34, metalness: 0.12, glint: 0.35, rim: '#c9a0d8', envMapIntensity: 1.0 },
  // 金色金魚: genuinely metallic, so the festival lights streak across it (spec §108).
  gold: { roughness: 0.2, metalness: 0.75, glint: 1.0, rim: '#ffefb8', envMapIntensity: 1.35 },
};

const FRAGMENT_HEAD = /* glsl */ `
uniform vec3  uColorBody;
uniform vec3  uColorSecondary;
uniform vec3  uColorFin;
uniform vec3  uRimColor;
uniform float uGlint;
uniform float uTime;

varying float vPart;
varying float vSpine;
varying float vBelly;
varying float vSide;
varying float vBeat;
varying vec3  vTint;
varying float vSheen;
`;

const FRAGMENT_COLOR = /* glsl */ `
{
	// Body-space gradient: pale belly rising into the saturated back, with a
	// slight head-to-tail sweep so the fish is not flat-shaded in colour.
	float grad = clamp( vBelly * 0.9 + vSpine * 0.18, 0.0, 1.0 );
	vec3 base = mix( uColorSecondary, uColorBody, smoothstep( 0.16, 0.74, grad ) );

	#ifdef FISH_PATCHED
		// 赤白金魚: red patches whose placement is per-instance, never repeated.
		float pband = sin( vSpine * 9.0 + vTint.x * 18.0 ) * 0.5 + 0.5;
		pband *= 0.55 + 0.45 * sin( vSpine * 21.0 + vTint.z * 11.0 );
		base = mix( base, uColorSecondary,
			smoothstep( 0.42, 0.78, pband ) * ( 0.3 + 0.7 * vBelly ) );
	#endif

	// Fins take the fin colour and thin out toward their trailing edge.
	float finMask = step( 0.5, vPart ) * step( vPart, 3.5 );
	base = mix( base, uColorFin, finMask * 0.78 );

	// Per-instance tint jitter (spec §130 — they must not all look the same).
	base *= 1.0 + ( vTint - 0.5 ) * 0.26;

	float eyeMask = step( 3.5, vPart );
	base = mix( base, vec3( 0.015, 0.013, 0.018 ), eyeMask );

	diffuseColor.rgb = clamp( base, 0.0, 1.0 );
}
`;

const FRAGMENT_SURFACE = /* glsl */ `
{
	float finMask = step( 0.5, vPart ) * step( vPart, 3.5 );
	float eyeMask = step( 3.5, vPart );
	// Fin membrane is matte, scales are wet, eyes are glass beads.
	roughnessFactor = mix( roughnessFactor, 0.62, finMask * 0.7 );
	roughnessFactor = mix( roughnessFactor, 0.14, vSheen * 0.8 );
	roughnessFactor = mix( roughnessFactor, 0.06, eyeMask );
	metalnessFactor = mix( metalnessFactor, 0.9, clamp( vSheen * uGlint, 0.0, 1.0 ) );
	metalnessFactor *= 1.0 - eyeMask;
}
`;

const FRAGMENT_SHEEN = /* glsl */ `
{
	vec3 fishView = normalize( vViewPosition );
	float fres = pow( 1.0 - clamp( dot( normal, fishView ), 0.0, 1.0 ), 3.0 );
	float finMask = step( 0.5, vPart ) * step( vPart, 3.5 );

	// Wet-scale rim: the silhouette catches the lantern light.
	totalEmissiveRadiance += uRimColor * fres * ( 0.06 + vSheen * 0.42 );
	// Fins are thin enough to glow slightly when backlit.
	totalEmissiveRadiance += uColorFin * finMask * fres * 0.16;

	// A glint band travelling along the flank. Scaled by sheen, so only the
	// 金色金魚 really flashes — the audience spots it with no banner (spec §108).
	float gband = sin( vSpine * 8.0 - uTime * 2.1 + vTint.y * 6.283185 + vBeat * 0.6 );
	float glint = smoothstep( 0.82, 1.0, gband ) * vSheen * uGlint;
	totalEmissiveRadiance += uColorSecondary * glint * 1.5;
}
`;

/**
 * Build the material for one species at one LOD.
 *
 * A fresh material per (type, LOD) is intentional: 'defines' compile the
 * species branches away, and 'customProgramCacheKey' keeps three from sharing
 * a program between species that need different code.
 */
export function createFishMaterial(type: FishType, lod: FishLod): MeshStandardMaterial {
  const data = FISH_CATALOG[type];
  const surface = SURFACE[type];
  const params = fishShaderParams(type);

  const material = new MeshStandardMaterial({
    color: new Color(data.colorBody),
    roughness: surface.roughness,
    metalness: surface.metalness,
    envMapIntensity: surface.envMapIntensity,
    // The fins are single-sheet membranes; the body is closed. DoubleSide is
    // what makes a real veil tail read correctly from every angle (spec §65).
    side: DoubleSide,
    flatShading: false,
    name: `fishMaterial.${type}.lod${lod}`,
  });

  const defines: Record<string, string> = {
    FISH_RENDER: '1',
    FISH_LOD: String(lod),
  };
  if (type === 'redwhite') defines.FISH_PATCHED = '1';
  if (type === 'demekin') defines.FISH_DEMEKIN = '1';
  if (type === 'gold') defines.FISH_GOLD = '1';
  if (type === 'black') defines.FISH_DARK = '1';
  material.defines = defines;

  // Longer, floatier fish carry a longer wave; the stubby 出目金 a shorter one.
  const waveNumber = FISH_ANIM_TUNING.waveNumber * (0.85 + 0.3 * params.tailBase);

  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms.uTime = FISH_TIME_UNIFORM;
    shader.uniforms.uLength = { value: params.length };
    shader.uniforms.uInvDepth = { value: 1 / Math.max(params.depth, 1e-4) };
    shader.uniforms.uWaveNumber = { value: waveNumber };
    shader.uniforms.uBodyAmp = { value: FISH_ANIM_TUNING.bodyAmp };
    shader.uniforms.uTailAmp = { value: FISH_ANIM_TUNING.tailAmp };
    shader.uniforms.uTailLag = { value: FISH_ANIM_TUNING.tailLag };
    shader.uniforms.uTailBase = { value: params.tailBase };
    shader.uniforms.uTailSpread = { value: FISH_ANIM_TUNING.tailSpread };
    shader.uniforms.uFinAmp = { value: FISH_ANIM_TUNING.finAmp };
    shader.uniforms.uFlapAmp = { value: FISH_ANIM_TUNING.flapAmp };
    shader.uniforms.uArchAmp = { value: FISH_ANIM_TUNING.archAmp };
    shader.uniforms.uFinPivotY = { value: params.pivotY };

    shader.uniforms.uColorBody = { value: new Color(data.colorBody) };
    shader.uniforms.uColorSecondary = { value: new Color(data.colorSecondary) };
    shader.uniforms.uColorFin = { value: new Color(data.colorFin) };
    shader.uniforms.uRimColor = { value: new Color(surface.rim) };
    shader.uniforms.uGlint = { value: surface.glint };

    // objectNormal must already be deformed when <defaultnormal_vertex> runs,
    // so 'transformed' is declared early and <begin_vertex> is neutralised.
    shader.vertexShader =
      FISH_VERTEX_HEAD +
      shader.vertexShader
        .replace(
          '#include <beginnormal_vertex>',
          `#include <beginnormal_vertex>\n\tvec3 transformed = vec3( position );\n${FISH_VERTEX_BODY}`,
        )
        .replace(
          '#include <begin_vertex>',
          '#ifdef USE_ALPHAHASH\n\tvPosition = vec3( position );\n#endif',
        );

    shader.fragmentShader =
      FRAGMENT_HEAD +
      shader.fragmentShader
        .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAGMENT_COLOR}`)
        .replace(
          '#include <metalnessmap_fragment>',
          `#include <metalnessmap_fragment>\n${FRAGMENT_SURFACE}`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>\n${FRAGMENT_SHEEN}`,
        );
  };

  // Stable key: species and LOD are the only things that change the program.
  material.customProgramCacheKey = () => `fish|${type}|${lod}|v1`;

  return material;
}
