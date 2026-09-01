'use client';

/**
 * Stall lighting (spec §64).
 *
 * The whole look rests on one contrast: a warm 3000K bulb hanging over the tub,
 * and a cool blue-green bounce coming up out of the water. Ambient is kept very
 * low — it is a summer night, the tank is supposed to be the brightest thing on
 * the projector, and flat fill light is exactly what makes a scene look like
 * teaching material.
 *
 * Exactly ONE light casts shadows (§77). The lanterns contribute real point
 * lights, but they come from '<Lanterns />' so they sway and flicker in sync
 * with their bodies; set 'lanterns' here only if the lantern meshes are not in
 * the scene and you still want their contribution.
 */

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';

import { TANK } from '@/game/core/constants';
import { LANTERN_COLORS, LANTERN_POSITIONS } from '@/game/environment/Lanterns';

export type LightingQuality = 'low' | 'medium' | 'high';

export interface FestivalLightingProps {
  /**
   * Shadow budget. 'true'/'false' are accepted so 'settings.highQuality' can be
   * passed straight through.
   */
  quality?: LightingQuality | boolean;
  /**
   * Add standalone point lights at 'LANTERN_POSITIONS'. Leave off when
   * '<Lanterns />' is in the scene — it already provides them.
   */
  lanterns?: boolean;
}

const normaliseQuality = (q: LightingQuality | boolean | undefined): LightingQuality => {
  if (q === true || q === undefined) return 'high';
  if (q === false) return 'low';
  return q;
};

const SHADOW_MAP_SIZE: Record<LightingQuality, number> = {
  low: 512,
  medium: 1024,
  high: 2048,
};

/** Where the warm stall bulb hangs. Kept just behind the near rim, slightly off
 *  centre so the poi cast readable shadows instead of sitting on their own. */
const KEY_POSITION: readonly [number, number, number] = [0.9, 7.4, 3.0];
const KEY_TARGET: readonly [number, number, number] = [0, -0.4, -0.3];

export function FestivalLighting({ quality, lanterns = false }: FestivalLightingProps = {}) {
  const q = normaliseQuality(quality);
  const spotRef = useRef<THREE.SpotLight>(null);
  const targetRef = useRef<THREE.Object3D>(null);
  const coolRef = useRef<THREE.DirectionalLight>(null);
  const coolTargetRef = useRef<THREE.Object3D>(null);
  const warmRef = useRef<THREE.DirectionalLight>(null);
  const warmTargetRef = useRef<THREE.Object3D>(null);

  const mapSize = SHADOW_MAP_SIZE[q];

  useEffect(() => {
    // Directional and spot lights aim at their 'target' object, which has to be
    // part of the scene graph — R3F does not wire that up for us.
    if (spotRef.current && targetRef.current) spotRef.current.target = targetRef.current;
    if (coolRef.current && coolTargetRef.current) coolRef.current.target = coolTargetRef.current;
    if (warmRef.current && warmTargetRef.current) warmRef.current.target = warmTargetRef.current;
  }, []);

  useEffect(() => {
    // 'mapSize' is baked into the render target when it is first allocated, so
    // a quality change has to throw the old map away.
    const spot = spotRef.current;
    if (!spot) return;
    if (spot.shadow.map) {
      spot.shadow.map.dispose();
      spot.shadow.map = null;
    }
    spot.shadow.mapSize.set(mapSize, mapSize);
    spot.shadow.needsUpdate = true;
  }, [mapSize]);

  // Only ever recomputed when the flag flips.
  const lanternLights = useMemo(
    () =>
      lanterns
        ? LANTERN_POSITIONS.map((p, i) => ({ p, color: LANTERN_COLORS[i], key: `lantern-fill-${i}` }))
        : [],
    [lanterns],
  );

  return (
    <group name="festival-lighting">
      {/* Summer night: almost nothing, and what there is leans cold. */}
      <ambientLight color="#242e46" intensity={0.20} />

      {/* The §64 contrast in a single cheap light: warm from the stall roof,
          cool green-blue from the water below. */}
      <hemisphereLight color="#ffb877" groundColor="#124a52" intensity={0.34} />

      {/* -------------------------------------------------- warm key (shadows) */}
      <object3D ref={targetRef} position={[KEY_TARGET[0], KEY_TARGET[1], KEY_TARGET[2]]} />
      <spotLight
        ref={spotRef}
        position={[KEY_POSITION[0], KEY_POSITION[1], KEY_POSITION[2]]}
        color="#ffd29c"
        intensity={155}
        angle={0.66}
        penumbra={0.62}
        decay={1.15}
        distance={24}
        castShadow
        shadow-mapSize-width={mapSize}
        shadow-mapSize-height={mapSize}
        shadow-bias={-0.0006}
        shadow-normalBias={0.022}
        shadow-radius={4}
        shadow-camera-near={2.5}
        shadow-camera-far={18}
        shadow-focus={1}
      />

      {/* Warm fill from the front of the stall — lifts the near rim and the
          players' poi out of the dark without flattening the key. */}
      <object3D ref={warmTargetRef} position={[0, 0, 0]} />
      <directionalLight
        ref={warmRef}
        position={[3.0, 4.2, 7.5]}
        color="#ffb478"
        intensity={0.42}
      />

      {/* Blue-green fill from below the water. Aimed straight up so it rims the
          underside of the poi, the fish and the wooden tub. */}
      <object3D ref={coolTargetRef} position={[0, TANK.surfaceY, 0]} />
      <directionalLight
        ref={coolRef}
        position={[0, TANK.floorY - 3.5, 0]}
        color="#35c0ae"
        intensity={0.68}
      />

      {/* A cold rim from behind the stall so silhouettes separate from the night. */}
      <directionalLight position={[-8.5, 2.4, -10.5]} color="#4b7fb8" intensity={0.26} />

      {/* Optional — only when the lantern meshes are not in the scene. */}
      {lanternLights.map(({ p, color, key }) => (
        <pointLight
          key={key}
          position={[p[0], p[1], p[2]]}
          color={color}
          intensity={6.0}
          distance={11}
          decay={1.7}
        />
      ))}
    </group>
  );
}
