'use client';

/**
 * Post-processing for the big screen (spec §13.3, §108, §126).
 *
 * Restrained on purpose. The tank is a night scene lit by warm stall lamps, and the
 * spec wants the 金色金魚 to be *noticed* without a banner announcing it (§108) — so the
 * bloom threshold sits high enough that only the lantern filaments and the gold fish's
 * sheen cross it. Everything else stays crisp.
 *
 *   Bloom               — the lanterns and the rare fish glow, nothing else.
 *   Vignette            — pulls the eye to the middle of a very wide projection.
 *   ChromaticAberration — a hint of lens character at the frame edges only.
 *
 * At 'enabled = false' (RoomSettings.highQuality off, or a weak GPU) this renders null
 * and the scene draws straight to the screen.
 */

import { Bloom, ChromaticAberration, EffectComposer, Vignette } from '@react-three/postprocessing';
import { BlendFunction, VignetteTechnique } from 'postprocessing';
import { useMemo } from 'react';
import * as THREE from 'three';

import { DIAG } from '@/rendering/diagFlags';

export type EffectsQuality = 'low' | 'medium' | 'high';

export interface EffectsProps {
  enabled?: boolean;
  quality?: EffectsQuality;
}

/**
 * The composer takes over presentation: it renders the scene into its own buffers and
 * blits the result to the canvas, on a 'useFrame' at priority 1.
 *
 * IMPORTANT for the screen page: the water surface component ALSO claims rendering with
 * a priority-1 'useFrame' so it can render its refraction FBO before the main pass. Two
 * owners of the render loop means the last one registered wins and the other's output is
 * discarded — you get either a black screen or a scene with no water.
 *
 * So the screen scene must pick exactly one:
 *   - manual water rendering ON  -> mount '<Effects enabled={false} />'
 *   - the composer ON            -> the water surface must not drive the render loop
 *
 * This flag exists so the page can branch on it rather than hard-coding the assumption.
 */
export const EFFECTS_TAKE_OVER_RENDER = true;

interface QualitySpec {
  /** MSAA samples for the composer's render pass. */
  multisampling: number;
  /** Mipmap blur levels — more levels means a wider, softer glow. */
  bloomLevels: number;
  bloomIntensity: number;
  bloomRadius: number;
  chromaticAberration: boolean;
}

const QUALITY: Record<EffectsQuality, QualitySpec> = {
  high: {
    multisampling: 4,
    bloomLevels: 8,
    bloomIntensity: 0.62,
    bloomRadius: 0.7,
    chromaticAberration: true,
  },
  medium: {
    multisampling: 2,
    bloomLevels: 6,
    bloomIntensity: 0.55,
    bloomRadius: 0.62,
    chromaticAberration: true,
  },
  low: {
    // Bloom only: at this tier we are already fighting for the 60fps the spec demands (§77).
    multisampling: 0,
    bloomLevels: 4,
    bloomIntensity: 0.45,
    bloomRadius: 0.5,
    chromaticAberration: false,
  },
};

/**
 * WebKit (Safari) intermittently resolves multisampled half-float renderbuffers
 * to BLACK — on the venue projector that was a full-screen black flash every
 * few water entries, confirmed by bisecting with the on-screen 入水診断 probe
 * in headless WebKit: with the composer the centre of the frame goes black,
 * without it it never does. Multisampling off on WebKit keeps the bloom and
 * kills the flash; every other browser keeps MSAA.
 */
const IS_WEBKIT =
  typeof navigator !== 'undefined' &&
  /AppleWebKit/.test(navigator.userAgent) &&
  !/Chrome|Chromium|Edg\//.test(navigator.userAgent);

export function Effects({ enabled = true, quality = 'high' }: EffectsProps) {
  const spec = QUALITY[quality] ?? QUALITY.high;
  const multisampling = IS_WEBKIT ? 0 : spec.multisampling;

  // A stable Vector2: recreating it every render would thrash the effect's uniform.
  const caOffset = useMemo(() => new THREE.Vector2(0.00045, 0.0006), []);

  if (!enabled || DIAG.noPostFx) return null;

  return (
    <EffectComposer
      multisampling={multisampling}
      // Half-float buffers: the bloom needs headroom above 1.0 or the lanterns clip flat.
      frameBufferType={THREE.HalfFloatType}
      enableNormalPass={false}
    >
      <Bloom
        // High threshold — this is the whole point. Warm lantern filaments and the gold
        // fish's specular sit above it; lit water, gravel and paper do not.
        luminanceThreshold={0.82}
        luminanceSmoothing={0.16}
        intensity={spec.bloomIntensity}
        radius={spec.bloomRadius}
        levels={spec.bloomLevels}
        mipmapBlur
        blendFunction={BlendFunction.SCREEN}
      />
      <Vignette
        offset={0.26}
        darkness={0.62}
        // DEFAULT rather than ESKIL: Eskil's curve bands visibly on a large projection.
        technique={VignetteTechnique.DEFAULT}
        blendFunction={BlendFunction.NORMAL}
      />
      {spec.chromaticAberration ? (
        <ChromaticAberration
          offset={caOffset}
          // Radial: the centre of the projection stays perfectly clean, only the far
          // edges pick up a fringe. Any global offset would look like a broken projector.
          radialModulation
          modulationOffset={0.42}
          blendFunction={BlendFunction.NORMAL}
        />
      ) : null}
    </EffectComposer>
  );
}
