'use client';

/**
 * Caustics projected onto the tank floor (spec §63, §64).
 *
 * A single additive plane sitting just above the gravel. The pattern is generated in the
 * shader from animated voronoi networks and — the part that matters — is displaced by the
 * ripple field's gradient, so the bright lines really do slide with the waves overhead
 * instead of running their own unrelated animation.
 */

import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';

import { TANK } from '@/game/core/constants';
import { normalizeQuality, type WaterQuality } from '@/rendering/materials/waterMaterial';
import { CAUSTICS_FRAG, CAUSTICS_VERT } from '@/rendering/shaders/caustics.glsl';

import { tankFloorHeight } from './Underwater';

/**
 * The projection plane rides the gravel dunes rather than cutting through them, so this
 * is a small constant offset above the bed — just enough to win the depth test.
 */
const HEIGHT_ABOVE_FLOOR = 0.03;

/** Enough segments to follow the dunes; the plane is otherwise almost free to draw. */
const SEGMENTS: Record<WaterQuality, [number, number]> = {
  high: [110, 66],
  low: [48, 30],
};

export interface CausticsProps {
  /** 'RippleField.texture' — a stable reference, safe to hold as a prop. */
  rippleTexture: THREE.Texture | null;
  /** Accepts 'RoomSettings.highQuality' directly. Defaults to high. */
  quality?: WaterQuality | boolean;
  /** Overall brightness of the projected light. */
  intensity?: number;
}

export function Caustics({ rippleTexture, quality, intensity = 0.95 }: CausticsProps) {
  const level = normalizeQuality(quality);
  const high = level === 'high';

  const geometry = useMemo(() => {
    const [wSeg, dSeg] = SEGMENTS[level];
    const g = new THREE.PlaneGeometry(TANK.width, TANK.depth, wSeg, dSeg);
    g.rotateX(-Math.PI / 2);
    // Follow the gravel bed exactly. A flat plane would be swallowed by the taller
    // dunes and the caustics would show flat-bottomed holes where the bed rises.
    const position = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < position.count; i++) {
      position.setY(i, tankFloorHeight(position.getX(i), position.getZ(i)));
    }
    position.needsUpdate = true;
    g.computeBoundingSphere();
    return g;
  }, [level]);

  // Only 'high' belongs in the deps: it is the one input that changes a #define and so
  // forces a shader recompile. Everything else is pushed in as a uniform.
  const material = useMemo(() => {
    const m = new THREE.ShaderMaterial({
      vertexShader: CAUSTICS_VERT,
      fragmentShader: CAUSTICS_FRAG,
      defines: high ? { CAUSTICS_QUALITY_HIGH: '' } : {},
      transparent: true,
      blending: THREE.AdditiveBlending,
      // Pure added light: it must not occlude the gravel, the stones or the fish.
      depthWrite: false,
      depthTest: true,
      side: THREE.FrontSide,
      uniforms: {
        uTime: { value: 0 },
        uRipple: { value: null },
        uTankSize: { value: new THREE.Vector2(TANK.width, TANK.depth) },
        uIntensity: { value: 1 },
        /** Voronoi cells per world unit — 2.2 gives ~45cm caustic cells. */
        uScale: { value: 2.2 },
        /** How far a unit of surface slope drags the focus across the floor. */
        uRippleWarp: { value: 5.0 },
        uWarmColor: { value: new THREE.Color('#ffb066') },
        uCoolColor: { value: new THREE.Color('#5fe3cf') },
        uQuality: { value: high ? 1 : 0.4 },
        uDispersion: { value: high ? 0.022 : 0 },
      },
    });
    m.name = 'CausticsMaterial';
    return m;
  }, [high]);

  useEffect(() => {
    material.uniforms.uIntensity.value = intensity;
  }, [material, intensity]);

  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);

  useFrame((state) => {
    material.uniforms.uTime.value = state.clock.elapsedTime;
    material.uniforms.uRipple.value = rippleTexture;
  });

  return (
    <mesh
      geometry={geometry}
      material={material}
      position={[0, TANK.floorY + HEIGHT_ABOVE_FLOOR, 0]}
      frustumCulled={false}
      renderOrder={-1}
    />
  );
}
