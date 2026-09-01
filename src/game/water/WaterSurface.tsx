'use client';

/**
 * The water surface plane (spec §60, §61).
 *
 * This component owns the refraction capture. It runs at 'useFrame' priority 1, which
 * turns OFF R3F's automatic render — so it is responsible for BOTH passes:
 *
 *   1. hide the water, render the scene into the colour+depth FBO  (what is under water)
 *   2. show the water, render the scene to the canvas               (the final image)
 *
 * The water shader then reads that FBO for screen-space refraction and reconstructs the
 * water column thickness from its depth texture for absorption and foam.
 */

import { useFBO } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';

import { TANK } from '@/game/core/constants';
import {
  createWaterMaterial,
  normalizeQuality,
  type WaterQuality,
} from '@/rendering/materials/waterMaterial';

import { RippleField } from './rippleField';

/** Surface tessellation. The Gerstner displacement is geometric, so this must be dense. */
const SEGMENTS: Record<WaterQuality, [number, number]> = {
  high: [220, 140],
  low: [90, 60],
};

export interface WaterSurfaceProps {
  rippleField: RippleField;
  /** Accepts 'RoomSettings.highQuality' directly. Defaults to high. */
  quality?: WaterQuality | boolean;
  /**
   * Leave true (the default) for the normal screen client. A post-processing stack that
   * takes over the final composite should set this false: the refraction FBO is still
   * produced, but the on-screen render is left to whoever owns the effect composer.
   */
  renderScene?: boolean;
}

/**
 * Lazily construct a RippleField bound to the live renderer, disposed on unmount.
 * The screen client creates this once and shares it with WaterSurface and Caustics.
 */
export function useRippleField(size = 512): RippleField {
  const gl = useThree((state) => state.gl);
  const field = useMemo(() => new RippleField(gl, size), [gl, size]);
  useEffect(() => () => field.dispose(), [field]);
  return field;
}

export function WaterSurface({ rippleField, quality, renderScene = true }: WaterSurfaceProps) {
  const gl = useThree((state) => state.gl);
  const level = normalizeQuality(quality);
  const meshRef = useRef<THREE.Mesh>(null);

  // Half-float keeps highlights on the underwater image from clipping before the water
  // shader gets to tone them; 8-bit is the fallback for GPUs that cannot render float.
  const fboType = useMemo(
    () =>
      gl.extensions.has('EXT_color_buffer_half_float') || gl.extensions.has('EXT_color_buffer_float')
        ? THREE.HalfFloatType
        : THREE.UnsignedByteType,
    [gl],
  );

  // Fullscreen FBO, resized with the viewport by drei. 'depthBuffer' makes drei attach a
  // float DepthTexture, which is what lets the shader reconstruct the water column:
  // thickness for Beer-Lambert absorption, and the near-zero band that becomes foam.
  const fbo = useFBO({
    depthBuffer: true,
    stencilBuffer: false,
    type: fboType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
  });

  const geometry = useMemo(() => {
    const [wSeg, dSeg] = SEGMENTS[level];
    const g = new THREE.PlaneGeometry(TANK.width, TANK.depth, wSeg, dSeg);
    // Bake the rotation in so the plane is already world-oriented (XZ, normal +Y).
    g.rotateX(-Math.PI / 2);
    return g;
  }, [level]);

  const material = useMemo(
    () =>
      createWaterMaterial({
        ripple: rippleField.texture,
        refraction: fbo.texture,
        sceneDepth: fbo.depthTexture,
        quality: level,
      }),
    [rippleField, fbo, level],
  );

  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);

  useFrame((state, delta) => {
    const mesh = meshRef.current;
    // Clamp: a tab that was backgrounded returns a huge delta and would blow up the
    // wave equation's substep budget for nothing.
    const dt = Math.min(delta, 0.05);

    rippleField.update(dt);

    const uniforms = material.uniforms;
    uniforms.uTime.value = state.clock.elapsedTime;
    uniforms.uRipple.value = rippleField.texture;
    uniforms.uRefraction.value = fbo.texture;
    uniforms.uSceneDepth.value = fbo.depthTexture;
    // gl_FragCoord is in drawing-buffer pixels, which is exactly the FBO's size.
    (uniforms.uResolution.value as THREE.Vector2).set(fbo.width, fbo.height);

    // Both perspective and orthographic cameras carry near/far; the reconstruction in
    // the shader assumes the perspective form, which is what the screen client uses.
    const camera = state.camera as THREE.PerspectiveCamera;
    uniforms.uCameraNear.value = camera.near;
    uniforms.uCameraFar.value = camera.far;

    if (!mesh) return;

    const previousTarget = state.gl.getRenderTarget();

    // The postprocessing EffectComposer flips renderer.autoClear to false and
    // leaves it there. Without an explicit clear the refraction FBO ACCUMULATES
    // every frame: the fish smear into an unreadable haze and every poi drags a
    // ghost trail across the tank. Both passes therefore clear explicitly and
    // never rely on autoClear being any particular value.
    const previousAutoClear = state.gl.autoClear;
    state.gl.autoClear = false;

    // Pass 1 — everything under the water, captured for refraction.
    mesh.visible = false;
    state.gl.setRenderTarget(fbo);
    state.gl.clear(true, true, false);
    state.gl.render(state.scene, state.camera);
    state.gl.setRenderTarget(previousTarget);
    mesh.visible = true;

    // Pass 2 — the real frame, water included (skipped when a composer presents).
    if (renderScene) {
      state.gl.clear(true, true, false);
      state.gl.render(state.scene, state.camera);
    }

    state.gl.autoClear = previousAutoClear;
  }, 1);

  return (
    <mesh
      ref={meshRef}
      geometry={geometry}
      material={material}
      position={[0, TANK.surfaceY, 0]}
      // The plane spans the whole tank and the camera always looks at it; culling its
      // displaced bounds would only risk popping at the edges of the frame.
      frustumCulled={false}
      renderOrder={10}
    />
  );
}
